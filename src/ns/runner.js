'use strict';

// Runs NS scenarios and returns one result per scenario: { id, title, kind, status, checks, ... }.
// Modes mirror the bot commands:
//   web          `web ns <программа> <категория> <количество>`   one purchase (cases.webCase), always issued
//   web-negative `web ns ошибки`                                  form validation scenarios, never issue
//   api          `api ns`                                         calculator boundaries + issuance straight through the API

const { chromium } = require('playwright');
const { NsFlow, FlowError, BASE_URL, parseMoney, countLabel } = require('./flow');
const {
  check, unverified, eq, byRule, isEnglish, statusOf, premiumChecks, contractChecks, cardChecks, integrationChecks, anomalyChecks,
  insuredChecks, expectedEnd, tomorrowIso,
} = require('./checks');
const { pollProcess, contractById, waitEsbd, sportCodeMap, runCalcCase, calcSummaryChecks, runIssueCase } = require('./api');
const journal = require('./journal');
const { negativeCases, calcCases, issueApiCases, client, ROLE_CODES, withBadChecksum } = require('./cases');

const cardUrl = (policyId) => `${BASE_URL}/policies/${policyId}`;

// Everything a purchase scenario promises — drives the form, the pre-issue guard and the checks
function expectationsOf(c) {
  const term = c.term || '12 месяцев';
  const startDate = term === 'Произвольный' ? null : tomorrowIso();
  return {
    variant: c.variant || 'standard',
    contractType: c.contractType || 'adult',
    count: c.count || 1,
    amountValue: c.amountValue,
    term,
    startDate,
    endDate: startDate ? expectedEnd(startDate, term) : null,
    holderIin: client.iin,
    holderBirthDate: client.person.born_date,
    insuredIins: [...(c.holderInsured === false ? [] : [client.iin]), ...(c.insureds || []).map((p) => p.iin)],
    sportCodes: c.sportCodes,
    phone: client.phone,
    email: client.email,
  };
}

// Sport: insured N on the form (holder first when insured) gets roles[N-1]
function withRoles(exp, c) {
  if (c.variant !== 'sport') return exp;
  const codes = (c.roles || ['Спортсмен']).map((r) => ROLE_CODES[r]);
  return {
    ...exp,
    professions: codes,
    professionsByIin: Object.fromEntries(exp.insuredIins.map((iin, i) => [iin, codes[i] || codes[0]])),
  };
}

// What the form holds vs the scenario — any mismatch stops it before anything is issued
function step1Checks(exp, s1) {
  const req = s1.previewRequest || {};
  const out = [
    eq('Перед выпуском: программа (по запросу калькулятора)', s1.previewVariant, exp.variant, { axis: 'issue' }),
    eq('Перед выпуском: категория выбрана', s1.categoryChecked, 'true', { axis: 'issue' }),
    eq('Перед выпуском: категория (по запросу калькулятора)', req.contract_type, exp.contractType, { axis: 'issue' }),
    eq('Перед выпуском: количество застрахованных', s1.count, countLabel(exp.count), { axis: 'issue' }),
    eq('Перед выпуском: страховая сумма', parseMoney(s1.amount), exp.amountValue, { axis: 'issue' }),
    eq('Перед выпуском: сумма в запросе калькулятора', req.insurance_amount_per_insured, exp.amountValue, { axis: 'issue' }),
    eq('Перед выпуском: срок', s1.term, exp.term, { axis: 'issue' }),
  ];
  if (exp.startDate) {
    out.push(eq('Перед выпуском: дата начала = завтра', s1.startDate, exp.startDate, { axis: 'issue' }));
    out.push(eq('Перед выпуском: дата окончания', s1.endDate, exp.endDate, { axis: 'issue' }));
  }
  if (s1.banner) out.push(check('Шаг 1 без ошибок расчёта', false, 'нет ошибки', s1.banner, { axis: 'issue' }));
  return out;
}

