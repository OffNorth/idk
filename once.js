#!/usr/bin/env node
/**
 * Un seul passage de paper trading de l'or, puis fin.
 * Pensé pour GitHub Actions (ou un cron), sans serveur allumé en permanence.
 * Les commandes Telegram (/gold, /backtest…) ne sont pas disponibles dans ce mode.
 */
const cfg = require('./src/config');
const { Api } = require('grammy');
const { Store } = require('./src/store');
const { createChannel, explainTelegramError } = require('./src/channel');
const { runCycle, portfolio } = require('./src/cycle');

(async () => {
  if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant');
  if (!cfg.channelId) throw new Error('TELEGRAM_CHANNEL_ID manquant');

  const store = new Store(cfg.dataDir);
  const channel = createChannel(new Api(cfg.telegramToken), cfg, store);
  if (!(await channel.check())) process.exit(1);

  const out = await runCycle({ cfg, store, channel });
  console.log(`${out.events} événement(s) or\n`);
  console.log(portfolio(cfg, store).replace(/<[^>]+>/g, ''));
})().catch((err) => {
  console.error(`❌ ${explainTelegramError(err)}`);
  process.exit(1);
});
