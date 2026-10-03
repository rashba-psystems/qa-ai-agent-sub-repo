'use strict';

// One purchase through the site, the same for every product: fill the form, guard and send the issuance request,
// follow the process to the contract, check contract, card and ESBD, take the screenshots.
// What a product expects and checks comes in as a «kit» (src/<product>/checks.js).
// Also here: the issuance journal check before a run, and IIN generation for made-up people.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { FlowError, BASE_URL } = require('./flow');
const { check, unverified, eq, statusOf, integrationChecks, anomalyChecks } = require('./checks');
const { pollProcess, contractById, waitEsbd } = require('./api');
const journal = require('./journal');
const { client, child } = require('../../fixtures/insurance.json');

// The test child's passport scan (fixtures/insurance.json → child.document_file), or null when it is not on this machine
function childDocument() {
  const file = child.document_file && path.resolve(__dirname, '../..', child.document_file);
  return file && fs.existsSync(file) ? file : null;
}

const cardUrl = (policyId) => `${BASE_URL}/policies/${policyId}`;

const blocking = (checks) => checks.some((k) => k.axis === 'issue' && k.ok !== true);
// What stopped the purchase, in words: «Калькулятор посчитал цену — калькулятор ответил 503»
function stopReason(checks, step) {
  const k = checks.find((x) => x.axis === 'issue' && x.ok !== true);
  const what = k.ok === null ? `${k.name} — ${String(k.actual).replace(/^не удалось проверить: /, '')}` : `${k.name}: ожидалось ${k.expected}, а на деле ${k.actual}`;
  return `${step}: ${what} — выписка не запускалась`;
}

// A person entered from a document scan: the site's recognition, field by field. The bot has already put the
// right values in and gone on; each recognition error is still reported (a birth/issue date swap as one error).
function recognitionChecks(person, ins) {
  if (!person.documentFile || !ins.manual) return [];
  const m = ins.manual;
  if (!m.ocrMismatches) return [check('Документ распознан сайтом', false, 'поля заполнены по скану', m.via || 'нет', { severity: 'note' })];
  if (!m.ocrMismatches.length) return [check('Распознавание документа: все поля верны', true, 'как в документе', 'как в документе')];
  const out = [];
  const list = [...m.ocrMismatches];
  const birth = list.find((w) => w.field === 'дата рождения');
  const issue = list.find((w) => w.field === 'дата выдачи');
  if (birth && issue && birth.got === issue.want && issue.got === birth.want) {
    out.push(check('Распознавание документа: перепутаны дата рождения и дата выдачи', false,
      `рождение ${birth.want}, выдача ${issue.want}`, `рождение ${birth.got}, выдача ${issue.got}`));
    list.splice(list.indexOf(birth), 1);
    list.splice(list.indexOf(issue), 1);
  }
  for (const w of list) out.push(check(`Распознавание документа: ${w.field}`, false, w.want, w.got));
  return out;
}