function step3Checks(exp, s3) {
  const out = [];
  if (exp.startDate) {
    out.push(eq('Шаг 3: дата начала', s3.startDate, exp.startDate, { axis: 'issue' }));
    out.push(eq('Шаг 3: дата окончания', s3.endDate, exp.endDate, { axis: 'issue' }));
  }
  const insured = s3.participants.filter((l, i) => /^Застрахованный \d+$/.test(s3.participants[i - 1] || ''));
  out.push(eq('Шаг 3: кол-во застрахованных', insured.length, exp.insuredIins.length, { axis: 'issue' }));
  out.push(eq('Шаг 3: страхователь указан', s3.participants.includes('Страхователь') ? 'да' : null, 'да', { axis: 'issue', missing: 'нет блока «Страхователь»' }));
  return out;
}

const blocking = (checks) => checks.some((k) => k.axis === 'issue' && k.ok !== true);

// A purchase through the site: pays cash and verifies the result
async function runPurchase(flow, c) {
  const exp = withRoles(expectationsOf(c), c);
  const checks = [];
  const out = {};

  const step1 = await flow.selectParams({ ...c, ...exp, amount: c.amount });
  checks.push(...step1Checks(exp, step1));
  if (blocking(checks)) return { checks, out: { notIssuedReason: 'параметры на шаге 1 не совпали с заданными — выписка не запускалась' } };

  if (!(await flow.buy())) throw new FlowError('step1', '«Купить» не перевела на шаг 2');
  if (!(await flow.fillContacts(client.phone, client.email)).passed) throw new FlowError('contacts', 'контакты не приняты');

  const holder = await flow.setHolder(client.iin, { insured: c.holderInsured !== false });
  if (holder.lookup === 'kdp_unavailable') throw new FlowError('holder', 'сервис ГБД/КДП недоступен (kdp 5xx после 3 попыток)');
  if (holder.lookup === 'no_reaction') throw new FlowError('holder', `форма не отреагировала на ИИН ${client.iin} за 60 с`);
  if (holder.lookup !== 'found') throw new FlowError('holder', `клиент ${client.iin} не найден в ГБД`);
  if (holder.esbdErrors) checks.push(check('ЕСБД сохраняет клиента с первого раза', false, '0 повторов', `${holder.esbdErrors} повтора`, { severity: 'note', axis: 'anomaly' }));
  if (!holder.ok) throw new FlowError('holder', holder.error);

  for (const person of c.insureds || []) {
    let ins;
    try {
      ins = await flow.addInsured(person);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      ins = await flow.addInsured(person, { addSlot: true });
    }
    if (ins.esbdErrors) checks.push(check('ЕСБД сохраняет застрахованного с первого раза', false, '0 повторов', `${ins.esbdErrors} повтора`, { severity: 'note', axis: 'anomaly' }));
    if (ins.ok === false || (ins.manual && !ins.manual.ok)) {
      throw new FlowError('insured', `застрахованный ${person.iin} не добавлен: ${(ins.manual && ins.manual.error) || ins.error || ins.lookup}`);
    }
  }

  if (!(await flow.toStep3())) {
    checks.push(check('Переход на шаг 3', false, 'шаг 3', (await flow.bannerErrors()) || 'остались на шаге 2', { axis: 'issue' }));
    return { checks, out: { notIssuedReason: 'форма не перешла на шаг 3' } };
  }
  const step3 = await flow.readStep3();
  checks.push(...step3Checks(exp, step3));
  if (blocking(checks)) return { checks, out: { notIssuedReason: 'итог на шаге 3 не совпал с заданным — выписка не запускалась' } };
  const preview = flow.monitor.lastPreview();
  checks.push(...insuredChecks({ exp, preview }));

  const anketa = await flow.printAnketa();
  checks.push(check('Анкета сформирована и скачана', anketa.ok, 'PDF', anketa.ok ? `${anketa.fileName}, ${Math.round(anketa.size / 1024)} KB` : anketa.error));
  if (anketa.ok) {
    checks.push(check('Анкета — это PDF', anketa.isPdf, '%PDF', anketa.isPdf ? 'PDF' : 'не PDF'));
    checks.push(check('«Выписать» заблокирована до скачивания анкеты', !anketa.issueEnabledBefore, 'заблокирована', anketa.issueEnabledBefore ? 'активна' : 'заблокирована', 'note'));
    checks.push(check('«Выписать» активна после скачивания анкеты', anketa.issueEnabledAfter, 'активна', anketa.issueEnabledAfter ? 'активна' : 'заблокирована', { axis: 'issue' }));
  } else {
    checks.push(check('Без анкеты «Выписать полис» недоступна', !anketa.issueEnabledWithoutAnketa, 'заблокирована', anketa.issueEnabledWithoutAnketa ? 'активна — полис можно выписать без анкеты' : 'заблокирована'));
    if (!anketa.issueEnabledWithoutAnketa) return { checks, out: { notIssuedReason: 'анкета не сформировалась, выписка недоступна' } };
  }

  const payment = await flow.openPayment();
  checks.push(check('Доступна оплата наличными', payment.options.includes('Наличный расчёт'), 'Наличный расчёт', payment.options.join(', '), { axis: 'issue' }));

  // ---- issuance: journal first, then the guarded request
  const entry = await journal.begin({ caseId: c.id, channel: 'web', iin: client.iin, expectsIssue: true });
  flow.journalId = entry.id; // survives an exception, so the report knows a request may have left
  const expectBody = {
    variant: exp.variant, contract_type: exp.contractType, insurance_amount: exp.amountValue,
    start_at: exp.startDate || undefined, end_at: exp.endDate || undefined, holderIin: exp.holderIin, insuredIins: exp.insuredIins,
    sport_types: exp.variant === 'sport' ? exp.sportCodes : undefined, professionsByIin: exp.professionsByIin,
  };
  const { processId } = await flow.issueCash({ expectBody, journal, journalEntry: entry });
  out.processId = processId;

  flow.monitor.step('contract-api');
  const proc = await pollProcess(processId);
  out.statusHistory = proc.history.join(' → ');
  if (!proc.final) {
    checks.push(unverified('Выписка завершена (NDP)', 'completed', `процесс не завершился за 2 мин (${out.statusHistory}); итог выяснится по журналу`, 'issue'));
    return { checks, out };
  }
  const st = proc.last;
  await journal.resolve(entry, { status: st.Status, contractNumber: st.ContractNumber, policyId: st.ID, exact: true });
  checks.push(eq('Выписка завершена (NDP)', st.Status, 'completed', { axis: 'issue' }));
  if (st.Status !== 'completed') return { checks, out };
  checks.push(eq('Оплата отмечена (CheckoutStatus)', st.CheckoutStatus, 'paid', { axis: 'issue' }));
  Object.assign(out, { contractNumber: st.ContractNumber, policyId: st.ID, cardUrl: cardUrl(st.ID) });
  exp.contractNumber = st.ContractNumber;

  // ESBD answers within seconds; when it has already refused, the certificate window will not close — don't wait for it
  const esbdList = await waitEsbd(st.ContractNumber, 20000);
  const esbd = esbdList && esbdList.find((i) => i.system === 'esbd');
  const certUi = esbd && esbd.status === 'failed' ? { skipped: true } : await flow.waitCertificateUi(esbd && esbd.status === 'success' ? 30000 : 10000);
  const shots = [];
  if ((esbd && esbd.status !== 'success') || (certUi && certUi.done === false)) {
    const image = await flow.certificateDialogShot();
    if (image) shots.push({ image, kind: 'certificate', axis: 'integration' });
  }

  const contract = await contractById(st.ID, st.ContractNumber);
  checks.push(...contractChecks({ exp, contract }));
  const card = await flow.openCard(st.ID);
  out.card = card;
  checks.push(...cardChecks({ exp, card }));
  checks.push(...premiumChecks({ c: exp, preview, step1, step3, payment, contract, card }));
  checks.push(...integrationChecks({ list: esbdList, contract, certUi }));
  if (card) shots.push(...(await cardShot(flow, checks)));
  out.shots = shots;
  return { checks, out };
}

