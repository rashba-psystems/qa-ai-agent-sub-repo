'use strict';

// Bot commands for NS testing (bot.js routes them here):
//   web ns [стандарт|спорт] [взрослые|дети] [1–10]   — a purchase through the site, always issued;
//                                                    amount, term, sport types and roles are picked by the bot
//   web ns ошибки                                    — form validation scenarios (N01–N09), nothing is issued
//   api ns                                           — calculator boundaries (A) + issuance straight to the server (I)
//   web|api ns журнал / снять <id>                   — open issuance attempts of that channel / release one by hand
//   web|api ns помощь                                — the list of options

const { Progress } = require('../progress');
const { enqueuePlaywrightTask } = require('../queue');
const { splitIntoChunks } = require('../../reporter/formatter');
const { runSuite, journal, expectsIssueOf } = require('../../ns/runner');
const { parseWebArgs, webCase, MAX_INSURED, client, negativeCases, calcCases, issueApiCases } = require('../../ns/cases');
const { nsDictionaries } = require('../../ns/api');
const { summaryText, headline, photos } = require('../../ns/report');

const WEB_HELP = [
    'web ns — выписать полис НС через сайт. Можно указать:',
    '  стандарт | спорт — программа (по умолчанию стандарт)',
    '  взрослые | дети — категория (по умолчанию взрослые)',
    `  1…${MAX_INSURED} — количество застрахованных (по умолчанию 1)`,
    'Сумму, срок, виды спорта и роли бот выбирает сам, каждый раз новые, и пишет их в отчёте.',
    'Каждый запуск выписывает настоящий полис на dev.',
    'Примеры: web ns · web ns спорт 3 · web ns дети 2',
    '',
    'web ns ошибки — проверки формы на неправильных данных (N01–N09), без выписки',
    'web ns журнал — незавершённые выписки через сайт; web ns снять <id> — снять блокировку',
    'web ns тесты — что именно проверяется',
].join('\n');

const API_HELP = [
    'api ns — калькулятор (A01–A22) и выписка напрямую через сервер (I01–I18, создаёт полисы)',
    'api ns журнал — незавершённые заявки через API; api ns снять <id> — снять блокировку',
    'api ns тесты — что именно проверяется',
].join('\n');

const HELP = { web: WEB_HELP, api: API_HELP };

// `<web|api> ns тесты`: every check the commands run, in plain words
const WEB_CHECKS = [
    'Что проверяет каждая покупка (web ns):',
    '• все шаги формы: параметры, страхователь, застрахованные, анкета, оплата наличными',
    '• перед выпиской — что в заявке ровно то, что задано; если нет, полис не выписывается',
    '• договор на сервере: номер, статус, даты, сумма, все застрахованные',
    '• карточку полиса на сайте (присылает снимок, ошибки обведены красным)',
    '• что цена везде одна: калькулятор, форма, окно оплаты, договор, карточка',
    '• возраст каждого застрахованного подходит категории, в Спорте — роль у каждого',
    '• передачу полиса в ЕСБД',
    '• ошибки сервера и страницы во время оформления',
];

const plural = (n, [one, few, many]) => {
    const t = n % 10, h = n % 100;
    return `${n} ${t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many}`;
};
const CHECKS = ['проверка', 'проверки', 'проверок'];

async function testList(prefix) {
    if (prefix === 'web') {
        return [...WEB_CHECKS, '', `web ns ошибки — ${plural(negativeCases.length, CHECKS)} формы, полис не создаётся:`,
            ...negativeCases.map((c) => `${c.id} ${c.title}`)].join('\n');
    }
    const blocked = (await journal.pending()).filter((e) => e.channel === 'api').map((e) => e.caseId);
    const short = (title) => title.replace(/^API: /, '').replace(/\s*—?\s*отклоняется$/, '');
    return [
        `api ns — калькулятор — ${plural(calcCases.length, CHECKS)}, полис не создаётся:`,
        ...calcCases.map((c) => `${c.id} ${c.title} → ${c.expect === 'ok' ? 'должен посчитать' : 'должен отказать'}`),
        '',
        `api ns — выписка через сервер — ${plural(issueApiCases.length, ['заявка', 'заявки', 'заявок'])}:`,
        ...issueApiCases.map((c) => `${c.id} ${short(c.title)} → ${c.expect === 'issue' ? 'должен выписать полис' : 'должен отказать'}`),
        blocked.length ? `\nСейчас пропускаются (сервер не ответил на прошлую заявку): ${[...new Set(blocked)].sort().join(', ')} — подробнее: api ns журнал` : null,
    ].filter((x) => x !== null).join('\n');
}

const lower = (args) => args.map((a) => String(a).toLowerCase().replace(/ё/g, 'е'));

