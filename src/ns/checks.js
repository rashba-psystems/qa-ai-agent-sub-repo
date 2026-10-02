'use strict';

// Check model — kept deliberately small.
//   ok:       true | false | null   (null = «не удалось проверить»: the data needed was not there)
//   severity: 'bug'  — the system contradicts itself or a CONFIRMED rule
//             'note' — needs a human: suspicion, or a rule that is not confirmed yet
//   axis:     'issue' (was the policy issued) · 'data' (do data match) · 'ui' (form/API behaviour)
//             · 'anomaly' (JS/HTTP errors, slow steps) · 'integration' and 'tariff' (informational only)
//
// Scenario status, from the checks:
//   fail      ❌ — at least one bug
//   attention ❔ — no bugs, but something could not be verified or needs a decision
//   pass      ✅ — everything verified and matching
//   error     🛠 — the scenario could not run to the end (stand or automation)

const { tariffs, requirements: { rules } } = require('../../fixtures/ns.json');

function check(name, ok, expected, actual, opts = {}) {
  if (typeof opts === 'string') opts = { severity: opts };
  if (opts.severity && !['bug', 'note'].includes(opts.severity)) throw new Error(`check «${name}»: severity может быть только bug или note`);
  return {
    name,
    ok: ok === null ? null : !!ok,
    severity: opts.severity || 'bug',
    axis: opts.axis || 'data',
    rule: opts.rule,
    expected,
    actual,
  };
}

function unverified(name, expected, reason, axis = 'data') {
  return check(name, null, expected, `не удалось проверить: ${reason}`, { axis });
}

// A check that enforces a rule from fixtures/ns.json → requirements: a bug only if the rule is confirmed
function byRule(ruleId, name, ok, expected, actual, axis = 'ui') {
  const r = rules[ruleId];
  if (!r) throw new Error(`Нет правила ${ruleId} в fixtures/ns.json → requirements`);
  return check(name, ok, expected, actual, { axis, rule: ruleId, severity: r.confirmed ? 'bug' : 'note' });
}

// Equality; a missing actual value or a missing reference value means «не удалось проверить»
function eq(name, actual, expected, opts = {}) {
  if (expected === undefined || expected === null) return unverified(name, 'эталон', opts.noExpected || 'нет эталонного значения', opts.axis);
  if (actual === undefined || actual === null || actual === '' || actual === '—') {
    return unverified(name, expected, opts.missing || 'значения нет', opts.axis);
  }
  return check(name, actual === expected, expected, actual, opts);
}

// A refusal counts only when it names what the case broke. Otherwise the rule stays unverified.
//   detail — what happened ("422: ..."), reason — the server's error text
function refusalChecks(c, detail, reason) {
  if (c.expectError && !c.expectError.test(reason || '')) {
    return [
      unverified(c.title, 'отказ по правилу', `отказ по другой причине (${detail.slice(0, 180)})`, 'ui'),
      check('Отказ по ожидаемой причине', false, String(c.expectError), (reason || '(без текста)').slice(0, 200), { axis: 'ui' }),
    ];
  }
  return [byRule(c.rule, c.title, true, 'отказ', detail.slice(0, 220), 'ui')];
}

const STATUS_ORDER = ['error', 'fail', 'attention', 'pass'];

// Integration and tariff axes are informational: they never change the status
function statusOf(checks, error) {
  if (error) return 'error';
  const core = checks.filter((c) => !['integration', 'tariff'].includes(c.axis));
  if (core.some((c) => c.ok === false && c.severity === 'bug')) return 'fail';
  if (core.some((c) => c.ok !== true)) return 'attention';
  return 'pass';
}

function worstStatus(statuses) {
  return STATUS_ORDER.find((s) => statuses.includes(s)) || 'pass';
}

// ---------- dates ----------

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Calendar months, clamped to the last day of the target month (31.01 + 1 month = 28.02),
// the same way the NS server computes it (checked against the calc API on dev).
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// '12 месяцев' | '1 месяц' | '5 дней' -> last day of cover for a given start
function expectedEnd(startIso, term) {
  const m = /^(\d+)\s+(месяц|месяца|месяцев|день|дня|дней)$/.exec(term || '12 месяцев');
  if (!m || !startIso) return null;
  const n = Number(m[1]);
  return m[2].startsWith('месяц') ? addDays(addMonths(startIso, n), -1) : addDays(startIso, n - 1);
}

function tomorrowIso() {
  // Kazakhstan is UTC+5; "tomorrow" is the agent's local tomorrow
  const local = new Date(Date.now() + 5 * 3600 * 1000);
  return addDays(local.toISOString().slice(0, 10), 1);
}

// ---------- premium ----------