// Card check -> where it is on the policy page: a row (section + label) or a stray text
const POLICY = 'Данные по страховому полису';
const PAYOUTS = 'Страховые выплаты';
const HOLDER = 'Данные по страхователю';
const INSURED = 'Данные о застрахованных';
const CARD_FIELDS = {
  'Карточка: номер договора': { section: POLICY, label: 'Номер полиса' },
  'Карточка: статус «ОФОРМЛЕН»': { section: POLICY, label: 'Текущий статус' },
  'Карточка: программа': { section: POLICY, label: 'Программа страхования' },
  'Карточка: начало срока': { section: POLICY, label: 'Начало срока действия' },
  'Карточка: окончание срока': { section: POLICY, label: 'Окончание срока действия' },
  'Карточка: страховая сумма': { section: PAYOUTS, label: 'Страховая сумма' },
  'Карточка: страховая премия = калькулятор': { section: PAYOUTS, label: 'Страховая премия в тенге (₸)' },
  'Карточка: ИИН страхователя': { section: HOLDER, label: 'ИИН / БИН' },
  'Карточка: страхователь — дата рождения': { section: HOLDER, label: 'Дата рождения' },
  'Карточка: страхователь — номер документа': { section: HOLDER, label: 'Документ' },
  'Карточка: ИИН застрахованных': { section: INSURED, label: 'ИИН' },
  'Карточка: застрахованный — полное имя': { section: INSURED, label: 'Полное имя' },
  'Карточка: застрахованный — номер документа': { section: INSURED, label: 'Документ' },
  'Карточка: у застрахованного нет лишнего «0»': { section: INSURED, text: '0' },
};

