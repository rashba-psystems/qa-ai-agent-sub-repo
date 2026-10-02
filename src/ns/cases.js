'use strict';

// What the NS tests check.
//   web ns <программа> <категория> <количество> -> one purchase; amount, term, sport types and roles
//     are picked by the bot from the dictionaries, a new combination on every run (shown in the report)
//   negativeCases (`web ns ошибки`): form validation, never issue
//   calcCases + issueApiCases (`api ns`): calculator boundaries and issuance straight through the API —
//     every issuance request the server accepts is a REAL policy

const { addDays } = require('./checks');
const { client } = require('../../fixtures/ns.json');

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

// ---------- made-up people, entered by hand on the form (only one test person exists in GBD) ----------

function syntheticPerson(age, { gender = 'male', lastName = 'ТЕСТОВ', firstName = 'АЛИХАН', offsetDays = 0, serial = 7000 } = {}) {
  const birthDate = birthDateForAge(age, offsetDays);
  return {
    iin: generateIin(birthDate, gender, serial),
    birthDate,
    gender,
    lastName,
    firstName,
    docNumber: String(40000000 + (serial * 7919) % 9999999).padStart(9, '0'),
    docDate: birthDateForAge(Math.min(age, 2)),
    docTypes: ['Свидетельство о рождении', 'Удостоверение личности'],
  };
}

const ADULT_AGES = [30, 35, 40, 45, 50, 55, 60, 25, 28];
const CHILD_AGES = [5, 8, 11, 14, 17, 3, 6, 9, 12, 15];
const ORDINALS = ['ПЕРВЫЙ', 'ВТОРОЙ', 'ТРЕТИЙ', 'ЧЕТВЕРТЫЙ', 'ПЯТЫЙ', 'ШЕСТОЙ', 'СЕДЬМОЙ', 'ВОСЬМОЙ', 'ДЕВЯТЫЙ', 'ДЕСЯТЫЙ'];

// adults: the test client is insured #1, the rest are made up; children: every insured is a made-up child
function extraPeople(contractType, count) {
  const children = contractType === 'children';
  return Array.from({ length: children ? count : count - 1 }, (_, i) => {
    const female = i % 2 === 1;
    return syntheticPerson(children ? CHILD_AGES[i] : ADULT_AGES[i], {
      gender: female ? 'female' : 'male',
      lastName: female ? 'ТЕСТОВА' : 'ТЕСТОВ',
      firstName: ORDINALS[children ? i : i + 1],
      serial: (children ? 7700 : 7500) + i * 7,
    });
  });
}

// ---------- `web ns <программа> <категория> <количество>` ----------

const MAX_INSURED = 10;
const VARIANT = { стандарт: 'standard', standard: 'standard', спорт: 'sport', sport: 'sport' };
const CATEGORY = {
  взрослые: 'adult', взрослый: 'adult', взр: 'adult', adult: 'adult',
  дети: 'children', детский: 'children', ребенок: 'children', children: 'children',
};
// the form's term options; «Произвольный» needs dates typed in and is left out
const TERMS = ['12 месяцев', '6 месяцев', '3 месяца', '1 месяц', '5 дней'];
const ROLES = ['Спортсмен', 'Тренер / судья', 'Параспортсмен'];