// A purchase through the site: pays cash and verifies the result.
// kit — what the product expects and checks (src/ns/checks.js → NS_KIT, src/mst/checks.js → MST_KIT):
//   { product, expectations(c), fillStep1(flow, c, exp), step1Checks, step3Checks, beforeIssueChecks, expectBody(exp),
//     compare(body, expectBody), resultChecks({ exp, contract, card, preview, step1, step3, payment, st }) }
async function runPurchase(flow, c, kit) {
  const exp = kit.expectations(c);
  const checks = [];
  const out = {};

  const step1 = await kit.fillStep1(flow, c, exp);
  checks.push(...kit.step1Checks(exp, step1));
  if (blocking(checks)) return { checks, out: { notIssuedReason: stopReason(checks, 'шаг 1') } };

  if (!(await flow.buy())) throw new FlowError('step1', '«Купить» не перевела на шаг 2');
  if (!(await flow.fillContacts(client.phone, client.email)).passed) throw new FlowError('contacts', 'контакты не приняты');

  const holder = await flow.setHolder(client.iin, { insured: c.holderInsured !== false });
  if (holder.lookup === 'kdp_unavailable') throw new FlowError('holder', 'сервис ГБД/КДП недоступен (kdp 5xx после 3 попыток)');
  if (holder.lookup === 'no_reaction') throw new FlowError('holder', `форма не отреагировала на ИИН ${client.iin} за 60 с`);
  if (holder.lookup !== 'found') throw new FlowError('holder', `клиент ${client.iin} не найден в ГБД`);
  if (holder.esbdErrors) checks.push(check('ЕСБД сохраняет клиента с первого раза', false, '0 повторов', `${holder.esbdErrors} повтора`, { severity: 'note', axis: 'anomaly' }));
  if (!holder.ok) throw new FlowError('holder', holder.error);

  const addOne = async (person) => {
    try {
      return await flow.addInsured(person);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      return flow.addInsured(person, { addSlot: true });
    }
  };
  const failed = (ins) => ins.ok === false || (ins.manual && !ins.manual.ok);
  const why = (ins) => (ins.manual && ins.manual.error) || ins.error || ins.lookup;
  for (const [idx, original] of (c.insureds || []).entries()) {
    let person = original;
    const marks = { http: flow.monitor.httpErrors.length, console: flow.monitor.consoleErrors.length };
    let ins = await addOne(person);
    checks.push(...recognitionChecks(person, ins));
    // the test child is in ESBD but not in GBD: if the site cannot save her, that is the finding — a made-up
    // person takes her place so the purchase still goes on
    if (failed(ins) && person.fallback) {
      checks.push(check('Человек из ЕСБД, которого нет в ГБД, сохраняется на сайте', false, 'сохранён', `${person.iin}: ${why(ins)}`));
      // the failed saves of this attempt are this finding, not stand noise
      const noise = (s) => /kdp\/save|status of 503/.test(s);
      flow.monitor.httpErrors.splice(marks.http, Infinity, ...flow.monitor.httpErrors.slice(marks.http).filter((e) => !noise(e.url)));
      flow.monitor.consoleErrors.splice(marks.console, Infinity, ...flow.monitor.consoleErrors.slice(marks.console).filter((e) => !noise(e)));
      await flow.abandonPerson(person.iin);
      person = person.fallback;
      c.insureds[idx] = person;
      Object.assign(exp, kit.expectations(c));
      ins = await addOne(person);
      checks.push(...recognitionChecks(person, ins));
    }
    if (ins.esbdErrors) checks.push(check('ЕСБД сохраняет застрахованного с первого раза', false, '0 повторов', `${ins.esbdErrors} повтора`, { severity: 'note', axis: 'anomaly' }));
    if (failed(ins)) throw new FlowError('insured', `застрахованный ${person.iin} не добавлен: ${why(ins)}`);
  }

  if (!(await flow.toStep3())) {
    checks.push(check('Переход на шаг 3', false, 'шаг 3', (await flow.bannerErrors()) || 'остались на шаге 2', { axis: 'issue' }));
    return { checks, out: { notIssuedReason: 'форма не перешла на шаг 3' } };
  }
  const step3 = await flow.readStep3();
  checks.push(...kit.step3Checks(exp, step3));
  if (blocking(checks)) return { checks, out: { notIssuedReason: stopReason(checks, 'шаг 3') } };
  const preview = flow.monitor.lastPreview();
  checks.push(...kit.beforeIssueChecks({ exp, preview, step1, step3 }));

  const anketa = await flow.printAnketa();
  if (anketa.blocked) {
    checks.push(check('Сайт даёт выписать полис', false, 'кнопка «Выписать» активна', anketa.blocked, { severity: 'note', axis: 'issue' }));
    return { checks, out: { notIssuedReason: `сайт не даёт выписать полис: ${anketa.blocked}` } };
  }
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
  const entry = await journal.begin({ caseId: c.id, channel: 'web', product: kit.product, iin: client.iin, expectsIssue: true });
  flow.journalId = entry.id; // survives an exception, so the report knows a request may have left
  const { processId } = await flow.issueCash({ expectBody: kit.expectBody(exp), journal, journalEntry: entry, compare: kit.compare });
  out.processId = processId;

  flow.monitor.step('contract-api');
  const proc = await pollProcess(processId, kit.product);
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
  out.contractNumber = st.ContractNumber;
  exp.contractNumber = st.ContractNumber;
  exp.processPremium = st.TotalPremium;

  // ESBD answers within seconds; when it has already refused, the certificate window will not close — don't wait for it
  const esbdList = await waitEsbd(st.ContractNumber, 20000);
  const esbd = esbdList && esbdList.find((i) => i.system === 'esbd');
  const certUi = esbd && esbd.status === 'failed' ? { skipped: true } : await flow.waitCertificateUi(esbd && esbd.status === 'success' ? 30000 : 10000);
  const shots = [];
  if ((esbd && esbd.status !== 'success') || (certUi && certUi.done === false)) {
    const image = await flow.certificateDialogShot();
    if (image) shots.push({ image, kind: 'certificate', axis: 'integration' });
  }

  const contract = await contractById(st.ID, st.ContractNumber, kit.product);
  const policyId = st.ID || (contract && contract.policy_id);
  Object.assign(out, { policyId, cardUrl: policyId ? cardUrl(policyId) : null });
  const card = policyId ? await flow.openCard(policyId) : null;
  out.card = card;
  checks.push(...kit.resultChecks({ exp, contract, card, preview, step1, step3, payment, st }));
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
  'Карточка: территория': { section: POLICY, label: 'Территория страхования' },
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

// Before anything is issued: settle the attempts that a crash or timeout left open.
// A corrupt journal file blocks every issuance ('*'); any other open attempt blocks its own case —
// negative cases too, because the bug under test may let such a request issue a policy.
// channel: only this run's attempts ('web' | 'api'; none = all); a corrupt file always counts.
// Any open web attempt blocks the web purchase (WEB) whatever its parameters were.
// product: only that product's attempts (the API suites); none = every product (the site: one purchase at a time)
async function recoverJournal({ channel, product } = {}) {
  const mine = (e) => (!channel || e.channel === channel) && (!product || (e.product || 'ns') === product);
  const open = (await journal.pending()).filter((e) => e.state === 'corrupt' || mine(e));
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
      checks.push(entry.expectsIssue === false && o.status === 'completed'
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

// ---------- running a scenario in the browser ----------

function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

// One scenario on a fresh page: body(flow) -> { checks, out }; adds page errors, the status and a screenshot
async function runScenario(flow, c, body) {
  const result = { id: c.id, title: c.title, kind: c.kind, product: flow.product, tags: c.tags, checks: [] };
  if (c.purchase) result.purchase = c.purchase; // what was bought, said for the report
  try {
    await flow.open();
    const { checks, out } = await body(flow);
    result.checks = checks;
    Object.assign(result, out || {});
  } catch (e) {
    result.error = e instanceof FlowError ? e.message : `${e.name}: ${e.message.split('\n')[0]}`;
    if (flow.journalId && !(e instanceof FlowError && e.step === 'pre-issue')) result.journalId = flow.journalId;
  }
  if (flow.monitor) result.checks.push(...anomalyChecks(flow.monitor.finish()));
  result.status = statusOf(result.checks, result.error);
  if (result.status !== 'pass' && flow.page && !(result.shots && result.shots.length)) result.screenshot = await flow.screenshot();
  await flow.close();
  return result;
}

// `web <product> …`: settle the journal, then one purchase. makeFlow(browser) -> the product's page object
async function runWebPurchase({ c, kit, makeFlow, onProgress = async () => {} }) {
  const results = [];
  await onProgress({ done: 0, total: 1, current: 'проверяю незавершённые заявки прошлых запусков' });
  const rec = await recoverJournal({ channel: 'web' });
  if (rec.row) results.push({ ...rec.row, product: kit.product });
  if (rec.blocked.size) {
    const why = rec.blocked.has('*') ? 'журнал заявок повреждён' : 'прошлая выписка через сайт ещё не завершилась';
    results.push({ id: c.id, title: c.title, kind: c.kind, product: kit.product, purchase: c.purchase, checks: [], status: 'error', error: `${why} — новый запуск не выполнялся, чтобы не создать лишний полис` });
    return results;
  }
  await onProgress({ done: 0, total: 1, current: c.title });
  const browser = await launchBrowser();
  try {
    results.push(await runScenario(makeFlow(browser), c, (flow) => runPurchase(flow, c, kit)));
  } finally {
    await browser.close();
  }
  return results;
}

// ---------- Kazakhstan IIN for made-up people: YYMMDD + century/sex digit + 4-digit serial + check digit ----------

// ---------- Kazakhstan IIN: YYMMDD + century/sex digit + 4-digit serial + check digit ----------

function checkDigit(first11) {
  const d = first11.split('').map(Number);
  let s = d.reduce((acc, x, i) => acc + x * (i + 1), 0) % 11;
  if (s === 10) s = d.reduce((acc, x, i) => acc + x * (((i + 2) % 11) + 1), 0) % 11;
  return s === 10 ? null : s;
}

// birthDate: 'YYYY-MM-DD', gender: 'male' | 'female'
function generateIin(birthDate, gender = 'male', serial = 7000) {
  const [y, m, d] = birthDate.split('-');
  const century = Number(y.slice(0, 2));
  const sexDigit = { 18: [1, 2], 19: [3, 4], 20: [5, 6] }[century][gender === 'male' ? 0 : 1];
  for (let k = serial; k < serial + 100; k++) {
    const base = `${y.slice(2)}${m}${d}${sexDigit}${String(k).padStart(4, '0')}`;
    const c = checkDigit(base);
    if (c !== null) return base + c;
  }
  throw new Error(`Не удалось сгенерировать ИИН для ${birthDate}`);
}

// Birth date for someone who is exactly `years` old today (+ offsetDays to step over a boundary)
function birthDateForAge(years, offsetDays = 0, today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// The first 11 digits of a valid IIN with a deliberately wrong check digit
function withBadChecksum(iin) {
  const wrong = (Number(iin[11]) + 1) % 10;
  return iin.slice(0, 11) + wrong;
}

module.exports = {
  runPurchase, runScenario, runWebPurchase, launchBrowser, recoverJournal, cardUrl, CARD_FIELDS,
  generateIin, birthDateForAge, withBadChecksum, client, child, childDocument,
};