// The card with its wrong fields outlined in red; nothing when the card is right
async function cardShot(flow, checks) {
  const wrong = checks.filter((k) => k.ok === false && CARD_FIELDS[k.name]);
  if (!wrong.length) return [];
  await flow.markFields(wrong.map((k) => CARD_FIELDS[k.name]));
  const image = await flow.screenshot();
  return image ? [{ image, kind: 'card', checks: wrong.map((k) => k.name) }] : [];
}

async function runUiCase(browser, c) {
  const flow = new NsFlow(browser);
  const result = { id: c.id, title: c.title, kind: c.kind, tags: c.tags, checks: [] };
  // what was bought, for the report: «Стандарт», 2 взрослых, 1 500 000 ₸, 6 месяцев …
  if (c.kind === 'issue') {
    const { variant, contractType, count, amount, term, sportTypes, roles } = c;
    result.purchase = { variant, contractType, count, amount, term, sportTypes, roles };
  }
  try {
    await flow.open();
    if (c.kind === 'negative') {
      result.checks = await negatives[c.id](flow, c, client);
    } else {
      const { checks, out } = await runPurchase(flow, c);
      result.checks = checks;
      Object.assign(result, out);
    }
  } catch (e) {
    if (String(e.message).startsWith('NS_TEST_CRASH_AFTER_SUBMIT')) throw e;
    result.error = e instanceof FlowError ? e.message : `${e.name}: ${e.message.split('\n')[0]}`;
    if (flow.journalId && !(e instanceof FlowError && e.step === 'pre-issue')) result.journalId = flow.journalId;
  }
  if (flow.monitor) result.checks.push(...anomalyChecks(flow.monitor.finish()));
  result.status = statusOf(result.checks, result.error);
  if (result.status !== 'pass' && flow.page && !(result.shots && result.shots.length)) result.screenshot = await flow.screenshot();
  await flow.close();
  return result;
}

// ---------- form validation scenarios (`web ns ошибки`): each returns checks, none ever issues ----------

async function toContacts(flow, c) {
  await flow.selectParams(c);
  if (!(await flow.buy())) throw new FlowError('step1', '«Купить» не перевела на шаг 2');
}