// Words in any order, anything not given: Стандарт, взрослые, 1 человек
function parseWebArgs(args) {
  const p = { variant: 'standard', contractType: 'adult', count: 1 };
  const errors = [];
  for (const w of args.map((a) => String(a).toLowerCase().replace(/ё/g, 'е')).filter(Boolean)) {
    if (VARIANT[w]) p.variant = VARIANT[w];
    else if (CATEGORY[w]) p.contractType = CATEGORY[w];
    else if (/^\d+$/.test(w) && Number(w) >= 1 && Number(w) <= MAX_INSURED) p.count = Number(w);
    else if (/^\d+$/.test(w)) errors.push(`«${w}»: застрахованных может быть от 1 до ${MAX_INSURED}`);
    else errors.push(`не понял «${w}»`);
  }
  return { params: p, errors };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
// «спортсмен ×2, тренер / судья» — roles in the order of the list, with counts
const roleSummary = (roles) => ROLES.filter((r) => roles.includes(r))
  .map((r) => { const n = roles.filter((x) => x === r).length; return `${r.toLowerCase()}${n > 1 ? ` ×${n}` : ''}`; }).join(', ');
const pickSome = (list, n) => [...list].sort(() => Math.random() - 0.5).slice(0, n);

// The purchase: what the person asked for + amount, term, sports and roles picked by the bot.
// dict: { amounts: [{ label, value }], sports: [name] } from the NS schema (api.nsDictionaries)
function webCase({ variant, contractType, count }, dict) {
  const sport = variant === 'sport';
  const children = contractType === 'children';
  const amount = pick(dict.amounts);
  const term = pick(TERMS);
  const sportTypes = sport ? pickSome(dict.sports, 1 + Math.floor(Math.random() * 2)) : undefined;
  const roles = sport ? Array.from({ length: count }, () => pick(ROLES)) : undefined;
  const title = [
    sport ? 'Спорт' : 'Стандарт',
    children ? 'дети' : 'взрослые',
    `${count} чел.`,
    sport ? `${sportTypes.join(' + ')}, ${roleSummary(roles)}` : null,
    amount.label.replace(' тг', ' ₸'),
    term,
  ].filter(Boolean).join(', ');

  return {
    id: 'WEB',
    kind: 'issue',
    title,
    variant,
    contractType,
    count,
    amount: amount.label,
    amountValue: amount.value,
    term,
    sportTypes,
    roles,
    holderInsured: !children,
    insureds: extraPeople(contractType, count),
    // known issues that depend on parameters match these (fixtures/ns.json → knownIssues → cases)
    tags: `variant:${variant} category:${contractType} count:${count} amount:${amount.value} term:${term}`,
  };
}

// ---------- catalogue ----------

const base = { variant: 'standard', contractType: 'adult', count: 1, amount: '1 000 000 тг', term: '12 месяцев' };

// Sport roles as the form shows them -> the code the site sends (insureds[].profession)
const ROLE_CODES = { 'Спортсмен': 'athlete', 'Тренер / судья': 'coach_official', 'Параспортсмен': 'para_athlete' };

const negativeCases = [
  { id: 'N01', kind: 'negative', title: '«Купить» без выбранной суммы', ...base, amount: null },
  { id: 'N02', kind: 'negative', title: 'Пустые телефон и email', ...base },
  { id: 'N03', kind: 'negative', title: 'Невалидный телефон и email', ...base },
  { id: 'N04', kind: 'negative', title: 'ИИН с неверной контрольной суммой', ...base },
  { id: 'N05', kind: 'negative', title: 'ИИН из 5 цифр', ...base },
  { id: 'N06', kind: 'negative', title: 'Дети: взрослый 44 лет как застрахованный', ...base, contractType: 'children' },
  { id: 'N07', kind: 'negative', title: 'Дубль: один и тот же ИИН дважды застрахован', ...base, count: 2 },
  { id: 'N08', kind: 'negative', title: 'Взрослые: застрахованный 17 лет', ...base, count: 2, insureds: [syntheticPerson(17, { firstName: 'ПОДРОСТОК', serial: 7300 })] },
  { id: 'N09', kind: 'negative', title: 'Ручной ввод застрахованного с документом «Паспорт»', ...base, count: 2, insureds: [{ ...syntheticPerson(35, { firstName: 'ПАСПОРТ', serial: 7400 }), docTypes: ['Паспорт'] }] },
];

// --- calculator boundaries. expect: 'ok' (200) | 'reject' (4xx naming expectError)
// period dates: '+N' / '-N' = days from today, resolved at runtime
const calcCases = [
  { id: 'A01', rule: 'age-adult', expectError: /age/, title: 'Взрослые: возраст 17', patch: { insureds: [{ age: 17 }] }, expect: 'reject' },
  { id: 'A02', rule: 'age-adult', title: 'Взрослые: возраст 18', patch: { insureds: [{ age: 18 }] }, expect: 'ok' },
  { id: 'A03', rule: 'age-adult', title: 'Взрослые: возраст 65', patch: { insureds: [{ age: 65 }] }, expect: 'ok' },
  { id: 'A04', rule: 'age-adult', expectError: /age/, title: 'Взрослые: возраст 66', patch: { insureds: [{ age: 66 }] }, expect: 'reject' },
  { id: 'A05', rule: 'age-children', expectError: /age/, title: 'Дети: возраст 2', patch: { contract_type: 'children', insureds: [{ age: 2 }] }, expect: 'reject' },
  { id: 'A06', rule: 'age-children', title: 'Дети: возраст 3', patch: { contract_type: 'children', insureds: [{ age: 3 }] }, expect: 'ok' },
  { id: 'A07', rule: 'age-children', title: 'Дети: возраст 17', patch: { contract_type: 'children', insureds: [{ age: 17 }] }, expect: 'ok' },
  { id: 'A08', rule: 'age-children', expectError: /age/, title: 'Дети: возраст 18', patch: { contract_type: 'children', insureds: [{ age: 18 }] }, expect: 'reject' },
  { id: 'A09', rule: 'amount-dictionary', expectError: /insurance_amount/, title: 'Сумма 999 999 (ниже минимума)', patch: { insurance_amount_per_insured: 999999 }, expect: 'reject' },
  { id: 'A10', rule: 'amount-dictionary', expectError: /insurance_amount/, title: 'Сумма 3 600 000 (выше максимума)', patch: { insurance_amount_per_insured: 3600000 }, expect: 'reject' },
  { id: 'A11', rule: 'amount-dictionary', expectError: /insurance_amount/, title: 'Сумма 1 050 000 (не из справочника)', patch: { insurance_amount_per_insured: 1050000 }, expect: 'reject' },
  { id: 'A12', rule: 'insureds-min-1', expectError: /insureds/, title: '0 застрахованных', patch: { insureds: [] }, expect: 'reject' },
  { id: 'A13', rule: 'insureds-max-10', title: '10 застрахованных (максимум в UI)', patch: { insureds: Array(10).fill({ age: 30 }) }, expect: 'ok' },
  { id: 'A14', rule: 'insureds-max-10', expectError: /insureds/, title: '11 застрахованных (больше максимума UI)', patch: { insureds: Array(11).fill({ age: 30 }) }, expect: 'reject' },
  { id: 'A15', rule: 'term-dictionary', expectError: /period_months/, title: 'Срок 13 месяцев', patch: { period_months: 13 }, expect: 'reject' },
  { id: 'A16', rule: 'start-not-past', expectError: /start|period/, title: 'Произвольный период: начало в прошлом', patch: { period_mode: 'custom_dates', period_months: null, period: { start_at: '-30', end_at: '-1' } }, expect: 'reject' },
  { id: 'A17', rule: 'period-consistent', expectError: /end_at|period/, title: 'Произвольный период: окончание раньше начала', patch: { period_mode: 'custom_dates', period_months: null, period: { start_at: '+10', end_at: '+5' } }, expect: 'reject' },
  { id: 'A18', rule: 'custom-period-max', expectError: /period/, title: 'Произвольный период: 400 дней', patch: { period_mode: 'custom_dates', period_months: null, period: { start_at: '+1', end_at: '+400' } }, expect: 'reject' },
  { id: 'A19', rule: 'period-consistent', expectError: /period/, title: '12 месяцев, но даты на 1 месяц', patch: { period_months: 12, period: { start_at: '+1', end_at: '+30' } }, expect: 'reject' },
  { id: 'A20', rule: 'sport-dictionary', expectError: /sport_types/, title: 'Спорт без видов спорта', variant: 'sport', patch: { sport_types: [] }, expect: 'reject' },
  { id: 'A21', rule: 'sport-dictionary', expectError: /sport_types/, title: 'Спорт: несуществующий вид спорта', variant: 'sport', patch: { sport_types: ['quidditch'] }, expect: 'reject' },
  { id: 'A22', rule: 'sport-dictionary', expectError: /profession/, title: 'Спорт: несуществующая роль', variant: 'sport', patch: { insureds: [{ age: 30, profession: 'wizard' }] }, expect: 'reject' },
];

// --- direct POST /ns/policies. expect: 'issue' (must be issued correctly) | 'reject' (for the expectError reason)
// Each accepted request creates a REAL policy on dev — including a negative case the server wrongly accepts.
const issueApiCases = [
  { id: 'I01', title: 'API: Стандарт, взрослый, 1 млн, 12 мес', expect: 'issue' },
  { id: 'I02', title: 'API: Стандарт, 3,5 млн, 5 дней', expect: 'issue', amountValue: 3500000, days: 5 },
  { id: 'I03', title: 'API: Спорт, спортсмен, футбол, 2 млн, 12 мес', expect: 'issue', variant: 'sport', amountValue: 2000000, sportCodes: ['football'] },
  { id: 'I04', title: 'API: подмена премии в запросе игнорируется', expect: 'issue',
    patch: (b) => Object.assign(b, { total_premium: 1, premium: 1, total_premium_final: 1 }) },
  { id: 'I11', rule: 'start-not-past', expectError: /start|period/, title: 'API: период с началом в прошлом отклоняется', expect: 'reject',
    patch: (b, { start }) => Object.assign(b, { period_mode: 'custom_dates', period_months: null, start_at: addDays(start, -31), end_at: addDays(start, -2) }) },
  { id: 'I12', rule: 'no-duplicate-insured', expectError: /insured|duplicate|дубл/i, title: 'API: один ИИН дважды в застрахованных отклоняется', expect: 'reject', insureds: [client.person, client.person] },
  { id: 'I13', rule: 'amount-dictionary', expectError: /insurance_amount/, title: 'API: сумма 1 050 000 (не из справочника) отклоняется', expect: 'reject', amountValue: 1050000 },
  { id: 'I14', rule: 'age-children', expectError: /age/, title: 'API: «Дети» со взрослым застрахованным отклоняется', expect: 'reject', contractType: 'children' },
  { id: 'I15', rule: 'payment-dictionary', expectError: /payment_method/, title: 'API: неизвестный способ оплаты отклоняется', expect: 'reject', patch: (b) => { b.payment_method = 'bitcoin'; } },
  { id: 'I16', rule: 'period-consistent', expectError: /period|end_at/, title: 'API: 12 месяцев, но даты на 1 месяц — отклоняется', expect: 'reject', patch: (b, { start }) => { b.end_at = addDays(start, 29); } },
  { id: 'I17', rule: 'insureds-min-1', expectError: /insureds/, title: 'API: без застрахованных отклоняется', expect: 'reject', patch: (b) => { b.insureds = []; } },
  { id: 'I18', rule: 'holder-iin-required', expectError: /policyholder\.iin/, title: 'API: страхователь без ИИН отклоняется', expect: 'reject', patch: (b) => { delete b.policyholder.iin; } },
];

module.exports = {
  negativeCases, calcCases, issueApiCases, client, ROLE_CODES, MAX_INSURED,
  parseWebArgs, webCase, generateIin, birthDateForAge, withBadChecksum,
};
