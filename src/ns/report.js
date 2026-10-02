'use strict';

// Telegram summary for an NS run.
// Problems already reported to the team (fixtures/ns.json → knownIssues) are shown apart from new ones.

const { statusOf, rules } = require('./checks');
const knownIssues = require('../../fixtures/ns.json').knownIssues.issues.map((i) => ({
  ...i,
  match: i.match.map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, ['rule', 'axis'].includes(k) ? v : new RegExp(v)]))),
}));

const ICON = { pass: '✅', fail: '❌', attention: '❔', error: '🛠' };

const fmt = (v) => (v == null || v === '' ? '—' : String(v));

// ---------- known issues ----------

const CHECK_FIELDS = ['check', 'rule', 'axis', 'actual', 'expected'];

// What a known issue's `cases` is matched against: the id plus the purchase parameters (cases.webCase → tags)
const caseKey = (r) => [r.id, r.tags].filter(Boolean).join(' ');

function conditionMatches(m, r, k) {
  if (m.cases && !m.cases.test(caseKey(r))) return false;
  if (!k) return m.error ? m.error.test(r.error || '') : !CHECK_FIELDS.some((f) => m[f]); // whole-scenario conditions
  if (m.error) return false;
  if (m.check && !m.check.test(k.name)) return false;
  if (m.rule && k.rule !== m.rule) return false;
  if (m.axis && k.axis !== m.axis) return false;
  if (m.actual && !m.actual.test(String(k.actual))) return false;
  if (m.expected && !m.expected.test(String(k.expected))) return false;
  return true;
}

const knownFor = (r, k) => (knownIssues.find((i) => i.match.some((m) => conditionMatches(m, r, k))) || {}).id || null;

// Marks every problem with its known-issue id (or null = new) and computes the status of what is new
function annotate(results) {
  for (const r of results) {
    for (const k of r.checks) k.known = k.ok === true ? null : knownFor(r, k);
    r.errorKnown = r.error ? knownFor(r, null) : null;
    const fresh = r.checks.filter((k) => k.ok === true || !k.known);
    r.newStatus = statusOf(fresh, r.error && !r.errorKnown ? r.error : null);
  }
  return results;
}

// Known issues seen in this run, and those that could have shown up but did not (maybe fixed)
function knownSummary(results) {
  const seen = new Map();
  for (const r of results) {
    const ids = new Set([...r.checks.map((k) => k.known), r.errorKnown].filter(Boolean));
    for (const id of ids) seen.set(id, [...(seen.get(id) || []), r.id]);
  }
  const notSeen = knownIssues.filter((i) => !i.intermittent && !seen.has(i.id) && i.match.some((m) => results.some((r) => {
    if (r.status === 'error' || (m.cases && !m.cases.test(caseKey(r)))) return false;
    const identity = ['check', 'rule', 'axis'].filter((f) => m[f]);
    if (!identity.length) return !CHECK_FIELDS.some((f) => m[f]) && !m.error; // whole-scenario condition: the scenario ran
    return r.checks.some((k) => identity.every((f) => (f === 'check' ? m.check.test(k.name) : k[f] === m[f])));
  })));
  return { seen, notSeen };
}

// ---------- plain language: what a check found, said for someone who does not know the system ----------

const isNum = (v) => v !== null && v !== '' && !Number.isNaN(Number(v));
const money = (v) => (isNum(v) ? `${Number(v).toLocaleString('ru-RU').replace(/ /g, ' ')} ₸` : v);
const shown = (v) => (v == null || v === '' || v === '—' || v === '(пусто)' ? 'пусто' : `«${v}»`);
const isoToRu = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v).split('-').reverse().join('.') : v);

