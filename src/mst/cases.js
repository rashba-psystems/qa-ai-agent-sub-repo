'use strict';

// What an МСТ purchase is:
//   web mst [туризм|спорт|студенты|деловые] [0-3|4-74|75+] [1–5]
//   web mst premium [туризм|спорт|деловые] [0-3|4-74|75+] [1–5]
// Country, amount (from the country's zone), trip dates and — for sport — sport type and level are picked by the bot.
// Tourists other than the GBD test person are made up: passports need Latin names.

const { apiRequest } = require('../ndp/client');
const { BASE } = require('../insurance/api');
const { addDays, tomorrowIso } = require('../insurance/checks');
const { generateIin, birthDateForAge, child, childDocument } = require('../insurance/purchase');

const plural = (n, [one, few, many]) => {
  const t = n % 10, h = n % 100;
  return `${n} ${t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many}`;
};

const MAX_TOURISTS = 5;

const PURPOSE_WORDS = {
  туризм: 'tourism', туристическая: 'tourism', гостевые: 'tourism',
  спорт: 'sport',
  студенты: 'student', студент: 'student', учеба: 'student',
  деловые: 'business', деловая: 'business', бизнес: 'business', работа: 'business',
};

const AGE_WORDS = { '0-3': 'infant', '4-74': 'adult', '75+': 'elder', 'старше75': 'elder' };

const SKIP_WORDS = new Set(['поездки', 'поездка', 'лет', 'года']);