// The same premium everywhere it appears + the calculator's own arithmetic + tariff (informational)
function premiumChecks({ c, preview, step1, step3, payment, contract, card }) {
  if (!preview) return [unverified('Расчёт премии калькулятором', 'ответ 200', 'калькулятор не вызывался')];
  if (preview.status !== 200 || !preview.body || !preview.body.data) {
    return [unverified('Расчёт премии калькулятором', 'ответ 200', `последний расчёт завершился ошибкой (HTTP ${preview.status || 'нет ответа'})`)];
  }
  const out = [];
  const data = preview.body.data;
  const p = data.total_premium;
  const b = data.premium_breakdown || {};
  const amount = b.insurance_amount_per_insured;
  const period = b.period_tariff;
  const term = c.term || '12 месяцев';
  const details = Array.isArray(b.premium_details) ? b.premium_details : null;

  const expected = details
    ? details.reduce((s, d) => s + amount * (d.main_tariff / 100) * period, 0)
    : amount * (b.main_tariff / 100) * period * b.insureds_count;
  const rounded = Math.round(expected * 100) / 100;
  out.push(check('Премия = сумма × тариф × коэф. срока × кол-во (по разбивке калькулятора)', Math.abs(rounded - p) < 0.01, rounded, p));
  if (c.amountValue) out.push(eq('Сумма в расчёте = заданной', amount, c.amountValue));
  out.push(byRule('premium-integer', 'Премия в целых тенге', Number.isInteger(p), 'целое число', p, 'data'));

  // Tariff: the dev snapshot only detects changes; correctness needs an approved tariff
  const snap = tariffs.snapshot;
  const tariffNow = details ? details[0].main_tariff : b.main_tariff;
  const key = details ? `${details[0].profession}|${[...((preview.request && preview.request.sport_types) || [])].sort().join(',')}` : c.contractType;
  const snapValue = details ? snap.sportMainTariff[key] : snap.standard[c.contractType];
  const tariffOpts = { severity: 'note', axis: 'tariff' };
  if (snapValue != null) out.push(check(`Тариф (${key}) не изменился относительно снимка dev ${tariffs.snapshotDate}`, tariffNow === snapValue, `${snapValue}%`, `${tariffNow}%`, tariffOpts));
  if (snap.periodTariff[term] != null) out.push(check(`Коэф. срока «${term}» не изменился относительно снимка dev`, period === snap.periodTariff[term], snap.periodTariff[term], period, tariffOpts));
  const approved = tariffs.approved;
  const approvedValue = approved && (details ? approved.sportMainTariff && approved.sportMainTariff[key] : approved.standard && approved.standard[c.contractType]);
  out.push(approvedValue != null
    ? check(`Тариф (${key}) соответствует утверждённому`, tariffNow === approvedValue, `${approvedValue}%`, `${tariffNow}%`, { axis: 'tariff' })
    : unverified(`Тариф (${key}) соответствует утверждённому`, 'утверждённый тариф', 'утверждённого тарифа нет (fixtures/ns.json → tariffs.approved)', 'tariff'));

  if (step1) out.push(eq('Шаг 1: предварительный расчёт = калькулятор', step1.premium, p));
  if (step3) {
    out.push(eq('Шаг 3: премия = калькулятор', step3.premium, p, { missing: 'на шаге 3 нет премии' }));
    out.push(eq('Шаг 3: «Итого к оплате» = калькулятор', step3.total, p, { missing: 'на шаге 3 нет итога' }));
    if (c.amountValue) out.push(eq('Шаг 3: страховая сумма = заданная × кол-во застрахованных', step3.amount, c.amountValue * (b.insureds_count || c.count || 1)));
  }
  if (payment) out.push(eq('Окно оплаты: сумма = калькулятор', payment.total, p));
  if (contract) {
    out.push(eq('Договор: total_premium = калькулятор', contract.total_premium, p));
    out.push(eq('Договор: total_premium_final = total_premium', contract.total_premium_final, contract.total_premium));
  }
  if (card) out.push(eq('Карточка: страховая премия = калькулятор', card.premium, p, { missing: 'в карточке нет премии' }));
  return out;
}

// ---------- contract (NDP API) ----------