// `<web|api> ns журнал` — open issuance attempts of this channel (a corrupt file is shown everywhere)
async function handleJournal(ctx, channel) {
    const open = (await journal.pending()).filter((e) => e.state === 'corrupt' || e.channel === channel);
    if (!open.length) return ctx.reply(`Незавершённых заявок (${channel}) нет — выписки не заблокированы.`);
    const lines = ['Незавершённые заявки (проверяю их текущий статус):', ''];
    for (const e of open) {
        const r = await journal.recover(e).catch((err) => ({ known: false, note: err.message }));
        const when = String(e.createdAt || '').slice(0, 16).replace('T', ' ');
        if (r.known) {
            lines.push(`✅ ${e.caseId} от ${when}: выяснилось — ${r.outcome.status}${r.outcome.contractNumber ? `, договор ${r.outcome.contractNumber}` : ''}`);
        } else {
            const what = channel === 'web' ? 'блокирует выписку через сайт' : `блокирует запуск ${e.caseId}${expectsIssueOf(e) ? '' : ' (негативный сценарий: ошибка сервера может выписать по нему лишний полис)'}`;
            const effect = e.state === 'corrupt' ? 'блокирует ВСЕ выписки' : what;
            lines.push(`❔ ${e.state === 'corrupt' ? 'Повреждённый файл' : e.caseId} от ${when} — ${r.note}`, `   ${effect}; снять: ${channel} ns снять ${e.id}`);
        }
    }
    lines.push('', 'Снимайте блокировку, только если уверены, что заявка не создала полис (проверьте «Мои полисы»).');
    return ctx.reply(lines.join('\n'));
}

async function runJob(ctx, job) {
    const meta = { startedAt: new Date() };
    const progress = await new Progress(ctx, `🧪 ${job.title}: подготовка...`).start();
    try {
        const results = await runSuite({
            mode: job.mode,
            webCase: job.webCase,
            onProgress: async ({ done, total, current }) => {
                if (current) await progress.update(`🧪 ${done}/${total}: ${current}`);
            },
        });
        meta.finishedAt = new Date();
        await progress.done(headline(results, job.title));
        for (const chunk of splitIntoChunks(summaryText(results, { title: job.title, meta }))) await ctx.reply(chunk);
        for (const p of photos(results)) {
            await ctx.replyWithPhoto({ source: p.image }, { caption: p.caption }).catch((e) => console.error('[ns] photo:', e.message));
        }
    } catch (err) {
        console.error('[ns] Error:', err);
        await progress.fail(`${job.title}: ${err.message}`);
    }
}

// The job for `web ns …`; false = already explained to the person, null = unknown command
async function webJob(ctx, args) {
    const words = lower(args);
    if (words[0] === 'ошибки') {
        return words.length === 1 ? { mode: 'web-negative', title: 'НС через сайт: проверки формы', issuing: false } : null;
    }
    const { params, errors } = parseWebArgs(args);
    if (errors.length) {
        await ctx.reply(`Не понял команду:\n${errors.map((e) => `• ${e}`).join('\n')}\n\n${WEB_HELP}`);
        return false;
    }
    const dict = await nsDictionaries().catch(() => null);
    if (!dict || !dict.amounts.length || !dict.sports.length) {
        await ctx.reply('Не удалось загрузить справочники НС (суммы и виды спорта) из NDP API — попробуйте позже.');
        return false;
    }
    const c = webCase(params, dict);
    return { mode: 'web', webCase: c, title: `НС через сайт: ${c.title}`, issuing: true };
}

// prefix: 'web' | 'api'; args: words after «ns»
async function handleNsCommand(ctx, prefix, args = []) {
    const sub = lower(args)[0] || '';
    if (['помощь', 'help', '?'].includes(sub)) return ctx.reply(HELP[prefix]);
    if (['тесты', 'список', 'tests'].includes(sub)) {
        for (const chunk of splitIntoChunks(await testList(prefix))) await ctx.reply(chunk);
        return undefined;
    }
    if (sub === 'журнал') return handleJournal(ctx, prefix);
    if (sub === 'снять') {
        if (!args[1]) return ctx.reply(`Укажите ID записи: ${prefix} ns снять <id> (его показывает ${prefix} ns журнал)`);
        const who = (ctx.from && (ctx.from.username || ctx.from.id)) || 'unknown';
        const r = await journal.release(args[1], String(who));
        return ctx.reply(`${r.ok ? '✅' : '⚠️'} ${r.note}`);
    }

    let job = null;
    if (prefix === 'web') job = await webJob(ctx, args);
    else if (!args.length) job = { mode: 'api', title: 'НС через API: калькулятор и выписка', issuing: true };
    if (job === false) return undefined;
    if (!job) return ctx.reply(`Неизвестная команда «${[prefix, 'ns', ...args].join(' ')}».\n\n${HELP[prefix]}`);

    const lines = [`🤖 ${job.title}`, `Тестовый клиент: ${client.fullName} (ИИН ${client.iin})`];
    if (job.issuing) lines.push('⚠️ Будут выписаны реальные полисы на dev');
    await ctx.reply(lines.join('\n'));
    return enqueuePlaywrightTask(ctx, () => runJob(ctx, job));
}

// Commands that only read or explain — no cooldown needed
const isInfoCommand = (args) => ['помощь', 'help', '?', 'журнал', 'тесты', 'список', 'tests'].includes(lower(args)[0] || '');

module.exports = { handleNsCommand, isInfoCommand };
