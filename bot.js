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
const channel = createChannel(bot.api, cfg, store, {
  onError: async (err) => {
    if (Date.now() - lastAlert < 3_600_000) return;
    lastAlert = Date.now();
    for (const id of cfg.allowedUserIds) {
      await bot.api.sendMessage(id, `⚠️ <b>Le bot n’arrive pas à envoyer dans le groupe</b>\n${esc(explainTelegramError(err))}\nTeste avec /testcanal.`, { parse_mode: 'HTML' }).catch(() => {});
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

const ADMIN = new Set(['bilan', 'testcanal', 'settings', 'pause', 'resume', 'backtest', 'pronostic', 'verif', 'adapt', 'export', 'video', 'fonds', 'signature', 'financer']);
const isAdmin = (ctx) => !cfg.allowedUserIds.size || (ctx.from && cfg.allowedUserIds.has(String(ctx.from.id)));

// Les boutons et les commandes de consultation sont ouverts à tout le groupe ; les réglages sont réservés.
bot.use(async (ctx, next) => {
  const cmd = ctx.message?.text?.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();
  if (cmd && ADMIN.has(cmd) && !isAdmin(ctx)) return ctx.reply('Commande réservée à l’administrateur du bot.');
  return next();
});

// Vidéos PnL (/video, /fond, /fonds) : boutons « v:… », enregistrés avant le panneau interactif
require('./src/videoBot').attachVideo(bot, { cfg, store, isAdmin });
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
      '/lucid — 🟣 compte Lucid simulé (LucidFlex : +6 %, pas de perte du jour, micro-futures)',
      '/interface — 🖥 interface en direct sur le site (graphiques, SL / TP, comptes FTMO et Lucid)',
      '/version — version du bot en service (à vérifier après un redémarrage)',
      '/export — 📦 (admin) fichier des statistiques du bot, à envoyer à Claude pour une analyse',
      '🎬 Envoie une vidéo au bot (en privé) : il te demande le trade et te la renvoie avec la PnL card transparente par-dessus (admin) · /video : fond intégré · /fond, /fonds · /signature @nom',
      '/jeu — 🎯 pronostic du jour · /classement — points des joueurs',
      '/nasdaq · /gold — bilan texte',
      '/portfolio — graphiques des portefeuilles',
      '/historique [nasdaq|or|sp500|eur|ftmo] — historique des trades pris par le bot',
      '/simulation [nasdaq|or] [année] — simulation des stratégies sur l’historique des cours',
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
  for (const m of activeMarkets(cfg)) await replyImage(ctx, async () => liveChart(store, cfg, m.id), `⏳ Graphique ${m.emoji} ${m.name}…`);
});

// Historique des trades réellement pris (paper trading en direct) ; « /historique ftmo » : trades du compte FTMO
bot.command(['historique', 'trades'], async (ctx) => {
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
    await ctx.replyWithDocument(new InputFile(Buffer.from(data, 'utf8'), name), { caption: `📦 Statistiques du bot (version ${version()}, ${(data.length / 1024).toFixed(0)} Ko) — envoie ce fichier à Claude pour l’analyse` });
  } catch (err) {
    await ctx.reply(`❌ Export impossible : ${esc(err.message)}`);
  }
});

// Interface en direct sur le site (catégorie « Bot ») : graphiques avec entrée / SL / TP, comptes FTMO et Lucid
bot.command(['interface', 'site'], (ctx) => ctx.reply(`🖥 <b>Interface en direct du bot</b>\n${cfg.siteUrl}/#bot\nGraphiques TradingView avec les trades en cours (entrée, SL, TP), comptes FTMO et Lucid simulés, historique des trades.`, { ...HTML, reply_markup: { inline_keyboard: [[{ text: '🖥 Ouvrir l’interface', url: `${cfg.siteUrl}/#bot` }]] } }));

// Version déployée et réglages clés : pour vérifier après un redémarrage que Bot-Hosting a pris la nouvelle version
bot.command('version', (ctx) => {
  const lucid = require('./src/ftmoAccount').accountOf(cfg, 'lucid');
  return ctx.reply([
    `🔖 Version <code>${version()}</code> · Node ${process.version}`,
    `🏦 Compte FTMO : ${cfg.ftmoEnabled ? 'actif' : 'coupé'} · 🟣 compte Lucid : ${lucid.enabled ? `actif (${lucid.label})` : 'coupé (LUCID=0)'}`,
    `🤖 IA validatrice : ${cfg.ftmoAi} · 🧠 adaptation : ${cfg.autoAdapt ? `IA qui apprend${cfg.adaptStrategies ? ' + stratégies' : ''}` : 'coupée'} · risque : ${esc(cfg.ftmoSizing)}`,
    esc(channel.status()),
    `📣 Achats / ventes FTMO et Lucid annoncés dans le groupe : ${cfg.ftmoTradeMessages === false ? 'non (FTMO_TRADE_MESSAGES=0)' : paused ? 'en pause (/resume)' : 'oui'}`,
  ].join('\n'), HTML);
});

bot.command('verif', (ctx) => ctx.reply(require('./src/verify').verifyReport(cfg, store), HTML));

// Passage forcé en compte financé (admin) : /financer (FTMO et Lucid), /financer ftmo, /financer lucid
bot.command('timemachine', async (ctx) => {
  await ctx.reply('🔮 Simulation de 1 000 années en cours…');
  return ctx.reply(require('./src/timeMachine').report(cfg, store), HTML);
});

bot.command('financer', (ctx) => ctx.reply(require('./src/ftmoAccount').financerReport(cfg, store, ctx.match), HTML));

// Adaptation automatique (admin) : /adapt (état), /adapt now (revue tout de suite), /adapt reset (retour à l'origine)
bot.command('adapt', async (ctx) => {
  const ad = require('./src/adapt');
  if (!cfg.autoAdapt) return ctx.reply('Adaptation automatique désactivée (AUTO_ADAPT=0 dans le .env).');
  const arg = (ctx.match || '').trim().toLowerCase();
  if (arg === 'reset') {
    ad.reset(cfg, store);
    return ctx.reply('🧠 Adaptation remise à zéro : IA d’origine, tous les poids à × 1, aucune candidate promue.');
  }
  if (arg === 'now') return ctx.reply(ad.weeklyReview(cfg, store).text, HTML);
  const st = ad.loadState(store);
  const w = Object.entries(st.weights || {}).filter(([, v]) => v !== 1).map(([k, v]) => `• <code>${esc(k)}</code> ${v === 0 ? 'suspendue' : `× ${String(v).replace('.', ',')}`}`);
  const n = store.loadJson('ai-samples.json', []).length;
  return ctx.reply([ad.summary(cfg, store), `Signaux jugés mémorisés : ${n}`, ...(w.length ? ['Poids appris :', ...w] : ['Aucun poids modifié pour l’instant.']), (st.promoted || []).length ? `Candidates promues : ${st.promoted.map((k) => `<code>${esc(k)}</code>`).join(', ')}` : '', `Candidates en observation : ${cfg.adaptCandidates.map((k) => `<code>${esc(k)}</code>`).join(', ')}`].filter(Boolean).join('\n').slice(0, 4000), HTML);
});

// Simulation des stratégies sur l'historique des cours (ex-« /historique »)
bot.command('simulation', (ctx) => {
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

// Compte Lucid simulé (LucidFlex, micro-futures) : mêmes signaux que le compte FTMO, règles Lucid
bot.command('lucid', async (ctx) => {
  try {
    if (!require('./src/ftmoAccount').accountOf(cfg, 'lucid').enabled) return ctx.reply('Le compte Lucid simulé est désactivé (LUCID=0 dans le .env).');
    await sendPanel(ctx.api, ctx.chat.id, cfg, store, { view: 'f', marketId: 'gold', args: ['l'] });
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
  return null;
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
    await channel.sendText('✅ <b>Test</b> : le bot peut publier ici (achats / ventes des comptes FTMO et Lucid).');
    await ctx.reply(`✅ Message de test publié sur le groupe.\n${esc(channel.status())}${paused ? '\n⏸ Publications en pause : /resume pour les relancer.' : ''}${cfg.ftmoTradeMessages === false ? '\n⚠️ FTMO_TRADE_MESSAGES=0 : les trades ne sont pas annoncés.' : ''}`);
  } catch (err) {
    await ctx.reply(`❌ ${esc(explainTelegramError(err))}\n${esc(channel.status())}`);
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

/** Version déployée (commit git si le dossier .git est là). */
function version() {
  try {
    const fs = require('fs');
    const head = fs.readFileSync(require('path').join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(require('path').join(__dirname, '.git', ref), 'utf8').trim() : head;
    return sha.slice(0, 7);
  } catch {
    return 'inconnue';
  }
}

/** Appel Telegram du démarrage, limité dans le temps (le bot ne reste jamais bloqué en silence). */
const step = (label, p, ms = 20_000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} : pas de réponse de Telegram après ${ms / 1000} s`)), ms))]);

console.log(`Démarrage du bot (version ${version()}, Node ${process.version}) · IA validatrice : ${cfg.ftmoAi} · risque : ${cfg.ftmoSizing}`);

(async () => {
  console.log('… connexion à Telegram');
  await step('commandes du menu', bot.api.setMyCommands([
    { command: 'menu', description: '🎛 Panneau interactif (Nasdaq ; /menu or pour l’or)' },
    { command: 'graphique', description: '🕯 Cours en bougies : /graphique (Nasdaq) · /graphique or' },
    { command: 'ftmo', description: '🏦 Comptes FTMO simulés : /ftmo (Nasdaq) · /ftmo or' },
    { command: 'lucid', description: '🟣 Compte Lucid simulé (LucidFlex, micro-futures)' },
    { command: 'timemachine', description: '🔮 Chances de réussir le challenge en cours (1 000 années simulées)' },
    { command: 'financer', description: '🏦 Passer les comptes simulés en compte financé (admin)' },
    { command: 'interface', description: '🖥 Interface en direct (graphiques, comptes FTMO / Lucid)' },
    { command: 'video', description: '🎬 Vidéo PnL d’un trade (fond au choix)' },
    { command: 'version', description: '🔖 Version du bot en service' },
    { command: 'jeu', description: '🎯 Pronostic du jour' },
    { command: 'classement', description: '🏆 Classement des joueurs' },
    { command: 'nasdaq', description: 'Bilan du Nasdaq 100' },
    { command: 'sp500', description: 'Bilan du S&P 500' },
    { command: 'eurusd', description: 'Bilan de l’EUR/USD (à l’essai)' },
    { command: 'gold', description: 'Bilan de l’or' },
    { command: 'portfolio', description: 'Graphiques de l’évolution des portefeuilles' },
    { command: 'historique', description: 'Historique des trades : /historique or · /historique ftmo' },
    { command: 'simulation', description: 'Simulation : /simulation 2010 (Nasdaq) · /simulation or 2001' },
    { command: 'strategies', description: 'Comment fonctionne chaque stratégie' },
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