// exp: { contractNumber, variant, contractType, amountValue, startDate, endDate, holderIin, insuredIins, sportCodes, phone, email }
function contractChecks({ exp, contract }) {
  if (!contract) return [unverified('Договор найден в NDP API', exp.contractNumber || 'договор', 'договор не получен из API', 'issue')];
  const d = contract.details || {};
  const out = [
    eq('Договор: номер = номеру из процесса выписки', contract.contract_number, exp.contractNumber, { axis: 'issue' }),
    eq('Договор: статус', contract.status, 'completed', { axis: 'issue' }),
    eq('Договор: продукт', contract.product, 'ns'),
    eq('Договор: вариант', d.variant, exp.variant),
    eq('Договор: категория', d.contract_type, exp.contractType),
    eq('Договор: страховая сумма', d.insurance_amount, exp.amountValue),
    eq('Договор: способ оплаты', contract.payment_method, 'cash'),
    eq('Договор: дата начала', d.starts_at, exp.startDate),
    eq('Договор: дата окончания', d.ends_at, exp.endDate),
    eq('Договор: ИИН страхователя', contract.policyholder && contract.policyholder.iin, exp.holderIin, { missing: 'в договоре нет ИИН страхователя' }),
  ];
  const insureds = d.insureds || contract.insureds;
  if (!Array.isArray(insureds)) {
    out.push(unverified('Договор: застрахованные', exp.insuredIins.join(', '), 'в договоре нет списка застрахованных'));
  } else {
    out.push(eq('Договор: кол-во застрахованных', insureds.length, exp.insuredIins.length));
    const got = insureds.map((i) => i.iin);
    out.push(got.some((x) => !x)
      ? unverified('Договор: ИИН застрахованных', exp.insuredIins.join(', '), 'у части застрахованных нет ИИН')
      : check('Договор: ИИН застрахованных', [...got].sort().join(',') === [...exp.insuredIins].sort().join(','), exp.insuredIins.join(', '), got.join(', ')));
    const zero = insureds.filter((i) => !i.sum_insured || !i.premium).length;
    out.push(check('Договор: у застрахованных заполнены сумма и премия', zero === 0, 'не 0', `${zero} из ${insureds.length} с нулями`, 'note'));
  }
  if (exp.variant === 'sport') {
    out.push(check('Договор: виды спорта', [...(d.sport_types || [])].sort().join(',') === [...(exp.sportCodes || [])].sort().join(','), (exp.sportCodes || []).join(','), (d.sport_types || []).join(',')));
  }
  if (exp.phone) out.push(eq('Договор: телефон клиента сохранён', contract.delivery_phone && contract.delivery_phone.replace(/\D/g, '').slice(-10), exp.phone, { missing: 'телефона в договоре нет', severity: 'note' }));
  if (exp.email) out.push(eq('Договор: email клиента сохранён', contract.delivery_email, exp.email, { missing: 'email в договоре нет', severity: 'note' }));
  return out;
}

// ---------- contract card in the browser ----------

// The final calculation (after every insured was entered): ages fit the category, one role per insured
function insuredChecks({ exp, preview }) {
  const req = preview && preview.request;
  const name = 'Расчёт: возраст застрахованных подходит категории';
  const [min, max] = exp.contractType === 'children' ? [3, 17] : [18, 65];
  if (!req || !Array.isArray(req.insureds)) return [unverified(name, `${min}–${max}`, 'запрос калькулятора не прочитан', 'data')];
  const ages = req.insureds.map((i) => i.age);
  const out = [eq('Расчёт: застрахованных в расчёте', req.insureds.length, exp.insuredIins.length)];
  out.push(ages.every((a) => Number.isInteger(a))
    ? byRule(exp.contractType === 'children' ? 'age-children' : 'age-adult', name, ages.every((a) => a >= min && a <= max), `${min}–${max}`, ages.join(', '), 'data')
    : unverified(name, `${min}–${max}`, `в запросе нет возраста (${JSON.stringify(req.insureds[0] || {})})`, 'data'));
  if (exp.professions) {
    const sorted = (list) => [...list].sort().join(',');
    out.push(eq('Расчёт: роли застрахованных', sorted(req.insureds.map((i) => i.profession || '—')), sorted(exp.professions)));
  }
  return out;
}

// «Паспорт N12234278» — yes; «Паспорт —» or «—» — no
const hasDocNumber = (v) => /\d/.test(v) && !/—$/.test(v);

// A card row: missing row -> unverified, otherwise compared by `good`
function shownCheck(name, value, expected, good) {
  if (value === undefined) return unverified(name, expected, 'строки нет в карточке', 'data');
  return check(name, good(value), expected, value);
}

