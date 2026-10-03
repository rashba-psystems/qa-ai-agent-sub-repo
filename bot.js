'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const { Telegraf, session, Scenes } = require('telegraf');
const { authMiddleware } = require('./src/bot/middleware/auth');
const { rateLimitMiddleware } = require('./src/bot/middleware/rateLimit');
const { handleTest, handleRegress } = require('./src/bot/handlers/testHandler');
const { handleChecklist } = require('./src/bot/handlers/checklistHandler');
const { handleInvestigate } = require('./src/bot/handlers/investigateHandler');
const { handlePolicy } = require('./src/bot/handlers/policyHandler');
const { handleWebOgpoPolicy } = require('./src/bot/handlers/webOgpoPolicyHandler');
const { handleWebOgpoLegal } = require('./src/bot/handlers/webOgpoLegalEntityPolicyHandler');
const { handleNsCommand, isInfoCommand } = require('./src/bot/handlers/nsHandler');
const { handleMstCommand, isMstInfoCommand, handleMstApiCommand, isMstApiInfoCommand } = require('./src/bot/handlers/mstHandler');
const { removeUserFromQueue } = require('./src/bot/queue')
const { initBrowser, closeBrowser } = require('./src/bot/middleware/browserManager');

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 10 * 60 * 1000, // 10 minutes — AI gen + PDF upload + playwright
});

const stage = new Scenes.Stage([]);

// Команда отмены для сцен
stage.hears('cancel', async (ctx) => {
  await ctx.scene.leave();
  removeUserFromQueue(ctx.from.id);
  return ctx.reply('Процесс оформления прерван. Вы вернулись в главное меню. Можете выбрать новую команду.', { parse_mode: 'Markdown' });
});

bot.use(session());
bot.use(stage.middleware());

const HELP_TEXT = `*QA AI Agent*

*Команды:*

\`test <url> <фича>\`
Сгенерировать AI тест (получишь PDF) и запустить
_Пример: test https://cabinet.nomad.kz/login поле иин_

\`test list\`
Список всех сгенерированных тестов с ID

\`test run <TC\\-001>\`
Запустить тест по ID
_Пример: test run TC\\-001_

\`checklist <url> <фича>\`
Сгенерировать QA чеклист
_Пример: checklist https://cabinet.nomad.kz/login поле иин_

\`test retry <TC\\-001>\`
Перезапустить только упавшие тесты из прогона
_Пример: test retry TC\\-001_

\`regress\`
Регресс\\-прогон всех тестов \\(последний TC на каждую фичу\\)
_Пример: regress_
_Пример: regress cabinet.nomad.kz_ \\(фильтр по URL\\)

\`investigate <лог ошибки>\`
Анализ причины падения теста

\`policy <ns\\|ogpo\\|mst> <иин\\|номер\\|list>\`
Получить уже выписанные полисы через API NDP
_Пример: policy ns list_
_Пример: policy ns 820921300652_
_Пример: policy ns NS\\-2025\\-000099_

\`web ogpo individual | web ogpo legal>\`
Оформить полис ОГПО (Playwright + OCR + CRM)
_Пример: web ogpo individual_ — для физических лиц
_Пример: web ogpo legal_ — для юридических лиц

\`web mst [premium] [цель] [возраст] [1–5]\` — через сайт (браузер)
Выписать полис МСТ; страну, сумму, даты, вид спорта бот выбирает сам
_Пример: web mst спорт 75+ 2_
_Пример: web mst premium деловые 4-74 5_
_web mst помощь_ — подсказка, _web mst тесты_ — что проверяется
_api mst_ — МСТ напрямую в сервер: калькулятор и выписка (создаёт полисы), _api mst тесты_ — что проверяется

\`web ns [стандарт|спорт] [взрослые|дети] [1–10]\` — через сайт (браузер)
Выписать полис НС; сумму, срок, виды спорта и роли бот выбирает сам
_Пример: web ns спорт 3_
_Пример: web ns дети 2_
_web ns помощь_ — подсказка
_web ns тесты_ — что именно проверяется
_web ns ошибки_ — проверки формы на неправильных данных (без выписки)
_web ns журнал_ — незавершённые выписки и снятие блокировки

\`api ns\` — напрямую в сервер, без браузера
Калькулятор и выписка через API (создаёт полисы)
_api ns журнал_ — незавершённые заявки и снятие блокировки
_api ns тесты_ — что именно проверяется

\`cancel\`
Прервать текущее оформление полиса

\`help\`
Показать это сообщение`;

bot.use(authMiddleware);