// Where a check looked, by the start of its name
const PLACES = [
  [/^Карточка: /, 'В карточке полиса'],
  [/^Договор: /, 'В договоре на сервере'],
  [/^Шаг 1: /, 'На первом шаге формы'],
  [/^Шаг 3: /, 'На последнем шаге формы'],
  [/^Перед выпуском: /, 'Перед выпиской'],
  [/^Расчёт: /, 'В расчёте цены'],
  [/^Окно оплаты: /, 'В окне оплаты'],
];

// Checks that need their own sentence; the rest are said by PLACES + «X вместо Y»
const SAY = [
  [/^Карточка: страховая сумма$/, (k) => `В карточке полиса страховая сумма ${money(k.actual)} вместо ${money(k.expected)}`],
  [/^Карточка: ИИН страхователя$/, (k) => (k.actual === '—' ? 'В карточке полиса у страхователя не указан ИИН' : `В карточке полиса ИИН страхователя ${shown(k.actual)} вместо ${shown(k.expected)}`)],
  [/^Карточка: страхователь — дата рождения$/, () => 'В карточке полиса у страхователя не указана дата рождения'],
  [/^Карточка: страхователь — номер документа$/, (k) => `В карточке полиса у страхователя нет номера документа (написано ${shown(k.actual)})`],
  [/^Карточка: застрахованный — полное имя$/, () => 'В карточке полиса у застрахованного не указаны фамилия и имя'],
  [/^Карточка: застрахованный — номер документа$/, (k) => `В карточке полиса у застрахованного нет номера документа (написано ${shown(k.actual)})`],
  [/^Карточка: у застрахованного нет лишнего «0»$/, () => 'В карточке полиса под ИИН застрахованного выводится лишний «0»'],
  [/^Договор: у застрахованных заполнены сумма и премия$/, (k) => `В договоре у застрахованных сумма и премия равны 0 (${k.actual})`],
  [/= калькулятор$|^Премия = /, (k) => `${placeOf(k.name) || 'Цена'}: ${money(k.actual)}, а калькулятор насчитал ${money(k.expected)}`],
  [/^ЕСБД: договор принят$/, (k) => `Государственная база ЕСБД не приняла полис (ответ: ${String(k.actual).replace(/^failed: /, '')})`],
  [/^global_id присвоен/, () => 'Полис не получил номер в ЕСБД, поэтому его нельзя скачать'],
  [/^Ссылка на сертификат/, () => 'Нет ссылки на сертификат полиса'],
  [/^Статус интеграции в договоре/, (k) => `В договоре статус передачи в ЕСБД ${shown(k.actual)}, хотя ЕСБД уже ответила ${shown(String(k.expected).replace(/^как в ЕСБД \((.*)\)$/, '$1'))}`],
  [/^Окно «Готовим сертификат…»/, (k) => `На сайте бесконечно висит «Готовим сертификат…» (${k.actual})`],
  [/^Нет ошибок API во время сценария$/, (k) => `Во время оформления сервер ответил ошибкой: ${k.actual}`],
  [/^Нет JS-ошибок в консоли$/, (k) => `На странице произошла техническая ошибка: ${k.actual}`],
  [/^Шаги быстрее 30 с$/, (k) => `Оформление тормозит: ${String(k.actual).replace(/(\S+) (\d+) с/g, 'шаг «$1» — $2 с')}`],
  [/^Анкета сформирована и скачана$/, (k) => `Анкета не печатается (${k.actual})`],
  [/^Без анкеты «Выписать полис» недоступна$/, () => 'Полис можно выписать, не распечатав анкету'],
  [/^Выписка завершена \(NDP\)$/, (k) => `Сервер не завершил выписку: статус ${shown(k.actual)}`],
];

function placeOf(name) {
  const p = PLACES.find(([re]) => re.test(name));
  return p ? p[1] : null;
}

