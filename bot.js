/**
 * bot.js — Bot Telegram de paper trading de l'or (plusieurs stratégies, simulation uniquement)
 *
 * Commandes :
 *   /start          — aide
 *   /gold           — bilan de chaque stratégie
 *   /strategies     — description des stratégies
 *   /backtest [j]   — backtest des stratégies sur l'historique
 *   /bilan          — publie le bilan sur le canal
 *   /testcanal      — vérifie la publication sur le canal
 *   /settings       — paramètres actifs
 *   /pause, /resume — coupe / relance les publications sur le canal
 */
const cfg = require('./src/config');
const { Bot } = require('grammy');
const { Store } = require('./src/store');
const { backtest, fetchHistory } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');
const { backtestMessage, esc } = require('./src/format');
const { createChannel, explainTelegramError, HTML } = require('./src/channel');
const { runCycle, portfolio } = require('./src/cycle');

if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant (voir .env.example)');

const bot = new Bot(cfg.telegramToken);
const store = new Store(cfg.dataDir);
const channel = createChannel(bot.api, cfg, store);

let paused = false;
let running = null; // évite deux passages simultanés

/* ------------------------------------------------------------------ */
/* Passage périodique                                                  */
/* ------------------------------------------------------------------ */

function tick() {
  if (!running) {
    running = runCycle({ cfg, store, channel, publish: !paused })
      .then((out) => {
        console.log(`[${new Date().toISOString()}] ${out.events} événement(s) or`);
        return out;
      })
      .catch((err) => {
        console.error('[or] échec du passage :', err.message);
        return null;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

bot.use(async (ctx, next) => {
  if (!cfg.allowedUserIds.size || !ctx.from) return next();
  if (cfg.allowedUserIds.has(String(ctx.from.id))) return next();
  await ctx.reply('Accès refusé : ton ID Telegram n’est pas autorisé.');
});

bot.command('start', (ctx) =>
  ctx.reply(
    [
      '<b>🥇 Paper trading de l’or</b>',
      '',
      `Je trade l’or (PAXG/USD) en <b>simulation</b> avec ${selectStrategies(cfg.goldStrategies).length} stratégies en parallèle,`,
      `$${cfg.goldSizeUsd} par trade et par stratégie. Chaque entrée / sortie est publiée sur le canal.`,
      '',
      '/gold — bilan de chaque stratégie',
      '/strategies — comment fonctionne chaque stratégie',
      '/backtest [jours] — tester les stratégies sur l’historique',
      '/bilan — publier le bilan sur le canal',
      '/testcanal — vérifier que je peux publier sur le canal',
      '/settings — paramètres',
      '/pause · /resume — publications sur le canal',
      '',
      '<i>⚠️ Simulation uniquement, aucun argent réel. Pas un conseil financier.</i>',
    ].join('\n'),
    HTML,
  ),
);

bot.command(['gold', 'paper'], (ctx) => ctx.reply(portfolio(cfg, store), HTML));

bot.command('strategies', (ctx) =>
  ctx.reply(
    selectStrategies(cfg.goldStrategies)
      .map((s) => `<b>${esc(s.name)}</b> (<code>${s.id}</code>)\n${esc(s.desc)}`)
      .join('\n\n'),
    HTML,
  ),
);

bot.command('backtest', async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.match.trim()) || 90, 20), 365);
  const wait = await ctx.reply(`⏳ Backtest des stratégies sur ${days} jours…`);
  try {
    const candles = await fetchHistory(days);
    if (candles.length < 250) throw new Error('historique insuffisant');
    const results = selectStrategies(cfg.goldStrategies).map((strategy) => ({
      strategy,
      r: backtest(strategy, candles, { size: cfg.goldSizeUsd, feePct: cfg.goldFeePct }),
    }));
    const from = candles[0].c;
    const to = candles[candles.length - 1].c;
    const txt = backtestMessage(results, { days, from, to, buyHold: (to / from - 1) * 100 }, cfg);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, txt, HTML);
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Backtest impossible : ${esc(err.message)}`);
  }
});

bot.command('bilan', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  try {
    await channel.sendText(portfolio(cfg, store));
    channel.markSummary();
    await ctx.reply('✅ Bilan publié sur le canal.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('testcanal', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  try {
    await channel.sendText('✅ <b>Test</b> : le bot de paper trading de l’or peut publier ici.');
    await ctx.reply('✅ Message de test publié sur le canal.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('settings', (ctx) =>
  ctx.reply(
    [
      '<b>⚙️ Paramètres</b>',
      `Stratégies : ${selectStrategies(cfg.goldStrategies).map((s) => s.id).join(', ')}`,
      `Taille : $${cfg.goldSizeUsd} par trade et par stratégie · frais ${cfg.goldFeePct}% par côté`,
      `Vérification toutes les ${cfg.checkIntervalMin} min`,
      `Bilan sur le canal : ${cfg.summaryHours > 0 ? `toutes les ${cfg.summaryHours} h` : 'désactivé'}`,
      `Canal : ${cfg.channelId ? esc(cfg.channelId) : 'non défini'} · publications ${paused ? '⏸ en pause' : '▶️ actives'}`,
    ].join('\n'),
    HTML,
  ),
);

bot.command('pause', (ctx) => {
  paused = true;
  return ctx.reply('⏸ Publications sur le canal en pause (le paper trading continue).');
});

bot.command('resume', (ctx) => {
  paused = false;
  return ctx.reply('▶️ Publications sur le canal relancées.');
});

bot.catch((err) => console.error('[bot] erreur :', err.error || err));

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

(async () => {
  await bot.api.setMyCommands([
    { command: 'gold', description: 'Bilan de chaque stratégie' },
    { command: 'strategies', description: 'Comment fonctionne chaque stratégie' },
    { command: 'backtest', description: 'Tester les stratégies : /backtest 90' },
    { command: 'bilan', description: 'Publier le bilan sur le canal' },
    { command: 'testcanal', description: 'Tester la publication sur le canal' },
    { command: 'settings', description: 'Paramètres actifs' },
    { command: 'pause', description: 'Mettre les publications en pause' },
    { command: 'resume', description: 'Relancer les publications' },
  ]);
  await channel.check();

  tick();
  setInterval(tick, cfg.checkIntervalMin * 60_000);

  bot.start({ onStart: (me) => console.log(`Bot @${me.username} démarré.`) });
})().catch((err) => {
  console.error(`❌ Démarrage impossible : ${explainTelegramError(err)}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => bot.stop().then(() => process.exit(0)));