bot.start((ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));
bot.help((ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' })); 

bot.on(['text', 'photo', 'document'], async (ctx) => {
  const text = (ctx.message.text || ctx.message.caption || '').trim();

  if (!text || text.startsWith('/')) return;

  const [command, ...args] = text.split(/\s+/);

  switch (command.toLowerCase()) {
    case 'test':
      return rateLimitMiddleware(ctx, () => handleTest(ctx, args));

    case 'api': {
      // `api ns [журнал | снять <id> | помощь]` — проверки НС напрямую в сервер, без браузера
      if ((args[0] || '').toLowerCase() === 'ns') {
        const nsArgs = args.slice(1);
        if (isInfoCommand(nsArgs)) return handleNsCommand(ctx, 'api', nsArgs);
        return rateLimitMiddleware(ctx, () => handleNsCommand(ctx, 'api', nsArgs));
      }
      if ((args[0] || '').toLowerCase() === 'mst') {
        const mstArgs = args.slice(1);
        if (isMstApiInfoCommand(mstArgs)) return handleMstApiCommand(ctx, mstArgs);
        return rateLimitMiddleware(ctx, () => handleMstApiCommand(ctx, mstArgs));
      }
      return ctx.reply('Доступные команды:\n`api ns` — НС: калькулятор и выписка через API (создаёт полисы)\n`api mst` — МСТ: калькулятор и выписка через API (создаёт полисы)', { parse_mode: 'Markdown' });
    }

    case 'regress':
      return rateLimitMiddleware(ctx, () => handleRegress(ctx, args));

    case 'checklist':
      return rateLimitMiddleware(ctx, () => handleChecklist(ctx, args));

    case 'investigate':
      return handleInvestigate(ctx, args);

    case 'policy':
      return rateLimitMiddleware(ctx, () => handlePolicy(ctx, args));

    case 'web': {
      const subCommand = args.join(' ').toLowerCase();

      console.log(`[DEBUG] Поймал команду web! subCommand: "${subCommand} от пользователя с ID: ${ctx.from.id}"`);

      if (subCommand === 'ogpo individual') {
        rateLimitMiddleware(ctx, async () => {
          handleWebOgpoPolicy(ctx).catch(err => {
            console.error(`[ERROR] Сбой в сценарии для ID ${ctx.from.id}:`, err);
          });
        });
        return;
      } 
      
      if (subCommand === 'ogpo legal') {
        rateLimitMiddleware(ctx, async () => {
          handleWebOgpoLegal(ctx).catch(err => {
            console.error(`[ERROR] Сбой в сценарии для ID ${ctx.from.id}:`, err);
          });
        });
        return;
      }
      
      if (subCommand === 'mst' || subCommand.startsWith('mst ')) {
        const mstArgs = args.slice(1);
        if (isMstInfoCommand(mstArgs)) return handleMstCommand(ctx, mstArgs);
        return rateLimitMiddleware(ctx, () => handleMstCommand(ctx, mstArgs));
      }
      
      if (subCommand === 'ns' || subCommand.startsWith('ns ')) {
        const nsArgs = args.slice(1);
        if (isInfoCommand(nsArgs)) return handleNsCommand(ctx, 'web', nsArgs);
        return rateLimitMiddleware(ctx, () => handleNsCommand(ctx, 'web', nsArgs));
      } else {
        return ctx.reply(
          'Пожалуйста, укажите верный продукт. Доступные команды:\n`web ogpo individual` | `web ogpo legal`\n`web mst` | `web mst premium`\n`web ns` | `web ns помощь`', 
          { parse_mode: 'Markdown' }
        )
      }
    }

    case 'help':
      return ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });

    default:
      return ctx.reply(
        'Неизвестная команда. Напиши `help` для списка команд.',
        { parse_mode: 'Markdown' }
      );
  }
});

bot.catch((err, ctx) => {
  const msg = err.message || '';
  console.error('[bot.catch] error:', msg);
  console.error('[bot.catch] stack:', err.stack);
  if (msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    console.warn('[bot.catch] network error (ignored):', msg);
    return;
  }
  ctx.reply('Произошла неожиданная ошибка. Попробуй ещё раз.').catch(() => {});
});

if (require.main === module) {
  initBrowser().then(() => {
    bot.launch({ dropPendingUpdates: true });
    console.log("QA AI Agent running...");
  }).catch(err => {
    console.error('Error to launch bot', err);
  });
};

module.exports = bot;

process.once('SIGINT', async () => {
  await closeBrowser();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  await closeBrowser();
  bot.stop('SIGTERM');
});