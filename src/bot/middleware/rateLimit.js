'use strict';

const COOLDOWN_MS = 5_000;
const lastRequest = new Map();

async function rateLimitMiddleware(ctx, next) {
  const userId = ctx.from?.id;

  if (!userId) {
    return await next();
  }

  const now = Date.now();
  const last = lastRequest.get(userId) || 0;
  const elapsed = now - last;

  if (elapsed < COOLDOWN_MS) {
    const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    return await ctx.reply(`⏳ Подожди ещё ${remaining} сек. перед следующим запросом.`);
  }

  lastRequest.set(userId, now);

  try {
    return await next();
  } catch (err) {
    lastRequest.delete(userId);
    throw err;
  }
}

module.exports = { rateLimitMiddleware };