async function toHolder(flow, c, client) {
  await toContacts(flow, c);
  const r = await flow.fillContacts(client.phone, client.email);
  if (!r.passed) throw new FlowError('contacts', 'валидные контакты не приняты');
}

// Text directly under the "ИИН страхователя" input: a hint/error, or the next field label if none
async function iinHint(flow) {
  const t = await flow.text();
  const lines = (t.split('ИИН страхователя')[1] || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return lines[0] && !/^(Будет в списке|Принадлежность)/.test(lines[0]) ? lines[0] : null;
}

async function badIin(flow, c, client, iin) {
  await toHolder(flow, c, client);
  const input = flow.page.locator('input[placeholder="Введите ИИН"]').first();
  const outcome = await flow.lookupIin(input, iin, 12000);
  const hint = await iinHint(flow);
  return [
    check('Клиент по невалидному ИИН не загружен', outcome !== 'found', 'не найден', outcome),
    byRule('iin-error-hint', 'Под полем ИИН показана ошибка', !!hint && !/загружены/.test(hint), 'сообщение об ошибке', hint || '(нет сообщения)'),
  ];
}

const negatives = {
  async N01(flow, c) {
    await flow.selectParams(c);
    const passed = await flow.buy();
    const t = await flow.text();
    return [
      byRule('amount-dictionary', 'Без суммы нельзя перейти на шаг 2', !passed, 'остаёмся на шаге 1', passed ? 'перешли на шаг 2' : 'шаг 1'),
      check('Показана подсказка «Выберите страховую сумму»', t.includes('Выберите страховую сумму'), 'подсказка', t.includes('Выберите страховую сумму') ? 'есть' : 'нет', 'note'),
    ];
  },

  async N02(flow, c) {
    await toContacts(flow, c);
    const r = await flow.fillContacts('', '');
    return [byRule('contacts-required', 'Пустые телефон и email не пропускаются', !r.passed, 'остаёмся на контактах', r.passed ? `пропустило дальше («${r.text}»)` : 'заблокировано')];
  },

  async N03(flow, c) {
    await toContacts(flow, c);
    const r = await flow.fillContacts('123', 'not-an-email');
    return [byRule('contacts-valid', 'Телефон «123» и email «not-an-email» не пропускаются', !r.passed, 'остаёмся на контактах', r.passed ? `пропустило дальше («${r.text}»)` : 'заблокировано')];
  },

  async N04(flow, c, client) {
    return badIin(flow, c, client, withBadChecksum(client.iin));
  },

  async N05(flow, c, client) {
    return badIin(flow, c, client, '12345');
  },

  async N06(flow, c, client) {
    flow.monitor.expectHttp(422, /\/preview/);
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const reached = await flow.toStep3();
    const banner = await flow.bannerErrors();
    return [
      byRule('age-children', 'Взрослый не проходит застрахованным в «Дети»', !reached, 'блокировка на шаге 2', reached ? 'дошли до шага 3' : 'заблокировано'),
      check('Ошибка возраста показана пользователю', !!banner, 'сообщение', banner || '(нет)', 'note'),
      byRule('errors-russian', 'Ошибка возраста на русском языке', !isEnglish(banner), 'русский текст', banner || '(нет)'),
    ];
  },

  async N07(flow, c, client) {
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const ins = await flow.addInsured({ iin: client.iin });
    const names = await flow.insuredNames();
    const reached = ins.ok !== false ? await flow.toStep3() : false;
    const participants = reached ? (await flow.readStep3()).participants.join(' | ') : null;
    return [
      byRule('no-duplicate-insured', 'Один ИИН нельзя добавить застрахованным дважды', !reached, 'блокировка', reached ? `дошли до шага 3: ${participants}` : `заблокировано (${ins.error || 'на шаге 2'})`),
      byRule('no-duplicate-insured', 'Список застрахованных без дублей', new Set(names).size === names.length, 'уникальные', names.join(', ')),
    ];
  },

  async N08(flow, c, client) {
    flow.monitor.expectHttp(422, /\/preview/);
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const person = c.insureds[0];
    const ins = await flow.addInsured(person);
    if (ins.lookup === 'no_reaction') throw new FlowError('insured', 'форма не отреагировала на ИИН застрахованного');
    const reached = ins.ok !== false ? await flow.toStep3() : false;
    const banner = await flow.bannerErrors();
    return [
      byRule('age-adult', `Застрахованный ${person.birthDate} (17 лет) не проходит во «Взрослые»`, !reached, 'блокировка', reached ? 'дошли до шага 3' : `заблокировано (${ins.error || banner || 'шаг 2'})`),
    ];
  },

  // The manual form has no Latin name fields, yet the backend needs them for a passport
  async N09(flow, c, client) {
    await toHolder(flow, c, client);
    const h = await flow.setHolder(client.iin, { insured: true });
    if (h.lookup !== 'found' || !h.ok) throw new FlowError('holder', `страхователь не подтверждён: ${h.error || h.lookup}`);
    const ins = await flow.addInsured(c.insureds[0]);
    if (ins.lookup !== 'not_found') throw new FlowError('insured', `ожидали ручной ввод, а ГБД ответила: ${ins.lookup}`);
    const m = ins.manual || {};
    const saved = m.ok === true;
    return [
      byRule('manual-passport', 'Клиента с паспортом можно сохранить вручную', saved, 'сохранён', saved ? 'сохранён' : m.error),
      byRule('errors-russian', 'Ошибка ручного ввода на русском', saved || !isEnglish(m.error), 'русский текст', m.error || '—'),
      check('Выбран тип документа «Паспорт»', m.docType === 'Паспорт', 'Паспорт', m.docType || '(не выбран)', 'note'),
    ];
  },
};

// Journal entries written before expectsIssue existed: look the case up; web purchases always issue
function expectsIssueOf(entry) {
  if (typeof entry.expectsIssue === 'boolean') return entry.expectsIssue;
  const api = issueApiCases.find((c) => c.id === entry.caseId);
  return api ? api.expect === 'issue' : true;
}

// Before anything is issued: settle the attempts that a crash or timeout left open.
// A corrupt journal file blocks every issuance ('*'); any other open attempt blocks its own case —
// negative cases too, because the bug under test may let such a request issue a policy.
// channel: only this run's attempts ('web' | 'api'; none = all); a corrupt file always counts.
// Any open web attempt blocks the web purchase (WEB) whatever its parameters were.
async function recoverJournal({ channel } = {}) {
  const open = (await journal.pending()).filter((e) => !channel || e.state === 'corrupt' || e.channel === channel);
  if (!open.length) return { row: null, blocked: new Set() };
  const checks = [];
  const blocked = new Set();
  for (const entry of open) {
    const r = await journal.recover(entry).catch((e) => ({ entry, known: false, note: e.message }));
    const when = String(entry.createdAt || '').slice(0, 16).replace('T', ' ');
    const label = entry.state === 'corrupt' ? `Файл журнала ${entry.id}` : `Прошлая заявка ${entry.caseId} от ${when} (${entry.channel})`;
    const release = `снять вручную: ${entry.channel || channel || 'api'} ns снять ${entry.id}`;
    if (r.known) {
      const o = r.outcome;
      const what = o.contractNumber ? `${o.status}, договор ${o.contractNumber}` : o.status;
      checks.push(!expectsIssueOf(entry) && o.status === 'completed'
        ? check(`${label}: негативная заявка всё-таки выписала полис`, false, 'отказ', what, { axis: 'ui' })
        : check(label, true, 'итог известен', what, { axis: 'issue' }));
    } else if (entry.state === 'corrupt') {
      blocked.add('*');
      checks.push(check(label, null, 'читаемая запись', `${r.note}; все выписки остановлены — ${release}`, { axis: 'issue' }));
    } else {
      const web = entry.channel === 'web';
      blocked.add(web ? 'WEB' : entry.caseId);
      const stopped = web ? 'новая выписка через сайт не выполняется' : `новый запуск ${entry.caseId} не выполняется`;
      checks.push(check(label, null, 'итог известен', `${r.note}; ${stopped} — ${release}`, { axis: 'issue' }));
    }
  }
  const row = { id: 'R--', title: 'Незавершённые заявки прошлых запусков', kind: 'recovery', checks };
  row.status = statusOf(checks);
  return { row, blocked };
}

function pickCases(mode, webCase) {
  if (mode === 'web' && !webCase) throw new Error('web: не задан сценарий покупки');
  return {
    ui: mode === 'web' ? [webCase] : mode === 'web-negative' ? negativeCases : [],
    calc: mode === 'api' ? calcCases : [],
    issueApi: mode === 'api' ? issueApiCases : [],
  };
}

async function runSuite({ mode, webCase = null, onProgress = async () => {} } = {}) {
  const { ui, calc, issueApi } = pickCases(mode, webCase);
  const issue = ui.some((c) => c.kind === 'issue');
  const results = [];
  const total = ui.length + calc.length + issueApi.length;
  let done = 0;

  // Nothing is issued before the journal has been settled
  let blocked = new Set();
  if (issue || issueApi.length) {
    await onProgress({ done, total, current: 'проверяю незавершённые заявки прошлых запусков' });
    const rec = await recoverJournal({ channel: issue ? 'web' : 'api' });
    if (rec.row) results.push(rec.row);
    blocked = rec.blocked;
  }
  const skipBlocked = (c) => {
    if (!blocked.has(c.id) && !blocked.has('*')) return false;
    const why = blocked.has('*') ? 'журнал заявок повреждён' : c.id === 'WEB' ? 'прошлая выписка через сайт ещё не завершилась' : 'прошлая заявка этого сценария ещё не завершилась';
    results.push({ id: c.id, title: c.title, kind: c.kind, expect: c.expect, checks: [], status: 'error', error: `${why} — новый запуск не выполнялся, чтобы не создать лишний полис (см. R--)` });
    done++;
    return true;
  };

  if (calc.length) {
    await onProgress({ done, total, current: `калькулятор: ${calc.length} проверок` });
    const calcResults = [];
    for (const c of calc) {
      const r = await runCalcCase(c).catch((e) => ({ id: c.id, title: c.title, kind: 'api', checks: [], error: e.message }));
      r.status = statusOf(r.checks, r.error);
      calcResults.push(r);
      done++;
    }
    const summary = { id: 'A--', title: 'Калькулятор: общие наблюдения', kind: 'api', checks: calcSummaryChecks(calcResults) };
    summary.status = statusOf(summary.checks);
    results.push(...calcResults, summary);
  }

  for (const c of issueApi) {
    if (skipBlocked(c)) continue;
    await onProgress({ done, total, current: `${c.id} ${c.title}` });
    const r = await runIssueCase(c);
    if (r.policyId) r.cardUrl = cardUrl(r.policyId);
    r.status = statusOf(r.checks, r.error);
    results.push(r);
    done++;
  }

  // Blocked purchases are reported without starting a browser at all
  const runnableUi = ui.filter((c) => !(c.kind === 'issue' && issue && skipBlocked(c)));
  if (runnableUi.length) {
    const codes = await sportCodeMap().catch(() => ({}));
    const cases = runnableUi.map((c) => ({
      ...c,
      amountValue: parseMoney(c.amount),
      sportCodes: c.sportTypes && c.sportTypes.map((s) => codes[s] || s),
    }));
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      for (const c of cases) {
        await onProgress({ done, total, current: `${c.id} ${c.title}` });
        results.push(await runUiCase(browser, c));
        done++;
      }
    } finally {
      await browser.close();
    }
  }
  return results;
}

module.exports = { CARD_FIELDS, runSuite, recoverJournal, expectsIssueOf, journal, negativeCases, calcCases, issueApiCases };
