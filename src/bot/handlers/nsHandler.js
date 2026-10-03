'use strict';

// Bot commands for NS (accident insurance) testing (bot.js routes them here):
//   web ns [стандарт|спорт] [взрослые|дети] [1–10]   — a purchase through the site, always issued;
//                                                    amount, term, sport types and roles are picked by the bot
//   web ns ошибки                                    — form validation scenarios (N01–N09), nothing is issued
//   api ns                                           — calculator boundaries (A) + issuance straight to the server (I)
//   web|api ns журнал / снять <id>                   — open issuance attempts of that channel / release one by hand
//   web|api ns помощь / тесты                        — the options / what exactly is checked

const { enqueuePlaywrightTask } = require('../queue');
const { splitIntoChunks } = require('../../reporter/formatter');
const journal = require('../../insurance/journal');
const { runWebPurchase, client } = require('../../insurance/purchase');
const { NsFlow, runNegatives } = require('../../ns/flow');
const { NS_KIT } = require('../../ns/checks');
const { parseWebArgs, webCase, MAX_INSURED, negativeCases, calcCases, issueApiCases } = require('../../ns/cases');
const { nsDictionaries, runApiSuite } = require('../../ns/api');
const { journalReply, releaseReply, runJob, lower, plural, isInfo } = require('./insurance');

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

const CHECKS = ['проверка', 'проверки', 'проверок'];

async function testList(prefix) {
    if (prefix === 'web') {
        return [...WEB_CHECKS, '', `web ns ошибки — ${plural(negativeCases.length, CHECKS)} формы, полис не создаётся:`,
            ...negativeCases.map((c) => `${c.id} ${c.title}`)].join('\n');
    }
    const blocked = (await journal.pending()).filter((e) => e.channel === 'api' && e.state !== 'corrupt').map((e) => e.caseId);
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


// The job for `web ns …`; false = already explained to the person, null = unknown command
async function webJob(ctx, args) {
    const words = lower(args);
    if (words[0] === 'ошибки') {
        return words.length === 1 ? { title: 'НС через сайт: проверки формы', issuing: false, run: (onProgress) => runNegatives({ onProgress }) } : null;
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
    return {
        title: `НС через сайт: ${c.title}`,
        issuing: true,
        run: (onProgress) => runWebPurchase({ c, kit: NS_KIT, makeFlow: (browser) => new NsFlow(browser), onProgress }),
    };
}

// prefix: 'web' | 'api'; args: words after «ns»
async function handleNsCommand(ctx, prefix, args = []) {
    const sub = lower(args)[0] || '';
    if (['помощь', 'help', '?'].includes(sub)) return ctx.reply(HELP[prefix]);
    if (['тесты', 'список', 'tests'].includes(sub)) {
        for (const chunk of splitIntoChunks(await testList(prefix))) await ctx.reply(chunk);
        return undefined;
    }
    if (sub === 'журнал') return journalReply(ctx, prefix);
    if (sub === 'снять') return releaseReply(ctx, args[1], `${prefix} ns`);

    let job = null;
    if (prefix === 'web') job = await webJob(ctx, args);
    else if (!args.length) job = { title: 'НС через API: калькулятор и выписка', issuing: true, run: (onProgress) => runApiSuite({ onProgress }) };
    if (job === false) return undefined;
    if (!job) return ctx.reply(`Неизвестная команда «${[prefix, 'ns', ...args].join(' ')}».\n\n${HELP[prefix]}`);

    const lines = [`🤖 ${job.title}`, `Тестовый клиент: ${client.fullName} (ИИН ${client.iin})`];
    if (job.issuing) lines.push('⚠️ Будут выписаны реальные полисы на dev');
    await ctx.reply(lines.join('\n'));
    return enqueuePlaywrightTask(ctx, () => runJob(ctx, job));
}

module.exports = { handleNsCommand, isInfoCommand: isInfo };