// One sentence about a problem a check found (ok === false) or could not check (ok === null).
// A check named like its scenario (API cases) is not named again.
function plain(k, scenarioTitle) {
  const unconfirmed = k.rule && rules[k.rule] && !rules[k.rule].confirmed;
  const reason = String(fmt(k.actual)).replace(/^не удалось проверить: /, '');
  if (k.ok === null) return k.name === scenarioTitle ? `не удалось проверить: ${reason}` : `${k.name} — не удалось проверить: ${reason}`;
  const say = SAY.find(([re]) => re.test(k.name));
  if (say) return say[1](k);
  const place = placeOf(k.name);
  const field = k.name.replace(/^[^:]+: /, '');
  const vals = /сумма|премия|итого/i.test(k.name) ? [money(k.actual), money(k.expected)] : [shown(isoToRu(k.actual)), shown(isoToRu(k.expected))];
  const text = place ? `${place} ${field.toLowerCase()}: ${vals[0]} вместо ${vals[1]}`
    : k.name === scenarioTitle ? `ожидалось ${vals[1]}, а на деле ${vals[0]}` : `${k.name}: ожидалось ${vals[1]}, а на деле ${vals[0]}`;
  return unconfirmed ? `${text} — если это действительно ошибка (правило ещё не подтверждено)` : text;
}

// A crash or stop, said plainly
const STEP_RU = {
  login: 'вход на сайт', step1: 'выбор параметров', contacts: 'ввод телефона и email', holder: 'ввод страхователя',
  insured: 'добавление застрахованных', anketa: 'печать анкеты', payment: 'окно оплаты', 'pre-issue': 'проверка перед выпиской',
  issue: 'выписка', card: 'карточка полиса',
};
function plainError(error) {
  const m = /^\[([\w-]+)\] ([\s\S]*)$/.exec(error || '');
  if (m) return `Автотест остановился на шаге «${STEP_RU[m[1]] || m[1]}»: ${m[2]}`;
  if (/Timeout/i.test(error)) return 'Автотест остановился: сайт не ответил вовремя (возможно, тормозит стенд или изменилась страница)';
  return `Автотест остановился из-за технической ошибки: ${error}`;
}

// ---------- the Telegram message ----------

const plural = (n, [one, few, many]) => {
  const t = n % 10, h = n % 100;
  return `${n} ${t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many}`;
};

