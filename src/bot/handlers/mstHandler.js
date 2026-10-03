'use strict';

// Bot commands for МСТ (medical insurance for tourists going abroad) testing (bot.js routes them here):
//   web mst [туризм|спорт|студенты|деловые] [0-3|4-74|75+] [1–5]      — a purchase through the site, always issued
//   web mst premium [туризм|спорт|деловые] [0-3|4-74|75+] [1–5]       — the same for МСТ Premium
//   web mst помощь / тесты / журнал / снять <id>
// Country, amount, dates, sport type and level are picked by the bot.

const { enqueuePlaywrightTask } = require('../queue');
const { runWebPurchase, client } = require('../../insurance/purchase');
const { MstFlow } = require('../../mst/flow');
const { MST_KIT } = require('../../mst/checks');
const { parseMstArgs, mstCase, mstDictionaries, MAX_TOURISTS } = require('../../mst/cases');
const { journalReply, releaseReply, runJob, lower, isInfo } = require('./insurance');

const MST_HELP = [
    'web mst — выписать полис МСТ через сайт; web mst premium — МСТ Premium. Можно указать:',
    '  туризм | спорт | студенты | деловые — цель поездки (по умолчанию туризм; в Premium нет «студенты»)',
    '  0-3 | 4-74 | 75+ — возраст туристов (по умолчанию 4-74)',
    `  1…${MAX_TOURISTS} — количество туристов (по умолчанию 1)`,
    'Страну, сумму, даты поездки, вид и уровень спорта бот выбирает сам, каждый раз новые, и пишет их в отчёте.',
    'Каждый запуск выписывает настоящий полис на dev. «Студенты» сайт пока выписать не даёт — бот так и напишет.',
    'Примеры: web mst · web mst спорт 75+ 2 · web mst premium деловые 4-74 5',
    '',
    'web mst тесты — что именно проверяется',
    'web mst журнал — незавершённые выписки через сайт (общий журнал с НС: защита от дублей)',
].join('\n');

const MST_CHECKS = [
    'Что проверяет каждая покупка (web mst):',
    '• шаг 1: страна, сумма, даты, число туристов, цель и возраст ушли в расчёт ровно такими, как заданы',
    '• туристы: страхователь из ГБД, остальных бот вводит вручную латиницей и по-русски',
    '• перед выпиской — что в заявке ровно то, что задано; если нет, полис не выписывается',
    '• договор на сервере: номер, статус, страна, даты, туристы, их возраст и цель, сумма у каждого',
    '• карточку полиса на сайте (присылает снимок, ошибки обведены красным), в том числе название страны',
    '• что цена везде одна: калькулятор, форма, окно оплаты, договор, карточка',
    '• передачу полиса в ЕСБД',
    '• ошибки сервера и страницы во время оформления',
].join('\n');

// args: words after «mst»
async function handleMstCommand(ctx, args = []) {
    const premium = ['premium', 'премиум'].includes(lower(args)[0] || '');
    const rest = premium ? args.slice(1) : args;
    const sub = lower(rest)[0] || '';
    if (['помощь', 'help', '?'].includes(sub)) return ctx.reply(MST_HELP);
    if (['тесты', 'список', 'tests'].includes(sub)) return ctx.reply(MST_CHECKS);
    if (sub === 'журнал') return journalReply(ctx, 'web');
    if (sub === 'снять') return releaseReply(ctx, rest[1], 'web mst');

    const variant = premium ? 'premium' : 'standard';
    const { params, errors } = parseMstArgs(rest, variant);
    if (errors.length) return ctx.reply(`Не понял команду:\n${errors.map((e) => `• ${e}`).join('\n')}\n\n${MST_HELP}`);
    const dict = await mstDictionaries(variant).catch(() => null);
    if (!dict || !dict.countries.length || !dict.amounts.length) {
        return ctx.reply('Не удалось загрузить справочники МСТ (страны и суммы) из NDP API — попробуйте позже.');
    }
    const c = mstCase(params, dict);
    const job = { title: c.title, run: (onProgress) => runWebPurchase({ c, kit: MST_KIT, makeFlow: (browser) => new MstFlow(browser), onProgress }) };
    await ctx.reply([`🤖 ${c.title}`, `Тестовый клиент: ${client.fullName} (ИИН ${client.iin})`, '⚠️ Будет выписан реальный полис на dev'].join('\n'));
    return enqueuePlaywrightTask(ctx, () => runJob(ctx, job));
}

const isMstInfoCommand = (args) => isInfo(['premium', 'премиум'].includes(lower(args)[0] || '') ? args.slice(1) : args);

module.exports = { handleMstCommand, isMstInfoCommand };
