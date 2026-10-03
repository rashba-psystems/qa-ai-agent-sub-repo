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

function check(name, ok, expected, actual, opts = {}) {
  if (typeof opts === 'string') opts = { severity: opts };
  if (opts.severity && !['bug', 'note'].includes(opts.severity)) throw new Error(`check «${name}»: severity может быть только bug или note`);
  return {
    name,
    ok: ok === null ? null : !!ok,
    severity: opts.severity || 'bug',
    axis: opts.axis || 'data',
    rule: opts.rule,
    unconfirmed: opts.unconfirmed || undefined, // a rule the analyst has not confirmed yet (see src/ns/checks.js → byRule)
    expected,
    actual,
  };
}

function unverified(name, expected, reason, axis = 'data') {
  return check(name, null, expected, `не удалось проверить: ${reason}`, { axis });
}

// Equality; a missing actual value or a missing reference value means «не удалось проверить»
function eq(name, actual, expected, opts = {}) {
  if (expected === undefined || expected === null) return unverified(name, 'эталон', opts.noExpected || 'нет эталонного значения', opts.axis);
  if (actual === undefined || actual === null || actual === '' || actual === '—') {
    return unverified(name, expected, opts.missing || 'значения нет', opts.axis);
  }
  return check(name, actual === expected, expected, actual, opts);
}

// Checks against a product's requirements (fixtures/<product>.json → requirements):
//   byRule — a broken CONFIRMED rule is a bug, an unconfirmed one needs a decision
//   refusalChecks — a refusal counts only when it names what the case broke; otherwise the rule stays unverified
//     (detail — what happened, «422: …»; reason — the server's error text)
function makeRules(rules, file) {
  function byRule(ruleId, name, ok, expected, actual, axis = 'ui') {
    const r = rules[ruleId];
    if (!r) throw new Error(`Нет правила ${ruleId} в ${file}`);
    return check(name, ok, expected, actual, { axis, rule: ruleId, severity: r.confirmed ? 'bug' : 'note', unconfirmed: !r.confirmed });
  }
  function refusalChecks(c, detail, reason) {
    if (c.expectError && !c.expectError.test(reason || '')) {
      return [
        unverified(c.title, 'отказ по правилу', `отказ по другой причине (${detail.slice(0, 180)})`, 'ui'),
        check('Отказ по ожидаемой причине', false, String(c.expectError), (reason || '(без текста)').slice(0, 200), { axis: 'ui' }),
      ];
    }
    return [byRule(c.rule, c.title, true, 'отказ', detail.slice(0, 220), 'ui')];
  }
  return { byRule, refusalChecks };
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

// «Паспорт N12234278» — yes; «Паспорт —» or «—» — no
const hasDocNumber = (v) => /\d/.test(v) && !/—$/.test(v);

// A card row: missing row -> unverified, otherwise compared by `good`
function shownCheck(name, value, expected, good) {
  if (value === undefined) return unverified(name, expected, 'строки нет в карточке', 'data');
  return check(name, good(value), expected, value);
}

// The policy card in «Мои полисы», the part every product shares; products add their own rows (program, amount, territory)
function cardChecks({ exp, card }) {
  if (!card) return [unverified('Карточка договора открыта в браузере', exp.contractNumber, 'карточку открыть не удалось', 'issue')];
  return [
    eq('Карточка: номер договора', card.number, exp.contractNumber, { axis: 'issue' }),
    eq('Карточка: статус «ОФОРМЛЕН»', card.status, 'ОФОРМЛЕН', { axis: 'issue' }),
    eq('Карточка: начало срока', card.startDate, exp.startDate),
    eq('Карточка: окончание срока', card.endDate, exp.endDate),
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
  check, unverified, eq, makeRules, statusOf, worstStatus, addDays, addMonths, expectedEnd, tomorrowIso,
  hasDocNumber, shownCheck, cardChecks, integrationChecks, anomalyChecks, isEnglish,
};