function whenLine(meta) {
  if (!meta || !meta.startedAt) return null;
  const t = new Date(meta.startedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const min = Math.max(1, Math.round((new Date(meta.finishedAt || Date.now()) - new Date(meta.startedAt)) / 60000));
  return `${t} по Алматы, заняло ${min} мин`;
}

// Problems of a run sorted into what a person does with them
function sortProblems(results) {
  const fresh = [];
  const decide = [];
  const unchecked = [];
  for (const r of results) {
    const who = results.length > 1 ? `${{ 'R--': '', 'A--': '' }[r.id] ?? `${r.id} `}«${r.title}»: ` : '';
    if (r.error && !r.errorKnown) fresh.push(`${who}${plainError(r.error)}`);
    for (const k of r.checks) {
      if (k.ok === true || k.known || k.axis === 'tariff') continue;
      const text = `${who}${plain(k, r.title)}`;
      if (k.ok === null) unchecked.push(text);
      else if (k.severity === 'note') decide.push(text);
      else fresh.push(text);
    }
  }
  return { fresh, decide, unchecked };
}

function sections({ fresh, decide, unchecked }, results) {
  const out = [];
  const numbered = (list) => list.map((x, i) => `${i + 1}. ${x}`);
  if (fresh.length) out.push('', `🆕 Новые ошибки — о них ещё не сообщали (${fresh.length}):`, ...numbered(fresh));
  if (decide.length) out.push('', `🤔 Возможно, ошибки — нужно решение аналитика (${decide.length}):`, ...numbered(decide));
  if (unchecked.length) out.push('', `❔ Не удалось проверить (${unchecked.length}):`, ...unchecked.map((x) => `• ${x}`));
  const { seen, notSeen } = knownSummary(results);
  if (seen.size) {
    out.push('', `📋 Уже известные ошибки — команда о них знает (${seen.size}):`);
    for (const [id, cases] of seen) {
      const issue = knownIssues.find((i) => i.id === id);
      const where = [...new Set(cases)].map((id) => ({ 'R--': 'журнал заявок', 'A--': 'калькулятор' }[id] || id));
      out.push(`• ${issue.plain || issue.title}${results.length > 1 ? ` (${where.join(', ')})` : ''}`);
    }
  }
  if (notSeen.length) out.push('', '✅ Похоже, исправлено — раньше было, сейчас не повторилось:', ...notSeen.map((i) => `• ${i.plain || i.title}`));
  return out;
}

function purchaseLines(p) {
  const children = p.contractType === 'children';
  const people = children ? plural(p.count, ['ребёнок', 'ребёнка', 'детей']) : plural(p.count, ['взрослый', 'взрослых', 'взрослых']);
  const roles = p.roles ? ` (${[...new Set(p.roles)].map((r) => { const n = p.roles.filter((x) => x === r).length; return `${r.toLowerCase()}${n > 1 ? ` ×${n}` : ''}`; }).join(', ')})` : '';
  return [
    p.variant === 'sport' ? `• Программа «Спорт»: ${p.sportTypes.join(', ')}` : '• Программа «Стандарт»',
    `• Застрахованы: ${people}${roles}`,
    `• Сумма ${p.amount.replace(' тг', ' ₸')} на каждого, срок ${p.term}`,
  ];
}

// The verdict in one line — also used for the progress message
function headline(results, title) {
  annotate(results);
  const { fresh } = sortProblems(results);
  const r = results.length === 1 && results[0].purchase ? results[0] : null;
  if (r) {
    if (r.contractNumber) return fresh.length ? `⚠️ Полис оформлен, но есть новые ошибки: ${fresh.length}` : '✅ Полис оформлен, новых ошибок нет';
    if (r.error && (r.journalId || r.processId)) return '❔ Неизвестно, оформлен ли полис: заявка ушла, ответа нет';
    return '❌ Полис не оформлен';
  }
  return `${fresh.length ? '⚠️' : '✅'} ${title} — ${fresh.length ? `новых ошибок: ${fresh.length}` : 'новых ошибок нет'}`;
}

function purchaseText(r, meta) {
  const lines = [headline([r]), '', 'Что делали: оформляли полис НС через сайт', ...purchaseLines(r.purchase), whenLine(meta) && `• ${whenLine(meta)}`].filter((x) => x !== null && x !== undefined && x !== false);
  if (r.contractNumber) {
    lines.push('', `Полис ${r.contractNumber}${r.card && r.card.status ? ` — ${r.card.status.toLowerCase()}` : ''}`, r.cardUrl);
  } else if (r.error && (r.journalId || r.processId)) {
    lines.push('', 'Заявка на выписку ушла на сервер, но ответа не было. Бот не будет выписывать новый полис через сайт, пока это не выяснится: web ns журнал');
  } else {
    lines.push('', `Причина: ${r.error ? plainError(r.error) : r.notIssuedReason || 'договор не создан'}${r.errorKnown ? ' — это уже известная проблема' : ''}`);
  }
  const problems = sortProblems([r]);
  if (r.error && !(r.journalId || r.processId)) problems.fresh = problems.fresh.filter((x) => x !== plainError(r.error));
  lines.push(...sections(problems, [r]));
  if (r.contractNumber && !problems.fresh.length && !problems.decide.length && !problems.unchecked.length && !r.checks.some((k) => k.known)) lines.push('', 'Все проверки пройдены.');
  return lines.join('\n');
}

function suiteText(results, title, meta) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const lines = [headline(results, title), whenLine(meta)].filter(Boolean);
  const parts = [[count('pass'), 'без ошибок'], [count('fail'), 'с ошибками'], [count('attention'), 'не удалось проверить'], [count('error'), 'не дошли до конца']]
    .filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  lines.push(`Проверено сценариев: ${results.length} — ${parts.join(', ')}`);
  const issued = results.filter((r) => r.contractNumber);
  if (issued.length) lines.push('', `Выписано полисов: ${issued.length}`, ...issued.map((r) => `• ${r.contractNumber} (${r.id})${r.cardUrl ? ` — ${r.cardUrl}` : ''}`));
  lines.push(...sections(sortProblems(results), results));
  const passed = results.filter((r) => r.status === 'pass').map((r) => r.id);
  if (passed.length) lines.push('', `✅ Без ошибок: ${passed.join(', ')}`);
  return lines.join('\n');
}

