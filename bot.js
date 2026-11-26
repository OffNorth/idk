/**
 * bot.js — Bot Telegram de paper trading (or + Nasdaq 100, plusieurs stratégies, simulation uniquement)
 *
 * Pour tout le groupe :
 *   /menu            — panneau interactif : une image qui change avec les boutons
 *                      (portefeuille, classement, positions, cours, historique, fiches des stratégies)
 *   /graphique [or|nasdaq] — cours en bougies
 *   /jeu, /classement — pronostic du jour (hausse / baisse) et classement des joueurs
 *   /gold, /nasdaq   — bilan texte · /portfolio · /historique [or|nasdaq|ftmo] (trades) · /simulation [marché] [année] · /strategies
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
// Échec d'envoi au groupe : message privé aux administrateurs (ALLOWED_USER_IDS), au plus une fois par heure
let lastAlert = 0;
/** Admins qui reçoivent les copies en privé : ALLOWED_TELEGRAM_USER_IDS, sinon la 1re personne qui a écrit /start en privé. */
const dmTargets = () => (cfg.allowedUserIds.size ? [...cfg.allowedUserIds] : store.getMeta('firstPrivateUser') ? [String(store.getMeta('firstPrivateUser'))] : []);
const channel = createChannel(bot.api, cfg, store, {
  dm: async ({ text, png, caption, extra = {} }) => {
    for (const id of dmTargets()) {
      if (png) await bot.api.sendPhoto(id, new InputFile(png, 'image.png'), { caption, parse_mode: 'HTML', ...extra });
      else await bot.api.sendMessage(id, text, { parse_mode: 'HTML', ...extra });
    }
    store.setMeta('dmLastOk', Date.now());
  },
  onError: async (err) => {
    if (Date.now() - lastAlert < 3_600_000) return;
    lastAlert = Date.now();
    for (const id of dmTargets()) {
      await bot.api.sendMessage(id, `⚠️ <b>The bot can’t post in the group</b>\n${esc(explainTelegramError(err))}\nTest with /testcanal.`, { parse_mode: 'HTML' }).catch(() => {});
    }
  },
});
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

const ADMIN = new Set(['bilan', 'testcanal', 'settings', 'pause', 'resume', 'backtest', 'pronostic', 'verif', 'adapt', 'export', 'video', 'fonds', 'signature', 'financer', 'fund', 'reset']);
const isAdmin = (ctx) => !cfg.allowedUserIds.size || (ctx.from && cfg.allowedUserIds.has(String(ctx.from.id)));

// Les boutons et les commandes de consultation sont ouverts à tout le groupe ; les réglages sont réservés.
bot.use(async (ctx, next) => {
  // 1re personne qui écrit au bot en privé : reçoit les copies des trades si ALLOWED_TELEGRAM_USER_IDS est vide
  if (ctx.chat?.type === 'private' && ctx.from && !store.getMeta('firstPrivateUser')) store.setMeta('firstPrivateUser', ctx.from.id);
  const cmd = (ctx.message?.text ?? ctx.channelPost?.text)?.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();
  if (cmd && ADMIN.has(cmd) && !isAdmin(ctx)) return ctx.reply('Command reserved for the bot admin.');
  return next();
});

// Vidéos PnL (/video, /fond, /fonds) : boutons « v:… », enregistrés avant le panneau interactif
require('./src/videoBot').attachVideo(bot, { cfg, store, isAdmin });
attachInteractive(bot, { cfg, store, gameHandler: (ctx, parts) => game.onVote(ctx, parts) });

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

// Nasdaq par défaut ; « or » / « gold » pour l'or
const marketArg = (text) => (/\b(argent|silver|xag)\b/i.test(text || '') ? 'silver' : /\b(dow|dji|us30)\b/i.test(text || '') ? 'dow' : /\b(russell|rut|us2000|m2k)\b/i.test(text || '') ? 'russell' : /\b(or|gold|xau)\b/i.test(text || '') ? 'gold' : /\b(eur|eurusd|euro)\b/i.test(text || '') ? 'eurusd' : /\b(sp500|spx|s&p|us500)\b/i.test(text || '') ? 'spx' : 'nas100');

