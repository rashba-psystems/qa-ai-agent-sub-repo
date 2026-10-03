'use strict';

// What an МСТ purchase is:
//   web mst [туризм|спорт|студенты|деловые] [0-3|4-74|75+] [1–5]
//   web mst premium [туризм|спорт|деловые] [0-3|4-74|75+] [1–5]
// Country, amount (from the country's zone), trip dates and — for sport — sport type and level are picked by the bot.
// Tourists other than the GBD test person are made up: passports need Latin names.

const { apiRequest } = require('../ndp/client');
const { BASE } = require('../insurance/api');
const { addDays, tomorrowIso } = require('../insurance/checks');
const { generateIin, birthDateForAge } = require('../insurance/purchase');

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
  return {
    iin: generateIin(birthDate, female ? 'female' : 'male', serial),
    birthDate,
    gender: female ? 'female' : 'male',
    lastName: female ? 'ТЕСТОВА' : 'ТЕСТОВ',
    firstName: CYRILLIC[i],
    lastNameLatin: female ? 'TESTOVA' : 'TESTOV',
    firstNameLatin: LATIN[i],
    docNumber: `N${String(10000000 + (serial * 7919) % 89999999).slice(0, 8)}`,
    docDate: addDays(tomorrowIso(), -31), // a month-old passport is valid for every age
  };
}

// The holder (the GBD test person, 44) is a tourist only in the 4-74 group; otherwise every tourist is made up
function touristsFor(ageCode, count) {
  const own = ageCode === 'adult' ? 1 : 0;
  return Array.from({ length: count - own }, (_, i) => tourist(ageCode, i + own));
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

module.exports = { parseMstArgs, mstCase, mstDictionaries, touristsLabel, ruDate, MAX_TOURISTS };