// `web mst …` words -> { params, errors }; variant 'standard' | 'premium'
function parseMstArgs(args, variant) {
  const p = { variant, purpose: 'tourism', ageCode: 'adult', count: 1 };
  const errors = [];
  for (const w of args.map((a) => String(a).toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-')).filter(Boolean)) {
    if (PURPOSE_WORDS[w]) p.purpose = PURPOSE_WORDS[w];
    else if (AGE_WORDS[w]) p.ageCode = AGE_WORDS[w];
    else if (/^\d+$/.test(w) && Number(w) >= 1 && Number(w) <= MAX_TOURISTS) p.count = Number(w);
    else if (/^\d+$/.test(w)) errors.push(`«${w}»: туристов может быть от 1 до ${MAX_TOURISTS}`);
    else if (!SKIP_WORDS.has(w)) errors.push(`не понял «${w}»`);
  }
  if (variant === 'premium' && p.purpose === 'student') errors.push('в МСТ Premium нет цели «студенты»');
  return { params: p, errors };
}

// ---------- made-up tourists: passports need Latin names ----------

const LATIN = ['PERVYY', 'VTOROY', 'TRETIY', 'CHETVERTYY', 'PYATYY'];

const CYRILLIC = ['ПЕРВЫЙ', 'ВТОРОЙ', 'ТРЕТИЙ', 'ЧЕТВЕРТЫЙ', 'ПЯТЫЙ'];

const AGES = { infant: [1, 2, 1, 2, 1], adult: [30, 35, 40, 45, 50], elder: [76, 78, 80, 82, 85] };

const SERIAL = { infant: 7850, adult: 7800, elder: 7900 };

function tourist(ageCode, i) {
  const female = i % 2 === 1;
  const birthDate = birthDateForAge(AGES[ageCode][i], i * 15); // distinct birthdays -> distinct IINs
  const serial = SERIAL[ageCode] + i * 7;
  const iin = generateIin(birthDate, female ? 'female' : 'male', serial);
  return {
    iin,
    birthDate,
    gender: female ? 'female' : 'male',
    lastName: female ? 'ТЕСТОВА' : 'ТЕСТОВ',
    firstName: CYRILLIC[i],
    lastNameLatin: female ? 'TESTOVA' : 'TESTOV',
    firstNameLatin: LATIN[i],
    docNumber: `N${iin.slice(-8)}`, // from the IIN: a fixed number would clash in ESBD with yesterday's person (kdp/save 503)
    docDate: addDays(tomorrowIso(), -31), // a month-old passport is valid for every age
  };
}

// The test child from fixtures/insurance.json (9 years — the 4-74 group), as the form fills a tourist
const testChild = () => ({
  iin: child.iin, birthDate: child.born_date, gender: child.gender, lastName: child.last_name, firstName: child.first_name,
  lastNameLatin: child.last_name_eng, firstNameLatin: child.first_name_eng, docNumber: child.document_number, docDate: child.document_date,
  documentFile: childDocument() || undefined, // the scan is attached when it is here; otherwise manual entry
});

// The holder (the GBD test person, 44) is a tourist only in the 4-74 group, with the test child as tourist #2;
// otherwise every tourist is made up
function touristsFor(ageCode, count) {
  if (ageCode !== 'adult') return Array.from({ length: count }, (_, i) => tourist(ageCode, i));
  return [...(count >= 2 ? [{ ...testChild(), fallback: tourist('adult', 1) }] : []), ...Array.from({ length: Math.max(0, count - 2) }, (_, i) => tourist('adult', i + 2))];
}

// ---------- the purchase: what was asked + what the bot picks ----------

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const ruDate = (iso) => iso.split('-').reverse().join('.');

const touristsLabel = (n) => `${n} ${n === 1 ? 'турист' : n < 5 ? 'туриста' : 'туристов'}`;

// dict: mstDictionaries(variant)
function mstCase({ variant, purpose, ageCode, count }, dict) {
  const zones = new Set(dict.amounts.map((a) => a.zone));
  const country = pick(dict.countries.filter((c) => zones.has(c.zone) && c.value !== 'KAZ'));
  const amount = pick(dict.amounts.filter((a) => a.zone === country.zone));
  const startDate = addDays(tomorrowIso(), Math.floor(Math.random() * 14));
  const days = 3 + Math.floor(Math.random() * 28);
  const endDate = addDays(startDate, days - 1);
  const purposeItem = dict.purposes.find((p) => p.value === purpose);
  const ageItem = dict.ages.find((a) => a.value === ageCode);
  let sport = null;
  let level = null;
  if (purpose === 'sport') {
    sport = pick(dict.sportTypes);
    const kids = dict.sportLevels.find((l) => /дети/i.test(l.label));
    level = ageCode === 'infant' && kids ? kids : pick(dict.sportLevels.filter((l) => l !== kids));
  }
  const name = variant === 'premium' ? 'МСТ Premium' : 'МСТ';
  const purposeShort = { tourism: 'туризм', sport: 'спорт', student: 'студенты', business: 'деловая поездка' }[purpose];
  return {
    id: 'WEB',
    product: 'mst',
    kind: 'issue',
    title: `${name}, ${purposeShort}, ${touristsLabel(count)} ${ageItem.label}, ${country.label}, ${amount.label}, ${ruDate(startDate)}–${ruDate(endDate)}`,
    variant,
    purpose,
    purposeLabel: purposeItem.label,
    ageCode,
    ageLabel: ageItem.label,
    count,
    country,
    amount,
    startDate,
    endDate,
    days,
    sport,
    level,
    holderInsured: ageCode === 'adult',
    insureds: touristsFor(ageCode, count),
    purchase: {
      what: `полис ${name} через сайт`,
      lines: [
        `• Цель поездки: ${purposeItem.label}${sport ? ` (${sport.label}, ${level.label.toLowerCase()})` : ''}`,
        `• Туристы: ${plural(count, ['турист', 'туриста', 'туристов'])}, возраст ${ageItem.label}`,
        `• Страна: ${country.label}, сумма ${amount.label}`,
        `• Поездка: ${ruDate(startDate)} – ${ruDate(endDate)} (${plural(days, ['день', 'дня', 'дней'])})`,
      ],
    },
    // known issues that depend on parameters match these (fixtures/ns.json → knownIssues → cases)
    tags: `variant:${variant} purpose:${purpose} age:${ageCode} count:${count} zone:${country.zone}`,
  };
}

// MST (variant 'standard' | 'premium'): what the form offers — countries with their zone, amounts per zone, purposes,
// age groups, sport types and levels
async function mstDictionaries(variant = 'standard') {
  const s = await apiRequest('GET', `${BASE}/mst/schema?variant=${variant}&locale=ru`);
  const d = s.data.dictionaries || {};
  const clean = (list) => (list || []).map((x) => ({ ...x, label: String(x.label).replace(/\s+/g, ' ').trim() }));
  return {
    countries: clean(d.countries), amounts: clean(d.amounts), purposes: clean(d.trip_purposes), ages: clean(d.ages),
    sportTypes: clean(d.sport_types), sportLevels: clean(d.sport_levels),
  };
}

// ---------- `api mst`: calculator boundaries (never issue) ----------
// patch(body, h): h.amount(code) — the first amount of that country's zone in this variant's dictionary,
// h.otherZoneAmount(code) — an amount of another zone, h.standardAmount(code) — from the МСТ (not Premium) dictionary.
// Base request: МСТ, Турция, 8 days from tomorrow, one tourist 4-74, tourism.

const T = (age = 'adult', purpose = 'tourism', extra = {}) => ({ age_code: age, purpose, active_relax: false, covid_19: 0, ...extra });
const SPORT = { sport: 'alpine_skiing', sport_level: 'amateur' };

const calcCases = [
  { id: 'MA01', rule: 'age-groups', title: 'Туризм, 4-74 лет, Турция, 8 дней', expect: 'ok', patch: () => {} },
  { id: 'MA02', rule: 'age-groups', title: 'Возраст 0-3 года', expect: 'ok', patch: (b) => { b.insureds = [T('infant')]; } },
  { id: 'MA03', rule: 'age-groups', title: 'Возраст свыше 75 лет', expect: 'ok', patch: (b) => { b.insureds = [T('elder')]; } },
  { id: 'MA04', rule: 'age-groups', expectError: /age_code/, title: 'Неизвестная возрастная группа', expect: 'reject', patch: (b) => { b.insureds = [T('baby')]; } },
  { id: 'MA05', rule: 'purpose-dictionary', title: 'Цель «Студенты»', expect: 'ok', patch: (b) => { b.insureds = [T('adult', 'student')]; } },
  { id: 'MA06', rule: 'purpose-dictionary', title: 'Цель «Деловые поездки»', expect: 'ok', patch: (b) => { b.insureds = [T('adult', 'business')]; } },
  { id: 'MA07', rule: 'purpose-dictionary', expectError: /purpose/, title: 'Неизвестная цель поездки', expect: 'reject', patch: (b) => { b.insureds = [T('adult', 'vacation')]; } },
  { id: 'MA08', rule: 'sport-required', title: 'Спорт: горные лыжи, любительский', expect: 'ok', patch: (b) => { b.insureds = [T('adult', 'sport', SPORT)]; } },
  { id: 'MA09', rule: 'sport-required', expectError: /sport/i, title: 'Спорт без вида и уровня спорта', expect: 'reject', patch: (b) => { b.insureds = [T('adult', 'sport')]; } },
  { id: 'MA10', rule: 'sport-required', expectError: /sport/i, title: 'Спорт: несуществующий вид спорта', expect: 'reject', patch: (b) => { b.insureds = [T('adult', 'sport', { ...SPORT, sport: 'quidditch' })]; } },
  { id: 'MA11', rule: 'sport-required', expectError: /sport/i, title: 'Спорт: несуществующий уровень спорта', expect: 'reject', patch: (b) => { b.insureds = [T('adult', 'sport', { ...SPORT, sport_level: 'wizard' })]; } },
  { id: 'MA12', rule: 'tourists-min-1', expectError: /insureds/, title: '0 туристов', expect: 'reject', patch: (b) => { b.insureds = []; } },
  { id: 'MA13', rule: 'tourists-max-5', title: '5 туристов (максимум формы)', expect: 'ok', patch: (b) => { b.insureds = Array.from({ length: 5 }, () => T()); } },
  { id: 'MA14', rule: 'tourists-max-5', expectError: /insureds/, title: '6 туристов (больше максимума формы)', expect: 'reject', patch: (b) => { b.insureds = Array.from({ length: 6 }, () => T()); } },
  { id: 'MA15', rule: 'amount-zone', expectError: /sum_insured/, title: 'Сумма из другой зоны (не для Турции)', expect: 'reject', patch: (b, h) => { b.sum_insured = h.otherZoneAmount('TUR').value; } },
  { id: 'MA16', rule: 'amount-dictionary', expectError: /sum_insured/, title: 'Несуществующая сумма', expect: 'reject', patch: (b) => { b.sum_insured = 999; } },
  { id: 'MA17', rule: 'country-dictionary', expectError: /destination|country|sum_insured/, title: 'Несуществующая страна', expect: 'reject', patch: (b) => { b.destinations = [{ country_code: 'XXX' }]; } },
  { id: 'MA18', rule: 'no-home-country', expectError: /destination|country|sum_insured/, title: 'Страна поездки — Казахстан', expect: 'reject', patch: (b) => { b.destinations = [{ country_code: 'KAZ' }]; } },
  { id: 'MA19', rule: 'destinations-required', expectError: /destination/, title: 'Без страны поездки', expect: 'reject', patch: (b) => { b.destinations = []; } },
  { id: 'MA20', rule: 'multi-zone-amount', expectError: /sum_insured|zone/, title: 'Турция и Германия, сумма зоны Турции', expect: 'reject', patch: (b) => { b.destinations = [{ country_code: 'TUR' }, { country_code: 'DEU' }]; } },
  { id: 'MA21', rule: 'start-not-past', expectError: /start/, title: 'Начало поездки в прошлом', expect: 'reject', patch: (b, h) => { b.period = { start_at: addDays(h.start, -10), end_at: addDays(h.start, -3) }; } },
  { id: 'MA22', rule: 'period-consistent', expectError: /end_at|period/, title: 'Окончание раньше начала', expect: 'reject', patch: (b, h) => { b.period = { start_at: addDays(h.start, 10), end_at: addDays(h.start, 5) }; } },
  { id: 'MA23', rule: 'period-max-365', title: 'Поездка 365 дней', expect: 'ok', patch: (b, h) => { b.period = { start_at: h.start, end_at: addDays(h.start, 364) }; } },
  { id: 'MA24', rule: 'period-max-365', expectError: /period|365/, title: 'Поездка 366 дней', expect: 'reject', patch: (b, h) => { b.period = { start_at: h.start, end_at: addDays(h.start, 365) }; } },
  { id: 'MA25', rule: 'tariff-dictionary', expectError: /tariff/, title: 'Неизвестный тариф', expect: 'reject', patch: (b) => { b.tariff = 'gold'; } },
  { id: 'MA26', variant: 'premium', rule: 'purpose-dictionary', title: 'Premium: туризм', expect: 'ok', patch: () => {} },
  { id: 'MA27', variant: 'premium', rule: 'age-groups', title: 'Premium: свыше 75 лет', expect: 'ok', patch: (b) => { b.insureds = [T('elder')]; } },
  { id: 'MA28', variant: 'premium', rule: 'premium-no-student', expectError: /purpose/, title: 'Premium: цель «Студенты»', expect: 'reject', patch: (b) => { b.insureds = [T('adult', 'student')]; } },
  { id: 'MA29', variant: 'premium', rule: 'tourists-max-5', expectError: /insureds/, title: 'Premium: 6 туристов', expect: 'reject', patch: (b) => { b.insureds = Array.from({ length: 6 }, () => T()); } },
  { id: 'MA30', variant: 'premium', rule: 'amount-zone', expectError: /sum_insured/, title: 'Premium: сумма из справочника обычного МСТ', expect: 'reject', patch: (b, h) => { b.sum_insured = h.standardAmount('TUR').value; } },
];

// ---------- `api mst`: issuance straight through the API (every accepted request is a REAL policy) ----------
// Base request: as the site sends it — МСТ, Турция, 8 days, tourism, the test client as the only tourist.
// extra: made-up tourists saved first (kdp/save gives their ESBD client id). patch(body, h) as above.

const issueApiCases = [
  { id: 'MI01', title: 'API: МСТ, туризм, 1 турист, Турция, 8 дней', expect: 'issue' },
  { id: 'MI02', title: 'API: МСТ, спорт (горные лыжи, любительский)', expect: 'issue', purpose: 'sport', sport: SPORT },
  { id: 'MI03', title: 'API: МСТ Premium, туризм', expect: 'issue', variant: 'premium' },
  { id: 'MI04', title: 'API: МСТ, деловая поездка, 2 туриста', expect: 'issue', purpose: 'business', extra: 1 },
  { id: 'MI06', title: 'API: МСТ, туризм, страхователь и ребёнок 9 лет', expect: 'issue', withChild: true },
  { id: 'MI05', title: 'API: подмена премии в запросе игнорируется', expect: 'issue', patch: (b) => Object.assign(b, { total_premium: 1, premium: 1, total_premium_final: 1 }) },
  { id: 'MI11', rule: 'amount-zone', expectError: /sum_insured|zone/, title: 'API: сумма из другой зоны отклоняется', expect: 'reject', patch: (b, h) => { b.sum_insured = h.otherZoneAmount('TUR').value; } },
  { id: 'MI12', rule: 'no-duplicate-insured', expectError: /insured|duplicate|дубл/i, title: 'API: один турист дважды отклоняется', expect: 'reject', patch: (b) => { b.insureds = [b.insureds[0], { ...b.insureds[0] }]; b.insureds_count = 2; } },
  { id: 'MI13', rule: 'insureds-count-match', expectError: /insureds_count/, title: 'API: число туристов не совпадает со списком', expect: 'reject', patch: (b) => { b.insureds_count = 3; } },
  { id: 'MI14', rule: 'start-not-past', expectError: /start/, title: 'API: начало поездки в прошлом отклоняется', expect: 'reject', patch: (b, h) => Object.assign(b, { start_at: addDays(h.start, -10), end_at: addDays(h.start, -3) }) },
  { id: 'MI15', rule: 'purpose-dictionary', expectError: /purpose/, title: 'API: неизвестная цель поездки отклоняется', expect: 'reject', patch: (b) => { b.purpose = 'vacation'; b.insureds.forEach((i) => { i.purpose = 'vacation'; }); } },
  // a student document key is sent too, so that the refusal can only be about the purpose itself
  { id: 'MI16', rule: 'premium-no-student', expectError: /insureds\.\d+\.purpose|purpose: (must|the selected)|selected insureds\.\d+\.purpose/i, title: 'API: Premium со студентами отклоняется', expect: 'reject', variant: 'premium', purpose: 'student', patch: (b) => { b.student_doc_key = 'qa-test-student-document'; } },
  { id: 'MI17', rule: 'payment-dictionary', expectError: /payment/, title: 'API: неизвестный способ оплаты отклоняется', expect: 'reject', patch: (b) => { b.payment_method = 'bitcoin'; } },
  { id: 'MI18', rule: 'tourists-min-1', expectError: /insureds/, title: 'API: без туристов отклоняется', expect: 'reject', patch: (b) => { b.insureds = []; b.insureds_count = 0; } },
];

module.exports = {
  parseMstArgs, mstCase, mstDictionaries, touristsLabel, ruDate, tourist, MAX_TOURISTS, calcCases, issueApiCases,
};
