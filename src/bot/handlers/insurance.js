'use strict';

// What the NS and МСТ command handlers share: running a job with progress and the report, and the issuance journal.

const { Progress } = require('../progress');
const { splitIntoChunks } = require('../../reporter/formatter');
const journal = require('../../insurance/journal');
const { summaryText, headline, photos } = require('../../insurance/report');

const lower = (args) => args.map((a) => String(a).toLowerCase().replace(/ё/g, 'е'));

// Both handlers accept the release command; the API journal belongs to `api ns`
const releaseCommand = (channel, e) => `${channel} ${e.product === 'mst' ? 'mst' : 'ns'} снять`;

// `… журнал` — open issuance attempts of this channel: 'web' (НС and МСТ through the site) or 'api'; a corrupt file is shown everywhere
// product: for 'api' only that product's attempts; the site journal is shared by all products
async function journalReply(ctx, channel, product) {
    const open = (await journal.pending()).filter((e) => e.state === 'corrupt' || (e.channel === channel && (!product || (e.product || 'ns') === product)));
    if (!open.length) return ctx.reply(`Незавершённых заявок (${channel}) нет — выписки не заблокированы.`);
    const lines = ['Незавершённые заявки (проверяю их текущий статус):', ''];
    for (const e of open) {
        const r = await journal.recover(e).catch((err) => ({ known: false, note: err.message }));
        const when = String(e.createdAt || '').slice(0, 16).replace('T', ' ');
        if (r.known) {
            lines.push(`✅ ${e.caseId} от ${when}: выяснилось — ${r.outcome.status}${r.outcome.contractNumber ? `, договор ${r.outcome.contractNumber}` : ''}`);
        } else {
            const what = channel === 'web' ? 'блокирует выписку через сайт' : `блокирует запуск ${e.caseId}${e.expectsIssue === false ? ' (негативный сценарий: ошибка сервера может выписать по нему лишний полис)' : ''}`;
            const effect = e.state === 'corrupt' ? 'блокирует ВСЕ выписки' : what;
            lines.push(`❔ ${e.state === 'corrupt' ? 'Повреждённый файл' : e.caseId} от ${when} — ${r.note}`, `   ${effect}; снять: ${releaseCommand(channel, e)} ${e.id}`);
        }
    }
    lines.push('', 'Снимайте блокировку, только если уверены, что заявка не создала полис (проверьте «Мои полисы»).');
    return ctx.reply(lines.join('\n'));
}

// `… снять <id>` — close an open attempt by hand
async function releaseReply(ctx, id, example) {
    if (!id) return ctx.reply(`Укажите ID записи: ${example} снять <id> (его показывает ${example} журнал)`);
    const who = (ctx.from && (ctx.from.username || ctx.from.id)) || 'unknown';
    const r = await journal.release(id, String(who));
    return ctx.reply(`${r.ok ? '✅' : '⚠️'} ${r.note}`);
}

// job: { title, run(onProgress) -> results }
async function runJob(ctx, job) {
    const meta = { startedAt: new Date() };
    const progress = await new Progress(ctx, `🧪 ${job.title}: подготовка...`).start();
    try {
        const results = await job.run(async ({ done, total, current }) => {
            if (current) await progress.update(`🧪 ${done}/${total}: ${current}`);
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

const plural = (n, [one, few, many]) => {
    const t = n % 10, h = n % 100;
    return `${n} ${t === 1 && h !== 11 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many}`;
};

// Commands that only read or explain — no cooldown needed
const INFO = ['помощь', 'help', '?', 'журнал', 'тесты', 'список', 'tests'];
const isInfo = (args) => INFO.includes(lower(args)[0] || '');

module.exports = { journalReply, releaseReply, runJob, lower, plural, isInfo };
