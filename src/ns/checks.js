'use strict';

// NS checks: rules from the requirements (fixtures/ns.json → requirements), tariffs, the contract, the calculation,
// and NS_KIT — what an NS purchase expects and checks. The check model and shared checks: src/insurance/checks.js.

const { check, unverified, eq, cardChecks, expectedEnd, tomorrowIso } = require('../insurance/checks');
const { parseMoney } = require('../insurance/flow');
const { ROLE_CODES, countLabel } = require('./cases');
const { client } = require('../insurance/purchase');
const { tariffs, requirements: { rules } } = require('../../fixtures/ns.json');

// A check that enforces a rule from fixtures/ns.json → requirements: a bug only if the rule is confirmed
function byRule(ruleId, name, ok, expected, actual, axis = 'ui') {
  const r = rules[ruleId];
  if (!r) throw new Error(`Нет правила ${ruleId} в fixtures/ns.json → requirements`);
  return check(name, ok, expected, actual, { axis, rule: ruleId, severity: r.confirmed ? 'bug' : 'note', unconfirmed: !r.confirmed });
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

// The shared card checks + NS's program and total amount (amount × insured)
function nsCardChecks({ exp, card }) {
  const out = cardChecks({ exp, card });
  if (!card) return out;
  out.push(eq('Карточка: программа', card.program, exp.variant === 'sport' ? 'Спорт' : 'Стандарт'));
  out.push(eq('Карточка: страховая сумма', card.amount, exp.amountValue * exp.insuredIins.length, { missing: 'в карточке нет страховой суммы' }));
  return out;
}

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

// A purchase through the site: pays cash and verifies the result
// The issuance request must be exactly what was asked — any mismatch and it is not sent
// What the browser is about to send vs what the scenario asked for. Returns a list of mismatches.
function compareIssueBody(body, exp) {
  if (!body) return ['тело запроса не прочитано'];
  const out = [];
  const same = (name, got, want) => { if (want !== undefined && got !== want) out.push(`${name}: ${got} ≠ ${want}`); };
  same('variant', body.variant, exp.variant);
  same('contract_type', body.contract_type, exp.contract_type);
  same('insurance_amount', body.insurance_amount, exp.insurance_amount);
  same('start_at', body.start_at, exp.start_at);
  same('end_at', body.end_at, exp.end_at);
  same('payment_method', body.payment_method, 'cash');
  same('policyholder.iin', body.policyholder && body.policyholder.iin, exp.holderIin);
  const got = (body.insureds || []).map((i) => i.iin).sort().join(',');
  const want = [...(exp.insuredIins || [])].sort().join(',');
  if (exp.insuredIins && got !== want) out.push(`insureds: ${got} ≠ ${want}`);
  if (exp.sport_types) {
    const gotSports = [...(body.sport_types || [])].sort().join(',');
    const wantSports = [...exp.sport_types].sort().join(',');
    if (gotSports !== wantSports) out.push(`sport_types: ${gotSports || '—'} ≠ ${wantSports}`);
  }
  if (exp.professionsByIin) {
    for (const i of body.insureds || []) {
      const want = exp.professionsByIin[i.iin];
      if (want && i.profession !== want) out.push(`profession ${i.iin}: ${i.profession || '—'} ≠ ${want}`);
    }
  }
  return out;
}

// What an NS purchase expects and checks — the shared purchase (src/insurance/purchase.js → runPurchase) uses it
const NS_KIT = {
  product: 'ns',
  expectations: (c) => withRoles(expectationsOf(c), c),
  fillStep1: (flow, c, exp) => flow.selectParams({ ...c, ...exp, amount: c.amount }),
  step1Checks,
  step3Checks,
  beforeIssueChecks: ({ exp, preview }) => insuredChecks({ exp, preview }),
  expectBody: (exp) => ({
    variant: exp.variant, contract_type: exp.contractType, insurance_amount: exp.amountValue,
    start_at: exp.startDate || undefined, end_at: exp.endDate || undefined, holderIin: exp.holderIin, insuredIins: exp.insuredIins,
    sport_types: exp.variant === 'sport' ? exp.sportCodes : undefined, professionsByIin: exp.professionsByIin,
  }),
  compare: compareIssueBody,
  resultChecks: ({ exp, contract, card, preview, step1, step3, payment }) => [
    ...contractChecks({ exp, contract }),
    ...nsCardChecks({ exp, card }),
    ...premiumChecks({ c: exp, preview, step1, step3, payment, contract, card }),
  ],
};

module.exports = { byRule, refusalChecks, premiumChecks, contractChecks, insuredChecks, compareIssueBody, NS_KIT };
