/**
 * bot.js — Bot Telegram de paper trading (or + Nasdaq 100, plusieurs stratégies, simulation uniquement)
 *
 * Pour tout le groupe :
 *   /menu            — panneau interactif : une image qui change avec les boutons
 *                      (portefeuille, classement, positions, cours, historique, fiches des stratégies)
 *   /graphique [or|nasdaq] — cours en bougies
 *   /jeu, /classement — pronostic du jour (hausse / baisse) et classement des joueurs
 *   /gold, /nasdaq   — bilan texte · /portfolio · /historique [or|nasdaq] [année] · /strategies
 *   Boutons sous chaque trade (carte du trade, cours avec entrée / stop / objectif, fiche) et sous le bilan.
 *
 * Réservé aux ALLOWED_TELEGRAM_USER_IDS (si la liste est remplie) :
 *   /bilan, /testcanal, /settings, /pause, /resume, /backtest, /pronostic (lance un tour du jeu)
 */
const cfg = require('./src/config');
const { Bot, InputFile } = require('grammy');
const { Store } = require('./src/store');
const { backtest, fetchBacktestData } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');
const { backtestMessage, esc } = require('./src/format');
const { createChannel, explainTelegramError, HTML } = require('./src/channel');
const { runCycle, portfolio } = require('./src/cycle');
const { liveChart, historyChart } = require('./src/portfolio');
const { activeMarkets, marketById } = require('./src/markets');
const { attachInteractive, sendPanel, summaryKeyboard } = require('./src/interactive');
const { createGame } = require('./src/game');

if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant (voir .env.example)');

const bot = new Bot(cfg.telegramToken);
const store = new Store(cfg.dataDir);
const channel = createChannel(bot.api, cfg, store);
const game = createGame({ cfg, store, api: bot.api });

let paused = false;
let running = null; // évite deux passages simultanés

/* ------------------------------------------------------------------ */
/* Passage périodique                                                  */
/* ------------------------------------------------------------------ */

