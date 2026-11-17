#!/usr/bin/env node
/**
 * Un seul passage : scan → alertes sur le canal → résumé du top si dû → fin.
 * Pensé pour GitHub Actions (ou un cron), sans serveur allumé en permanence.
 * Les commandes Telegram (/top, /check…) ne sont pas disponibles dans ce mode.
 */
const cfg = require('./src/config');
const { Api } = require('grammy');
const { Store } = require('./src/store');
const { scan } = require('./src/scanner');
const { createChannel, explainTelegramError } = require('./src/channel');

(async () => {
  if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant');
  if (!cfg.channelId) throw new Error('TELEGRAM_CHANNEL_ID manquant');

  const store = new Store(cfg.dataDir);
  const channel = createChannel(new Api(cfg.telegramToken), cfg, store);
  if (!(await channel.check())) process.exit(1);

  const res = await scan(cfg, store);
  const sent = await channel.postAlerts(res);
  console.log(
    `${res.watched} suivis · ${res.inRange} dans la fourchette · ${res.ranked.length} retenus · ` +
      `meilleur ${res.ranked[0] ? Math.round(res.ranked[0].result.total) : '-'} · ${sent} alerte(s) publiée(s)`,
  );
  res.ranked.slice(0, 5).forEach((x, i) =>
    console.log(`  ${i + 1}. ${x.token.symbol} — ${Math.round(x.result.total)}/100 — ${x.token.url}`),
  );

  if (channel.topSummaryDue()) {
    await channel.postTop(res);
    console.log('Résumé du top publié sur le canal.');
  }
})().catch((err) => {
  console.error(`❌ ${explainTelegramError(err)}`);
  process.exit(1);
});
