'use strict';

// МСТ checks: what was asked vs what the form sent, the issuance-request guard, the contract, the card, the price,
// and MST_KIT — what an МСТ purchase expects and checks. The check model and shared checks: src/insurance/checks.js.

const { check, unverified, eq, cardChecks } = require('../insurance/checks');
const { client } = require('../insurance/purchase');

// ---------- the issuance request must be exactly what was asked ----------

function compareMstBody(body, exp) {
  if (!body) return ['тело запроса не прочитано'];
  const out = [];
  const same = (name, got, want) => { if (want !== undefined && String(got) !== String(want)) out.push(`${name}: ${got} ≠ ${want}`); };
  same('variant', body.variant, exp.variant);
  same('country_codes', [...(body.country_codes || [])].sort().join(','), exp.countryCode);
  same('sum_insured', body.sum_insured, exp.sumInsuredId);
  same('start_at', body.start_at, exp.startDate);
  same('end_at', body.end_at, exp.endDate);
  same('purpose', body.purpose, exp.purpose);
  same('insureds_count', body.insureds_count, exp.count);
  same('payment_method', body.payment_method, 'cash');
  same('policyholder.identifier', body.policyholder && body.policyholder.identifier, exp.holderIin);
  const got = (body.insureds || []).map((i) => i.iin).sort().join(',');
  const want = [...exp.insuredIins].sort().join(',');
  if (got !== want) out.push(`insureds: ${got} ≠ ${want}`);
  for (const i of body.insureds || []) {
    if (i.purpose !== undefined && i.purpose !== exp.purpose) out.push(`purpose ${i.iin}: ${i.purpose} ≠ ${exp.purpose}`);
    if (exp.sportCode && i.sport !== undefined && i.sport !== exp.sportCode) out.push(`sport ${i.iin}: ${i.sport} ≠ ${exp.sportCode}`);
  }
  return out;
}

// ---------- checks ----------

const AGE_RANGE = { infant: [0, 3], adult: [4, 74], elder: [75, 120] };

function ageOn(bornIso, onIso) {
  const b = new Date(`${bornIso}T00:00:00Z`);
  const d = new Date(`${onIso}T00:00:00Z`);
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth() || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age--;
  return age;
}

const uniq = (list) => [...new Set(list)].join(',');

function expectations(c) {
  return {
    variant: c.variant,
    countryCode: c.country.value,
    countryLabel: c.country.label,
    sumInsuredId: c.amount.value,
    amountPrice: c.amount.price,
    currency: c.amount.currency,
    startDate: c.startDate,
    endDate: c.endDate,
    purpose: c.purpose,
    ageCode: c.ageCode,
    count: c.count,
    sportCode: c.sport && c.sport.value,
    levelCode: c.level && c.level.value,
    holderIin: client.iin,
    holderBirthDate: client.person.born_date,
    insuredIins: [...(c.holderInsured ? [client.iin] : []), ...c.insureds.map((p) => p.iin)],
  };
}

// What the form sent to the calculator vs what was asked — a mismatch stops the purchase before anything is issued
function step1Checks(exp, s1) {
  const req = s1.request || {};
  const ins = req.insureds || [];
  const out = [
    eq('Перед выпуском: страна', uniq((req.destinations || []).map((d) => d.country_code)), exp.countryCode, { axis: 'issue' }),
    eq('Перед выпуском: страховая сумма', req.sum_insured, exp.sumInsuredId, { axis: 'issue' }),
    eq('Перед выпуском: туристов в расчёте', ins.length, exp.count, { axis: 'issue' }),
    eq('Перед выпуском: цель поездки', uniq(ins.map((i) => i.purpose)), exp.purpose, { axis: 'issue' }),
    eq('Перед выпуском: возрастная группа', uniq(ins.map((i) => i.age_code)), exp.ageCode, { axis: 'issue' }),
    eq('Перед выпуском: даты поездки', req.period && `${req.period.start_at} — ${req.period.end_at}`, `${exp.startDate} — ${exp.endDate}`, { axis: 'issue' }),
  ];
  if (s1.banner) out.push(check('Шаг 1 без ошибок расчёта', false, 'нет ошибки', s1.banner, { axis: 'issue' }));
  out.push(s1.calcStatus === 200
    ? check('Калькулятор посчитал цену', s1.calcTotal > 0, 'больше 0 ₸', s1.calcTotal, { axis: 'issue' })
    : unverified('Калькулятор посчитал цену', 'ответ 200', `калькулятор ответил ${s1.calcStatus || 'не ответил'}`, 'issue'));
  return out;
}

function step3Checks(exp, s3) {
  const tourists = s3.participants.filter((l, i) => /^Застрахованный \d+$/.test(s3.participants[i - 1] || ''));
  return [
    eq('Шаг 3: туристов', tourists.length, exp.count, { axis: 'issue' }),
    eq('Шаг 3: дата начала', s3.startDate, exp.startDate, { axis: 'issue' }),
    eq('Шаг 3: дата окончания', s3.endDate, exp.endDate, { axis: 'issue' }),
    eq('Шаг 3: страхователь указан', s3.participants.includes('Страхователь') ? 'да' : null, 'да', { axis: 'issue', missing: 'нет блока «Страхователь»' }),
  ];
}