bot.command(['start', 'aide', 'help'], (ctx) =>
  ctx.reply(
    [
      '<b>📊 Paper trading: 🇺🇸 Nasdaq 100 (+ 🥇 gold)</b>',
      ...activeMarkets(cfg).map((m) => `${m.emoji} ${m.name}: ${selectStrategies(m.strategies).length} strategies, $${m.startCapital} each at the start, gains reinvested`),
      'Trades are grouped in a summary every evening; /menu to see everything (portfolio, positions, strategy cards…).',
      '',
      '/menu — 🎛 interactive panel (images that change with the buttons)',
      '/chart [nasdaq|gold] — 🕯 candlestick chart (Nasdaq by default)',
      '/ftmo [nasdaq|gold] — 🏦 simulated FTMO accounts',
      '/lucid — 🟣 simulated Lucid account (LucidFlex: +6%, no daily loss limit, micro futures)',
      '/pnl [ftmo|lucid] [days] — 📅 daily PnL of the simulated accounts (realized, unrealized, trades, daily limit, previous days)',
      '/interface — 🖥 live interface on the website (charts, SL / TP, FTMO and Lucid accounts)',
      '/version — bot version in service (check it after a restart)',
      '/export — 📦 (admin) bot statistics file, to send to Claude for analysis',
      '🎬 Send a video to the bot (in private): it asks you for the trade and sends it back with the transparent PnL card on top (admin) · /video: built-in background · /fond, /fonds · /signature @name',
      '/game — 🎯 daily prediction · /leaderboard — player points',
      '/nasdaq · /gold — text report',
      '/portfolio — portfolio charts',
      '/history [nasdaq|gold|sp500|eur|ftmo] — history of the trades taken by the bot',
      '/simulation [nasdaq|gold] [year] — strategy simulation over the price history',
      '/strategies — how each strategy works',
      '',
      '<i>⚠️ Simulation only, no real money. Not financial advice.</i>',
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
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Image failed: ${esc(err.message)}`).catch(() => {});
  }
}

bot.command(['menu', 'panneau'], async (ctx) => {
  try {
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, {
      // Mode « FTMO seul » : le panneau s'ouvre sur le compte FTMO (les autres vues restent dans les boutons)
      ...(cfg.publishFtmoOnly && cfg.ftmoEnabled && !ctx.match.trim() ? { view: 'f', marketId: 'gold' } : { marketId: marketArg(ctx.match) }),
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
  for (const m of activeMarkets(cfg)) await replyImage(ctx, async () => liveChart(store, cfg, m.id), `⏳ Chart ${m.emoji} ${m.name}…`);
});

// Historique des trades réellement pris (paper trading en direct) ; « /historique ftmo » : trades du compte FTMO
bot.command(['historique', 'history', 'trades'], async (ctx) => {
  try {
    const ftmo = /\bftmo\b/i.test(ctx.match || '');
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, {
      view: ftmo ? 'z' : 'y',
      marketId: ftmo ? 'gold' : marketArg(ctx.match),
      args: ['0'],
      extra: ctx.message?.message_thread_id ? { message_thread_id: ctx.message.message_thread_id } : {},
    });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
});

// Vérification de cohérence des trades (paper + compte FTMO), réservée aux admins
// Export des statistiques (admin) : un fichier JSON avec les comptes, trades, refus de l'IA, adaptation
bot.command('export', async (ctx) => {
  try {
    const data = JSON.stringify(require('./src/export').buildExport(cfg, store, version()));
    const name = `stats-bot-${new Date().toISOString().slice(0, 10)}.json`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(data, 'utf8'), name), { caption: `📦 Bot statistics (version ${version()}, ${(data.length / 1024).toFixed(0)} KB) — send this file to Claude for analysis` });
  } catch (err) {
    await ctx.reply(`❌ Export failed: ${esc(err.message)}`);
  }
});

// Interface en direct sur le site (catégorie « Bot ») : graphiques avec entrée / SL / TP, comptes FTMO et Lucid
bot.command(['interface', 'site'], (ctx) => ctx.reply(`🖥 <b>Bot live interface</b>\n${cfg.siteUrl}/#bot\nTradingView charts with the current trades (entry, SL, TP), simulated FTMO and Lucid accounts, trade history.`, { ...HTML, reply_markup: { inline_keyboard: [[{ text: '🖥 Open the interface', url: `${cfg.siteUrl}/#bot` }]] } }));

// Version déployée et réglages clés : pour vérifier après un redémarrage que Bot-Hosting a pris la nouvelle version
bot.command('version', (ctx) => {
  const lucid = require('./src/ftmoAccount').accountOf(cfg, 'lucid');
  return ctx.reply([
    `🔖 Version <code>${version()}</code> · Node ${process.version}`,
    `🏦 FTMO account: ${cfg.ftmoEnabled ? 'on' : 'off'} · 🟣 Lucid account: ${lucid.enabled ? `on (${lucid.label})` : 'off (LUCID=0)'}`,
    `🤖 Validator AI: ${cfg.ftmoAi} · 🧠 adaptation: ${cfg.autoAdapt ? `learning AI${cfg.adaptStrategies ? ' + strategies' : ''}` : 'off'} · risk: ${esc(cfg.ftmoSizing)}`,
    esc(channel.status()),
    `📣 FTMO and Lucid buys / sells posted in the group: ${cfg.ftmoTradeMessages === false ? 'no (FTMO_TRADE_MESSAGES=0)' : paused ? 'paused (/resume)' : 'yes'}`,
  ].join('\n'), HTML);
});

bot.command('verif', (ctx) => ctx.reply(require('./src/verify').verifyReport(cfg, store), HTML));

// Passage forcé en compte financé (admin) : /financer (FTMO et Lucid), /financer ftmo, /financer lucid
bot.command('timemachine', async (ctx) => {
  await ctx.reply('🔮 Simulating 1,000 years…');
  return ctx.reply(require('./src/timeMachine').report(cfg, store), HTML);
});

bot.command(['financer', 'fund'], (ctx) => ctx.reply(require('./src/ftmoAccount').financerReport(cfg, store, ctx.match), HTML));
// Portefeuille perso simulé (50 % monde, 10 % or, 40 % stratégies du bot)
bot.command(['portefeuille', 'myportfolio'], (ctx) => ctx.reply(require('./src/personalPortfolio').report(cfg, store), HTML));
// PnL du jour des comptes simulés : /pnl [ftmo|lucid] [jours]
bot.command(['pnl', 'jour', 'daily'], (ctx) => ctx.reply(require('./src/ftmoAccount').dailyReport(cfg, store, ctx.match), HTML));
// Remise à zéro des comptes simulés en gardant les stats (admin) : /reset, /reset ftmo, /reset lucid (+ « ok » pour confirmer)
bot.command('reset', (ctx) => ctx.reply(require('./src/ftmoAccount').resetReport(cfg, store, ctx.match), HTML));

// Adaptation automatique (admin) : /adapt (état), /adapt now (revue tout de suite), /adapt reset (retour à l'origine)
bot.command('adapt', async (ctx) => {
  const ad = require('./src/adapt');
  if (!cfg.autoAdapt) return ctx.reply('Automatic adaptation is off (AUTO_ADAPT=0 in the .env).');
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg === 'reset') {
    ad.reset(cfg, store);
    return ctx.reply('🧠 Adaptation reset: original AI, all weights at × 1, no candidate promoted.');
  }
  if (arg === 'now') return ctx.reply(ad.weeklyReview(cfg, store).text, HTML);
  const st = ad.loadState(store);
  const w = Object.entries(st.weights || {}).filter(([, v]) => v !== 1).map(([k, v]) => `• <code>${esc(k)}</code> ${v === 0 ? 'suspended' : `× ${v}`}`);
  const n = store.loadJson('ai-samples.json', []).length;
  return ctx.reply([ad.summary(cfg, store), `Judged signals stored: ${n}`, ...(w.length ? ['Learned weights:', ...w] : ['No weight changed yet.']), (st.promoted || []).length ? `Promoted candidates: ${st.promoted.map((k) => `<code>${esc(k)}</code>`).join(', ')}` : '', `Candidates under observation: ${cfg.adaptCandidates.map((k) => `<code>${esc(k)}</code>`).join(', ')}`].filter(Boolean).join('\n').slice(0, 4000), HTML);
});

// Simulation des stratégies sur l'historique des cours (ex-« /historique »)
bot.command('simulation', (ctx) => {
  const args = ctx.match.trim().toLowerCase().split(/\s+/);
  const marketId = marketArg(ctx.match);
  const minYear = marketId === 'nas100' ? 1987 : 2001;
  const asked = Number(args.find((a) => /^\d{4}$/.test(a)));
  const year = Math.min(Math.max(asked || (marketId === 'nas100' ? 2010 : 2021), minYear), new Date().getUTCFullYear() - 1);
  const m = marketById(cfg, marketId);
  return replyImage(ctx, () => historyChart(cfg, { marketId, fromYear: year }), `⏳ ${m.emoji} ${m.name}: simulation since ${year} (the first call downloads the history, up to ~1 min)…`);
});

bot.command('strategies', (ctx) =>
  ctx.reply(
    activeMarkets(cfg)
      .map((m) => `<b>${m.emoji} ${esc(m.name)}</b>\n\n` + selectStrategies(m.strategies)
        .map((s) => `<b>${esc(s.name)}</b> (<code>${s.id}</code> · ${s.tf || '1h'} candles)\n${esc(s.desc)}`)
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

// Compte Lucid simulé (LucidFlex, micro-futures) : mêmes signaux que le compte FTMO, règles Lucid
bot.command('lucid', async (ctx) => {
  try {
    if (!require('./src/ftmoAccount').accountOf(cfg, 'lucid').enabled) return ctx.reply('The simulated Lucid account is off (LUCID=0 in the .env).');
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, { view: 'f', marketId: 'gold', args: [/fund|financ/i.test(ctx.match || '') ? 'lf' : /daily|journ|2/i.test(ctx.match || '') && require('./src/ftmoAccount').accountOf(cfg, 'lucid2').enabled ? 'l2' : 'l'] });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
  return null;
});

bot.command(['jeu', 'game'], (ctx) => ctx.reply(game.status(), HTML));

bot.command(['classement', 'leaderboard', 'scores'], async (ctx) => {
  await ctx.replyWithPhoto(new InputFile(game.scoreboardImage(), 'classement.png'), { caption: '🏆 <b>Prediction leaderboard</b> · 1 point per correct answer', parse_mode: 'HTML' });
});

bot.command('pronostic', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID is not set in the .env.');
  if (game.load().round) return ctx.reply('A round is already running (/game).');
  const ok = await game.open(Date.now()).catch((err) => ctx.reply(`❌ ${explainTelegramError(err)}`));
  if (ok === false) return ctx.reply('❌ Prices unavailable right now, try again after the bot’s next pass.');
  return null;
});

/* ---------- Administration ---------- */

bot.command('backtest', async (ctx) => {
  const days = Math.min(Math.max(Number(ctx.match.trim()) || 90, 20), 365);
  const wait = await ctx.reply(`⏳ Backtesting the strategies over ${days} days…`);
  try {
    const { hourly: candles, daily } = await fetchBacktestData(days);
    if (candles.length < 250) throw new Error('not enough history');
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
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Backtest failed: ${esc(err.message)}`);
  }
});

bot.command('bilan', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID is not set in the .env.');
  try {
    for (const m of activeMarkets(cfg)) await channel.sendText(portfolio(cfg, store, m.id), { reply_markup: summaryKeyboard(m.id) });
    channel.markSummary();
    await ctx.reply('✅ Report posted to the channel.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('testcanal', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID is not set in the .env.');
  try {
    await channel.sendText('✅ <b>Test</b>: the bot can post here (FTMO and Lucid account buys / sells).');
    await ctx.reply(`✅ Test message posted to the group.\n${esc(channel.status())}${paused ? '\n⏸ Posts paused: /resume to restart them.' : ''}${cfg.ftmoTradeMessages === false ? '\n⚠️ FTMO_TRADE_MESSAGES=0: trades are not posted.' : ''}`);
  } catch (err) {
    await ctx.reply(`❌ ${esc(explainTelegramError(err))}\n${esc(channel.status())}`);
  }
});

bot.command('settings', (ctx) =>
  ctx.reply(
    [
      '<b>⚙️ Settings</b>',
      ...activeMarkets(cfg).map((m) =>
        `${m.emoji} ${esc(m.name)}: ${selectStrategies(m.strategies).map((s) => s.id).join(', ')} · $${m.startCapital} at the start, ${m.positionPct}% of capital per trade · fees ${m.feePct}%/side${m.financingPct ? ` · financing ${m.financingPct}%/yr` : ''}`),
      `Check every ${cfg.checkIntervalMin} min`,
      `Channel report: ${cfg.summaryHours > 0 ? `every ${cfg.summaryHours} h` : 'off'} · chart: ${cfg.chartHours > 0 ? `every ${cfg.chartHours} h` : 'off'}`,
      `Game: ${cfg.gameEnabled ? `every weekday at ${cfg.gameHourUtc}:00 UTC, ${cfg.gameVoteHours} h to vote` : 'off'}`,
      `Channel: ${cfg.channelId ? esc(cfg.channelId) : 'not set'} · posts ${paused ? '⏸ paused' : '▶️ on'}`,
    ].join('\n'),
    HTML,
  ),
);

bot.command('pause', (ctx) => {
  paused = true;
  store.setMeta("paused", true);
  return ctx.reply('⏸ Channel posts paused (paper trading continues).');
});

bot.command('resume', (ctx) => {
  paused = false;
  store.setMeta("paused", false);
  return ctx.reply('▶️ Channel posts resumed.');
});

bot.catch((err) => console.error('[bot] erreur :', err.error || err));

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

/** Version déployée (commit git si le dossier .git est là). */
function version() {
  return require('./src/version').version();
}

/** Appel Telegram du démarrage, limité dans le temps (le bot ne reste jamais bloqué en silence). */
const step = (label, p, ms = 20_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} : pas de réponse de Telegram après ${ms / 1000} s`)), ms))]);

// Chargé par la boucle de test (selftest.js) : rien ne démarre, le bot est seulement exporté
module.exports = { bot, store, channel, tick, cfg, game, setPaused: (v) => { paused = !!v; } };

if (require.main === module) start();

function start() {
console.log(`Démarrage du bot (version ${version()}, Node ${process.version}) · IA validatrice : ${cfg.ftmoAi} · risque : ${cfg.ftmoSizing}`);

(async () => {
  console.log('… connexion à Telegram');
  await step('commandes du menu', bot.api.setMyCommands([
    { command: 'menu', description: '🎛 Interactive panel (Nasdaq; /menu gold for gold)' },
    { command: 'chart', description: '🕯 Candlestick chart: /chart (Nasdaq) · /chart gold' },
    { command: 'ftmo', description: '🏦 Simulated FTMO accounts: /ftmo (Nasdaq) · /ftmo gold' },
    { command: 'lucid', description: '🟣 Lucid accounts: /lucid (intraday) · /lucid daily · /lucid funded' },
    { command: 'pnl', description: '📅 Daily PnL: /pnl · /pnl lucid · /pnl 30 (days)' },
    { command: 'myportfolio', description: '💼 Simulated personal portfolio (world, gold, bot strategies)' },
    { command: 'timemachine', description: '🔮 Odds of passing the current challenge (1,000 simulated years)' },
    { command: 'fund', description: '🏦 Switch the simulated accounts to funded (admin)' },
    { command: 'reset', description: '♻️ Reset the simulated accounts, stats kept (admin)' },
    { command: 'interface', description: '🖥 Live interface (charts, FTMO / Lucid accounts)' },
    { command: 'video', description: '🎬 PnL video of a trade (background of your choice)' },
    { command: 'version', description: '🔖 Bot version in service' },
    { command: 'game', description: '🎯 Daily prediction' },
    { command: 'leaderboard', description: '🏆 Player leaderboard' },
    { command: 'nasdaq', description: 'Nasdaq 100 report' },
    { command: 'sp500', description: 'S&P 500 report' },
    { command: 'eurusd', description: 'EUR/USD report (trial)' },
    { command: 'gold', description: 'Gold report' },
    { command: 'portfolio', description: 'Portfolio evolution charts' },
    { command: 'history', description: 'Trade history: /history gold · /history ftmo' },
    { command: 'simulation', description: 'Simulation: /simulation 2010 (Nasdaq) · /simulation gold 2001' },
    { command: 'strategies', description: 'How each strategy works' },
  ])).catch((err) => {
    if (err.error_code === 401) throw err; // token invalide : inutile de continuer
    console.warn(`⚠️ ${err.message} (on continue)`);
  });
  // Bouton du menu Telegram : liste des commandes (remplace l'ancien bouton « 📊 App »)
  await step('bouton du menu', bot.api.setChatMenuButton({ menu_button: { type: 'commands' } })).catch(() => {});
  console.log('… vérification du groupe');
  await step('vérification du groupe', channel.check()).catch((err) => console.warn(`⚠️ ${err.message} (on continue)`));
  console.log('… premier passage sur les marchés (20 à 60 s)');

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
}