function summaryText(results, { title = 'НС: прогон', meta } = {}) {
  annotate(results);
  return results.length === 1 && results[0].purchase ? purchaseText(results[0], meta) : suiteText(results, title, meta);
}

// ---------- screenshots ----------

const MAX_PHOTOS = 10;
const CAPTION_MAX = 1024; // Telegram limit

function caption(parts) {
  const text = parts.filter(Boolean).join('\n');
  return text.length > CAPTION_MAX ? `${text.slice(0, CAPTION_MAX - 1)}…` : text;
}

// What is outlined: one line per problem — several checks of one known issue become that issue's sentence.
// On the card shot «В карточке полиса» is already said by the title.
function outlined(checks, kind) {
  const short = (text) => (kind === 'card' ? text.replace(/^В карточке полиса (\S)/, (_, c) => c.toUpperCase()) : text);
  const lines = [];
  const knownDone = new Set();
  for (const k of checks) {
    if (k.known) {
      if (knownDone.has(k.known)) continue;
      knownDone.add(k.known);
      const issue = knownIssues.find((i) => i.id === k.known);
      lines.push(`${short(issue.plain || issue.title)} (известная)`);
    } else {
      lines.push(`${short(plain(k, k.scenarioTitle))} (новая)`);
    }
  }
  return lines.map((x, i) => `${i + 1}. ${x}`);
}

const SHOT_TITLE = {
  certificate: () => 'Окно оформления после оплаты',
  card: (r) => `Карточка полиса${r.contractNumber ? ` ${r.contractNumber}` : ''}`,
};

// Screenshots of scenarios with bugs (new and known) or a crash; the caption says what is outlined in red
function photos(results) {
  annotate(results);
  const out = [];
  const ordered = [...results].sort((a, b) => (a.newStatus === 'pass') - (b.newStatus === 'pass'));
  for (const r of ordered) {
    const bugs = r.checks.filter((k) => k.ok === false && k.axis !== 'tariff');
    if (!bugs.length && !r.error) continue;
    const who = r.purchase ? '' : `${r.id} «${r.title}». `;
    const shots = r.shots || [];
    const on = (shot, k) => (shot.checks || []).includes(k.name) || (!!shot.axis && k.axis === shot.axis);
    shots.forEach((shot, i) => {
      const marked = bugs.filter((k) => on(shot, k));
      out.push({ image: shot.image, caption: caption([
        `${shots.length > 1 ? `Снимок ${i + 1} из ${shots.length}. ` : ''}${who}${(SHOT_TITLE[shot.kind] || (() => 'Экран'))(r)}`,
        marked.length ? 'Красным обведено:' : null,
        ...outlined(marked, shot.kind),
      ]) });
    });
    if (!shots.length && r.screenshot) {
      out.push({ image: r.screenshot, caption: caption([
        `${who}${r.error ? 'Экран, на котором автотест остановился' : 'Экран с ошибкой'}`,
        r.error && plainError(r.error),
        ...outlined(bugs),
      ]) });
    }
  }
  return out.slice(0, MAX_PHOTOS);
}

module.exports = { summaryText, headline, annotate, photos, ICON };