function cardChecks({ exp, card }) {
  if (!card) return [unverified('Карточка договора открыта в браузере', exp.contractNumber, 'карточку открыть не удалось', 'issue')];
  return [
    eq('Карточка: номер договора', card.number, exp.contractNumber, { axis: 'issue' }),
    eq('Карточка: статус «ОФОРМЛЕН»', card.status, 'ОФОРМЛЕН', { axis: 'issue' }),
    eq('Карточка: программа', card.program, exp.variant === 'sport' ? 'Спорт' : 'Стандарт'),
    eq('Карточка: начало срока', card.startDate, exp.startDate),
    eq('Карточка: окончание срока', card.endDate, exp.endDate),
    eq('Карточка: страховая сумма', card.amount, exp.amountValue * exp.insuredIins.length, { missing: 'в карточке нет страховой суммы' }),
    card.holderIinShown === '—'
      ? check('Карточка: ИИН страхователя', false, exp.holderIin, '—')
      : eq('Карточка: ИИН страхователя', card.holderIin, exp.holderIin, { missing: 'в карточке нет строки «ИИН / БИН»' }),
    shownCheck('Карточка: страхователь — дата рождения', card.holderBirthShown, exp.holderBirthDate, (v) => v.split('.').reverse().join('-') === exp.holderBirthDate),
    shownCheck('Карточка: страхователь — номер документа', card.holderDocShown, 'тип и номер документа', hasDocNumber),
    shownCheck('Карточка: застрахованный — полное имя', card.insuredNameShown, 'ФИО', (v) => v !== '—'),
    shownCheck('Карточка: застрахованный — номер документа', card.insuredDocShown, 'тип и номер документа', hasDocNumber),
    check('Карточка: у застрахованного нет лишнего «0»', !card.insuredStrayZero, 'нет', card.insuredStrayZero ? 'под ИИН выводится «0»' : 'нет'),
    check('Карточка: ИИН застрахованных', card.insuredIins.length > 0 && [...card.insuredIins].sort().join(',') === [...exp.insuredIins].sort().join(','), exp.insuredIins.join(', '), card.insuredIins.join(', ') || '(нет)'),
  ];
}

// ---------- ESBD integration (informational) ----------

function integrationChecks({ list, contract, certUi }) {
  const out = [];
  const opts = { axis: 'integration', severity: 'note' };
  const esbd = Array.isArray(list) ? list.find((i) => i.system === 'esbd') : null;
  if (!Array.isArray(list)) {
    out.push(check('ЕСБД: результат синхронизации', null, 'success', 'не удалось получить /integrations', opts));
  } else {
    const err = esbd && (esbd.last_error || '').match(/"message":"([^"]+)"/);
    out.push(check('ЕСБД: договор принят', esbd ? esbd.status === 'success' : null, 'success', esbd ? `${esbd.status}${err ? `: ${err[1]}` : ''}` : 'записи о синхронизации нет', opts));
    if (esbd && contract) {
      // The contract must say what ESBD said — never "pending" after a failure
      const ok = esbd.status === 'success' ? contract.integration_status === 'success' : esbd.status === 'failed' ? ['failed', 'error'].includes(contract.integration_status) : null;
      out.push(check('Статус интеграции в договоре соответствует ответу ЕСБД', ok, `как в ЕСБД (${esbd.status})`, contract.integration_status || '(пусто)', opts));
    }
  }
  if (contract) {
    out.push(check('global_id присвоен (без него полис нельзя скачать)', !!contract.global_id, 'global_id', contract.global_id || '(пусто)', opts));
    out.push(check('Ссылка на сертификат (certificate_url)', !!contract.certificate_url, 'ссылка', contract.certificate_url || '(пусто)', opts));
  }
  if (certUi && !certUi.skipped) {
    out.push(check(`Окно «Готовим сертификат…» закрылось за ${Math.round(certUi.limitMs / 1000)} с`, certUi.done, 'закрылось', certUi.done ? `${Math.round(certUi.ms / 1000)} с` : 'висит', opts));
  }
  return out;
}

// ---------- anomalies: one line per distinct problem ----------

function anomalyChecks(anomalies) {
  const opts = { severity: 'note', axis: 'anomaly' };
  const out = [];
  const http = new Map();
  for (const e of anomalies.httpErrors) {
    const key = `${e.status} ${e.method} ${e.url.split('?')[0]}`;
    http.set(key, (http.get(key) || 0) + 1);
  }
  for (const [key, n] of http) out.push(check('Нет ошибок API во время сценария', false, 'без ошибок', `${key}${n > 1 ? ` ×${n}` : ''}`, opts));
  for (const e of [...new Set([...anomalies.pageErrors, ...anomalies.consoleErrors])].slice(0, 5)) {
    out.push(check('Нет JS-ошибок в консоли', false, 'без ошибок', e, opts));
  }
  const slow = anomalies.steps.filter((s) => s.ms > 30000 && !['certificate-ui', 'contract-api'].includes(s.name));
  if (slow.length) out.push(check('Шаги быстрее 30 с', false, '< 30 с', slow.map((s) => `${s.name} ${Math.round(s.ms / 1000)} с`).join(', '), opts));
  return out;
}

const LATIN_ONLY = /^[^А-Яа-яЁё]*[A-Za-z][^А-Яа-яЁё]*$/;
const isEnglish = (s) => !!s && LATIN_ONLY.test(s);

module.exports = {
  insuredChecks,
  check, unverified, byRule, eq, refusalChecks, statusOf, worstStatus,
  premiumChecks, contractChecks, cardChecks, integrationChecks, anomalyChecks,
  expectedEnd, tomorrowIso, isEnglish, addDays, rules,
};
