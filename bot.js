/**
 * bot.js — Bot Telegram de paper trading de l'or (plusieurs stratégies, simulation uniquement)
 *
 * Commandes :
 *   /start          — aide
 *   /gold           — bilan de chaque stratégie
 *   /portfolio      — graphique de l'évolution du portefeuille (gains réinvestis)
 *   /historique [a] — simulation des stratégies actives depuis l'année a (2021 par défaut)
 *   /strategies     — description des stratégies
 *   /backtest [j]   — backtest des stratégies sur l'historique
 *   /bilan          — publie le bilan sur le canal
 *   /testcanal      — vérifie la publication sur le canal
 *   /app            — mini-app de suivi (page web servie par le bot)
 *   /settings       — paramètres actifs
 *   /pause, /resume — coupe / relance les publications sur le canal
 */
const cfg = require('./src/config');
const { Bot } = require('grammy');
const { Store } = require('./src/store');
const { backtest, fetchBacktestData } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');
const { backtestMessage, esc } = require('./src/format');
const { createChannel, explainTelegramError, HTML } = require('./src/channel');
const { runCycle, portfolio } = require('./src/cycle');
const { liveChart, historyChart } = require('./src/portfolio');
const { activeMarkets, marketById } = require('./src/markets');
const { InputFile } = require('grammy');
const { startWeb } = require('./src/web');

if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant (voir .env.example)');

const bot = new Bot(cfg.telegramToken);
const store = new Store(cfg.dataDir);
const channel = createChannel(bot.api, cfg, store);

let paused = false;
let appUrl = null; // adresse publique de la mini-app
let running = null; // évite deux passages simultanés

/* ------------------------------------------------------------------ */
/* Passage périodique                                                  */
/* ------------------------------------------------------------------ */