// The price must be the same everywhere: calculator, step 1, step 3, payment window, process, contract, card
function premiumChecks({ calc, step1, step3, payment, st, contract, card }) {
  if (!calc) return [unverified('Расчёт премии калькулятором', 'ответ 200', 'калькулятор не вернул цену')];
  const out = [eq('Шаг 1: предварительный расчёт = калькулятор', step1 && step1.premium, calc)];
  if (step3) {
    out.push(eq('Шаг 3: премия = калькулятор', step3.premium, calc, { missing: 'на шаге 3 нет премии' }));
    out.push(eq('Шаг 3: «Итого к оплате» = калькулятор', step3.total, calc, { missing: 'на шаге 3 нет итога' }));
  }
  if (payment) out.push(eq('Окно оплаты: сумма = калькулятор', payment.total, calc));
  if (st) out.push(eq('Премия = калькулятор', st.TotalPremium, calc));
  if (contract) out.push(eq('Договор: total_premium = калькулятор', contract.total_premium, calc));
  if (card) out.push(eq('Карточка: страховая премия = калькулятор', card.premium, calc, { missing: 'в карточке нет премии' }));
  return out;
}

function contractChecks({ exp, contract }) {
  if (!contract) return [unverified('Договор найден в NDP API', exp.contractNumber || 'договор', 'договор не получен из API', 'issue')];
  const d = contract.details || {};
  const ins = Array.isArray(d.insureds) ? d.insureds : [];
  const out = [
    eq('Договор: номер = номеру из процесса выписки', contract.contract_number, exp.contractNumber, { axis: 'issue' }),
    eq('Договор: статус', contract.status, 'completed', { axis: 'issue' }),
    eq('Договор: продукт', contract.product, 'mst'),
    eq('Договор: страна', uniq(d.destinations || []), exp.countryCode),
    eq('Договор: дата окончания', d.ends_at, exp.endDate),
    eq('Договор: способ оплаты', contract.payment_method, 'cash'),
    eq('Договор: кол-во застрахованных', ins.length, exp.count),
    check('Договор: ИИН застрахованных', ins.map((i) => i.iin).sort().join(',') === [...exp.insuredIins].sort().join(','), exp.insuredIins.join(', '), ins.map((i) => i.iin).join(', ')),
    eq('Договор: цель поездки у застрахованных', uniq(ins.map((i) => i.purpose)), exp.purpose),
    eq('Договор: страховая сумма у каждого туриста', uniq(ins.map((i) => `${i.sum_insured_in_currency} ${exp.currency}`)), `${exp.amountPrice} ${exp.currency}`),
  ];
  const [min, max] = AGE_RANGE[exp.ageCode];
  const ages = ins.map((i) => ageOn(i.born_date, exp.startDate));
  out.push(check('Договор: возраст туристов в выбранной группе', ages.length > 0 && ages.every((a) => a >= min && a <= max), `${min}–${max === 120 ? '…' : max}`, ages.join(', ')));
  const zero = ins.filter((i) => !i.sum_insured || !i.premium).length;
  out.push(check('Договор: у застрахованных заполнены сумма и премия', zero === 0, 'не 0', `${zero} из ${ins.length} с нулями`, 'note'));
  if (exp.sportCode) {
    const listed = contract.listInsureds || [];
    out.push(eq('Договор: вид спорта у туристов', uniq(listed.map((i) => i.sport || '—')), exp.sportCode));
    out.push(eq('Договор: уровень спорта у туристов', uniq(listed.map((i) => i.sport_level || '—')), exp.levelCode));
  }
  return out;
}

// The shared card checks + the MST territory (the country, in Russian)
function mstCardChecks({ exp, card }) {
  const base = cardChecks({ exp, card });
  if (!card) return base;
  base.push(check('Карточка: территория', card.territory === exp.countryLabel, exp.countryLabel, card.territory || '—', 'note'));
  return base;
}

const lastCalc = (preview) => (preview && preview.status === 200 && preview.body && preview.body.data ? preview.body.data.total_premium : null);

const MST_KIT = {
  product: 'mst',
  expectations,
  fillStep1: (flow, c) => flow.selectParams(c),
  step1Checks,
  step3Checks,
  beforeIssueChecks: () => [],
  expectBody: (exp) => exp,
  compare: compareMstBody,
  // the reference price is the last calculation before issuing (step 2 recalculates with the real tourists)
  resultChecks: ({ exp, contract, card, preview, step1, step3, payment, st }) => [
    ...contractChecks({ exp, contract }),
    ...mstCardChecks({ exp, card }),
    ...premiumChecks({ calc: lastCalc(preview) || (step1 && step1.calcTotal), step1, step3, payment, st, contract, card }),
  ],
};

module.exports = { MST_KIT, compareMstBody };