function tick() {
  if (!running) {
    running = runCycle({ cfg, store, channel, publish: !paused, buttons: true })
      .then(async (out) => {
        console.log(`[${new Date().toISOString()}] événements : ${Object.entries(out.byMarket).map(([m, n]) => `${m} ${n}`).join(' · ') || 'aucun marché actif'}`);
        if (!paused) await game.tick();
        return out;
      })
      .catch((err) => {
        console.error('[bot] échec du passage :', err.message);
        return null;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}

/* ------------------------------------------------------------------ */
/* Accès                                                               */
/* ------------------------------------------------------------------ */

const ADMIN = new Set(['bilan', 'testcanal', 'settings', 'pause', 'resume', 'backtest', 'pronostic']);
const isAdmin = (ctx) => !cfg.allowedUserIds.size || (ctx.from && cfg.allowedUserIds.has(String(ctx.from.id)));

// Les boutons et les commandes de consultation sont ouverts à tout le groupe ; les réglages sont réservés.
bot.use(async (ctx, next) => {
  const cmd = ctx.message?.text?.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();
  if (cmd && ADMIN.has(cmd) && !isAdmin(ctx)) return ctx.reply('Commande réservée à l’administrateur du bot.');
  return next();
});

attachInteractive(bot, { cfg, store, gameHandler: (ctx, parts) => game.onVote(ctx, parts) });

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

// Nasdaq par défaut ; « or » / « gold » pour l'or
const marketArg = (text) => (/\b(or|gold|xau)\b/i.test(text || '') ? 'gold' : /\b(eur|eurusd|euro)\b/i.test(text || '') ? 'eurusd' : /\b(sp500|spx|s&p|us500)\b/i.test(text || '') ? 'spx' : 'nas100');

bot.command(['start', 'aide', 'help'], (ctx) =>
  ctx.reply(
    [
      '<b>📊 Paper trading : 🇺🇸 Nasdaq 100 (+ 🥇 or)</b>',
      ...activeMarkets(cfg).map((m) => `${m.emoji} ${m.name} : ${selectStrategies(m.strategies).length} stratégies, $${m.startCapital} chacune au départ, gains réinvestis`),
      'Les trades sont regroupés dans un résumé chaque soir ; /menu pour tout voir (portefeuille, positions, fiches…).',
      '',
      '/menu — 🎛 panneau interactif (images qui changent avec les boutons)',
      '/graphique [nasdaq|or] — 🕯 cours en bougies (Nasdaq par défaut)',
      '/ftmo [nasdaq|or] — 🏦 comptes FTMO simulés (challenge +10 % puis +5 %)',
      '/jeu — 🎯 pronostic du jour · /classement — points des joueurs',
      '/nasdaq · /gold — bilan texte',
      '/portfolio — graphiques des portefeuilles',
      '/historique [nasdaq|or] [année] — simulation sur l’historique (Nasdaq par défaut)',
      '/strategies — comment fonctionne chaque stratégie',
      '',
      '<i>⚠️ Simulation uniquement, aucun argent réel. Pas un conseil financier.</i>',
    ].join('\n'),
    HTML,
  ),
);

/** Envoie une image construite à la demande, avec un message d'attente. */
async function replyImage(ctx, build, waitText) {
  const wait = await ctx.reply(waitText);
  try {
    const out = await build();
    await ctx.replyWithPhoto(new InputFile(out.png, 'image.png'), { caption: out.caption, parse_mode: 'HTML', ...(out.keyboard ? { reply_markup: out.keyboard } : {}) });
    if (out.details) await ctx.reply(out.details.slice(0, 4096), HTML);
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Image impossible : ${esc(err.message)}`).catch(() => {});
  }
}

bot.command(['menu', 'panneau'], async (ctx) => {
  try {
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, {
      marketId: marketArg(ctx.match),
      extra: ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {},
    });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
});

bot.command(['graphique', 'cours', 'chart'], async (ctx) => {
  try {
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, { view: 'c', marketId: marketArg(ctx.match), args: ['1d'] });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
});

bot.command(['gold', 'paper', 'or'], (ctx) => ctx.reply(portfolio(cfg, store, 'gold'), { ...HTML, reply_markup: summaryKeyboard('gold') }));
bot.command(['nasdaq', 'nas100', 'nas'], (ctx) => ctx.reply(portfolio(cfg, store, 'nas100'), { ...HTML, reply_markup: summaryKeyboard('nas100') }));
bot.command(['sp500', 'spx', 'us500'], (ctx) => ctx.reply(portfolio(cfg, store, 'spx'), { ...HTML, reply_markup: summaryKeyboard('spx') }));
bot.command(['eurusd', 'eur', 'euro'], (ctx) => ctx.reply(portfolio(cfg, store, 'eurusd'), { ...HTML, reply_markup: summaryKeyboard('eurusd') }));

bot.command('portfolio', async (ctx) => {
  for (const m of activeMarkets(cfg)) await replyImage(ctx, async () => liveChart(store, cfg, m.id), `⏳ Graphique ${m.emoji} ${m.name}…`);
});

bot.command('historique', (ctx) => {
  const args = ctx.match.trim().toLowerCase().split(/\s+/);
  const marketId = marketArg(ctx.match);
  const minYear = marketId === 'nas100' ? 1987 : 2001;
  const asked = Number(args.find((a) => /^\d{4}$/.test(a)));
  const year = Math.min(Math.max(asked || (marketId === 'nas100' ? 2010 : 2021), minYear), new Date().getUTCFullYear() - 1);
  const m = marketById(cfg, marketId);
  return replyImage(ctx, () => historyChart(cfg, { marketId, fromYear: year }), `⏳ ${m.emoji} ${m.name} : simulation depuis ${year} (le premier appel télécharge l’historique, jusqu’à ~1 min)…`);
});

bot.command('strategies', (ctx) =>
  ctx.reply(
    activeMarkets(cfg)
      .map((m) => `<b>${m.emoji} ${esc(m.name)}</b>\n\n` + selectStrategies(m.strategies)
        .map((s) => `<b>${esc(s.name)}</b> (<code>${s.id}</code> · bougies ${s.tf || '1h'})\n${esc(s.desc)}`)
        .join('\n\n'))
      .join('\n\n———\n\n')
      .slice(0, 4000),
    HTML,
  ),
);

/* ---------- Jeu ---------- */

bot.command('ftmo', async (ctx) => {
  try {
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, { view: 'f', marketId: marketArg(ctx.match) });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
});

bot.command('jeu', (ctx) => ctx.reply(game.status(), HTML));

bot.command(['classement', 'scores'], async (ctx) => {
  await ctx.replyWithPhoto(new InputFile(game.scoreboardImage(), 'classement.png'), { caption: '🏆 <b>Classement du pronostic</b> · 1 point par bonne réponse', parse_mode: 'HTML' });
});

bot.command('pronostic', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  if (game.load().round) return ctx.reply('Un tour est déjà en cours (/jeu).');
  const ok = await game.open(Date.now()).catch((err) => ctx.reply(`❌ ${explainTelegramError(err)}`));
  if (ok === false) return ctx.reply('❌ Cours indisponibles pour l’instant, réessaie après le prochain passage du bot.');
  return null;
});

/* ---------- Administration ---------- */

bot.command('backtest', async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.match.trim()) || 90, 20), 365);
  const wait = await ctx.reply(`⏳ Backtest des stratégies sur ${days} jours…`);
  try {
    const { hourly: candles, daily } = await fetchBacktestData(days);
    if (candles.length < 250) throw new Error('historique insuffisant');
    const from = candles[0].c;
    const to = candles[candles.length - 1].c;
    const results = selectStrategies(cfg.goldStrategies).map((strategy) => {
      const r = backtest(strategy, candles, { size: cfg.goldSizeUsd, feePct: cfg.goldFeePct, daily });
      if (strategy.id === 'hold' && r.open) r.pnlUsd = cfg.goldSizeUsd * (to / r.open.entry - 1);
      return { strategy, r };
    });
    const txt = backtestMessage(results, { days, from, to, buyHold: (to / from - 1) * 100 }, cfg);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, txt, HTML);
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Backtest impossible : ${esc(err.message)}`);
  }
});

bot.command('bilan', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  try {
    for (const m of activeMarkets(cfg)) await channel.sendText(portfolio(cfg, store, m.id), { reply_markup: summaryKeyboard(m.id) });
    channel.markSummary();
    await ctx.reply('✅ Bilan publié sur le canal.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('testcanal', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  try {
    await channel.sendText('✅ <b>Test</b> : le bot de paper trading (or + Nasdaq 100) peut publier ici.');
    await ctx.reply('✅ Message de test publié sur le canal.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('settings', (ctx) =>
  ctx.reply(
    [
      '<b>⚙️ Paramètres</b>',
      ...activeMarkets(cfg).map((m) =>
        `${m.emoji} ${esc(m.name)} : ${selectStrategies(m.strategies).map((s) => s.id).join(', ')} · $${m.startCapital} au départ, ${m.positionPct} % du capital par trade · frais ${m.feePct} %/côté${m.financingPct ? ` · financement ${m.financingPct} %/an` : ''}`),
      `Vérification toutes les ${cfg.checkIntervalMin} min`,
      `Bilan sur le canal : ${cfg.summaryHours > 0 ? `toutes les ${cfg.summaryHours} h` : 'désactivé'} · graphique : ${cfg.chartHours > 0 ? `toutes les ${cfg.chartHours} h` : 'désactivé'}`,
      `Jeu : ${cfg.gameEnabled ? `chaque jour de semaine à ${cfg.gameHourUtc} h UTC, ${cfg.gameVoteHours} h pour voter` : 'désactivé'}`,
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
    { command: 'menu', description: '🎛 Panneau interactif (Nasdaq ; /menu or pour l’or)' },
    { command: 'graphique', description: '🕯 Cours en bougies : /graphique (Nasdaq) · /graphique or' },
    { command: 'ftmo', description: '🏦 Comptes FTMO simulés : /ftmo (Nasdaq) · /ftmo or' },
    { command: 'jeu', description: '🎯 Pronostic du jour' },
    { command: 'classement', description: '🏆 Classement des joueurs' },
    { command: 'nasdaq', description: 'Bilan du Nasdaq 100' },
    { command: 'sp500', description: 'Bilan du S&P 500' },
    { command: 'eurusd', description: 'Bilan de l’EUR/USD (à l’essai)' },
    { command: 'gold', description: 'Bilan de l’or' },
    { command: 'portfolio', description: 'Graphiques de l’évolution des portefeuilles' },
    { command: 'historique', description: 'Simulation : /historique 2010 (Nasdaq) · /historique or 2001' },
    { command: 'strategies', description: 'Comment fonctionne chaque stratégie' },
  ]);
  // Bouton du menu Telegram : liste des commandes (remplace l'ancien bouton « 📊 App »)
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {});
  await channel.check();

  // Stratégies de scalp (bougies 1 / 5 min) actives : vérification chaque minute pour entrer à la clôture de la bougie
  const { tfOf } = require('./src/strategies');
  const scalp = activeMarkets(cfg).some((m) => selectStrategies(m.strategies).some((s) => ['1m', '5m', '15m'].includes(tfOf(s))));
  const every = scalp ? Math.min(cfg.checkIntervalMin, 1) : cfg.checkIntervalMin;
  tick();
  setInterval(tick, every * 60_000);

  bot.start({ onStart: (me) => console.log(`Bot @${me.username} démarré.`) });
})().catch((err) => {
  console.error(`❌ Démarrage impossible : ${explainTelegramError(err)}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => bot.stop().then(() => process.exit(0)));