function tick() {
  if (!running) {
    running = runCycle({ cfg, store, channel, publish: !paused })
      .then((out) => {
        console.log(`[${new Date().toISOString()}] événements : ${Object.entries(out.byMarket).map(([m, n]) => `${m} ${n}`).join(" · ") || "aucun marché actif"}`);
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
      '<b>📊 Paper trading : 🥇 or + 🇺🇸 Nasdaq 100</b>',
      '',
      ...activeMarkets(cfg).map((m) => `${m.emoji} ${m.name} : ${selectStrategies(m.strategies).length} stratégies, $${m.startCapital} chacune au départ, gains réinvestis`),
      'Chaque entrée / sortie est publiée sur le canal. <b>Simulation</b> : aucun argent réel.',
      '',
      '/gold — bilan de l’or',
      '/nasdaq — bilan du Nasdaq 100',
      '/app — 📱 mini-app pour suivre les stratégies',
      '/portfolio — graphiques de l’évolution des portefeuilles',
      '/historique [or|nasdaq] [année] — simulation sur l’historique (gains réinvestis)',
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

bot.command(['gold', 'paper', 'or'], (ctx) => ctx.reply(portfolio(cfg, store, 'gold'), HTML));
bot.command(['nasdaq', 'nas100', 'nas'], (ctx) => ctx.reply(portfolio(cfg, store, 'nas100'), HTML));

/** Envoie un graphique PNG en réponse (ou un message d'erreur). */
async function replyChart(ctx, build, waitText) {
  const wait = await ctx.reply(waitText);
  try {
    const { png, caption, details } = await build();
    await ctx.replyWithPhoto(new InputFile(png, 'portefeuille.png'), { caption, parse_mode: 'HTML' });
    if (details) await ctx.reply(details.slice(0, 4096), HTML);
    await ctx.api.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Graphique impossible : ${esc(err.message)}`);
  }
}

bot.command('portfolio', async (ctx) => {
  for (const m of activeMarkets(cfg)) await replyChart(ctx, async () => liveChart(store, cfg, m.id), `⏳ Graphique ${m.emoji} ${m.name}…`);
});

bot.command('historique', (ctx) => {
  const args = ctx.match.trim().toLowerCase().split(/\s+/);
  const marketId = args.some((a) => a.startsWith('nas')) ? 'nas100' : 'gold';
  const minYear = marketId === 'nas100' ? 1987 : 2001;
  const asked = Number(args.find((a) => /^\d{4}$/.test(a)));
  const year = Math.min(Math.max(asked || (marketId === 'nas100' ? 2010 : 2021), minYear), new Date().getUTCFullYear() - 1);
  const m = marketById(cfg, marketId);
  return replyChart(ctx, () => historyChart(cfg, { marketId, fromYear: year }), `⏳ ${m.emoji} ${m.name} : simulation depuis ${year} (le premier appel télécharge l’historique, jusqu’à ~1 min)…`);
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
    for (const m of activeMarkets(cfg)) await channel.sendText(portfolio(cfg, store, m.id));
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

/* ------------------------------------------------------------------ */
/* Mini-app                                                            */
/* ------------------------------------------------------------------ */

/** Lien complet de l'app, clé comprise : « http://IP:PORT/?k=… » ou « https://site/bot.html?k=… ». */
function withKey(url) {
  const u = new URL(url.includes('://') ? url : `https://${url}`);
  if (cfg.webToken) u.searchParams.set('k', cfg.webToken);
  return u.toString();
}

bot.command('app', async (ctx) => {
  if (!cfg.webEnabled) return ctx.reply('La mini-app est désactivée (WEB_APP=0 dans le .env).');
  if (!appUrl) return ctx.reply('⏳ La mini-app démarre, réessaie dans quelques secondes. Si ça dure, mets son adresse dans WEB_URL (voir le README).');
  const url = withKey(appUrl);
  const https = url.startsWith('https://');
  // Bouton « mini-app » (s'ouvre DANS Telegram) : HTTPS et conversation privée uniquement ; sinon lien classique
  const button = https && ctx.chat.type === 'private' ? { text: '📊 Ouvrir l’app', web_app: { url } } : { text: '📊 Ouvrir l’app', url };
  return ctx.reply(
    [
      '<b>📱 Mini-app de suivi</b>',
      'Portefeuilles en direct, positions ouvertes, historique des trades, simulation sur l’historique et catalogue de toutes les stratégies.',
      '',
      https ? '' : '<i>Adresse en http : elle s’ouvre dans le navigateur. Pour l’ouvrir dans Telegram, il faut une adresse https (WEB_TUNNEL=1, voir le README).</i>',
      `<code>${esc(url)}</code>`,
    ].filter(Boolean).join('\n'),
    { ...HTML, reply_markup: { inline_keyboard: [[button]] }, link_preview_options: { is_disabled: true } },
  );
});

/** Adresse directe du bot (IP publique du serveur + port) : celle à mettre dans BOT_API_URL côté Vercel. */
async function guessDirectUrl() {
  let ip = process.env.SERVER_IP && process.env.SERVER_IP !== '0.0.0.0' ? process.env.SERVER_IP : null;
  if (!ip) {
    ip = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  }
  return ip && /^[\d.]+$/.test(ip.trim()) ? `http://${ip.trim()}:${cfg.webPort}` : null;
}

/** Bouton du menu Telegram (à gauche du champ de saisie) qui ouvre la mini-app — HTTPS obligatoire. */
async function setMenuButton(url) {
  if (!url.startsWith('https://')) return;
  await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: '📊 App', web_app: { url: withKey(url) } } })
    .then(() => console.log(`Mini-app dans le menu Telegram : ${url}`))
    .catch((err) => console.warn('[app] bouton du menu :', err.message));
}

async function startApp() {
  if (!cfg.webEnabled) return;
  startWeb({ cfg, store });
  if (cfg.webTunnel && !cfg.webUrl) {
    const { startTunnel } = require('./src/tunnel');
    startTunnel({
      port: cfg.webPort,
      dataDir: cfg.dataDir,
      onUrl: async (url) => {
        appUrl = url;
        await setMenuButton(url);
      },
    }).catch((err) => console.warn(`[tunnel] impossible : ${err.message} — lien http utilisé à la place`));
  }
  const direct = await guessDirectUrl();
  if (direct) console.log(`API du bot : ${direct} → à mettre dans BOT_API_URL (Vercel → Settings → Environment Variables)`);
  if (!appUrl) appUrl = cfg.webUrl || direct;
  if (appUrl) {
    console.log(`Mini-app : ${appUrl} (commande /app)`);
    await setMenuButton(appUrl);
  }
}

bot.command('settings', (ctx) =>
  ctx.reply(
    [
      '<b>⚙️ Paramètres</b>',
      ...activeMarkets(cfg).map((m) =>
        `${m.emoji} ${esc(m.name)} : ${selectStrategies(m.strategies).map((s) => s.id).join(', ')} · $${m.startCapital} au départ, ${m.positionPct} % du capital par trade · frais ${m.feePct} %/côté${m.financingPct ? ` · financement ${m.financingPct} %/an` : ''}`),
      `Vérification toutes les ${cfg.checkIntervalMin} min`,
      `Bilan sur le canal : ${cfg.summaryHours > 0 ? `toutes les ${cfg.summaryHours} h` : 'désactivé'}`,
      `Canal : ${cfg.channelId ? esc(cfg.channelId) : 'non défini'} · publications ${paused ? '⏸ en pause' : '▶️ actives'}`,
      `Mini-app : ${cfg.webEnabled ? (appUrl ? esc(appUrl) : `port ${cfg.webPort}`) : 'désactivée'}`,
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
    { command: 'gold', description: 'Bilan de l’or' },
    { command: 'nasdaq', description: 'Bilan du Nasdaq 100' },
    { command: 'app', description: '📱 Mini-app pour suivre les stratégies' },
    { command: 'portfolio', description: 'Graphiques de l’évolution des portefeuilles' },
    { command: 'historique', description: 'Simulation : /historique or 2021 · /historique nasdaq 2010' },
    { command: 'strategies', description: 'Comment fonctionne chaque stratégie' },
    { command: 'backtest', description: 'Tester les stratégies : /backtest 90' },
    { command: 'bilan', description: 'Publier le bilan sur le canal' },
    { command: 'testcanal', description: 'Tester la publication sur le canal' },
    { command: 'settings', description: 'Paramètres actifs' },
    { command: 'pause', description: 'Mettre les publications en pause' },
    { command: 'resume', description: 'Relancer les publications' },
  ]);
  await channel.check();
  await startApp().catch((err) => console.warn('[app]', err.message));

  tick();
  setInterval(tick, cfg.checkIntervalMin * 60_000);

  bot.start({ onStart: (me) => console.log(`Bot @${me.username} démarré.`) });
})().catch((err) => {
  console.error(`❌ Démarrage impossible : ${explainTelegramError(err)}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => bot.stop().then(() => process.exit(0)));
