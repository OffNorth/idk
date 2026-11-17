/**
 * bot.js — Bot Telegram de détection de meme coins (MC entre MIN_MARKET_CAP et MAX_MARKET_CAP)
 *
 * Commandes :
 *   /start           — aide
 *   /top             — classement actuel des meilleurs tokens
 *   /check <adresse> — analyse détaillée d'un token (option : /check <adresse> <chaîne>)
 *   /settings        — paramètres actifs
 *   /pause, /resume  — coupe / relance les alertes automatiques sur le canal
 *   /scan            — force un scan + alertes immédiatement
 */
const cfg = require('./src/config');
const { Bot } = require('grammy');
const { Store } = require('./src/store');
const { scan, analyze } = require('./src/scanner');
const { tokenMessage, topMessage, esc } = require('./src/format');
const { fmtUsd } = require('./src/scoring');
const { createChannel, explainTelegramError, HTML } = require('./src/channel');

if (!cfg.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN manquant (voir .env.example)');

const bot = new Bot(cfg.telegramToken);
const store = new Store(cfg.dataDir);

let paused = false;
let lastScan = null; // { at, res }
let running = null; // promesse du scan en cours (évite les scans simultanés)

/* ------------------------------------------------------------------ */
/* Scan + alertes                                                      */
/* ------------------------------------------------------------------ */

function runScan() {
  if (!running) {
    running = scan(cfg, store)
      .then((res) => {
        lastScan = { at: Date.now(), res };
        return res;
      })
      .finally(() => {
        running = null;
      });
  }
  return running;
}

async function getRanking(maxAgeMs = 60_000) {
  if (lastScan && Date.now() - lastScan.at < maxAgeMs) return lastScan.res;
  return runScan();
}

const channel = createChannel(bot.api, cfg, store);

const postAlerts = (res) => (paused ? 0 : channel.postAlerts(res));
const checkChannel = () => channel.check();

/** Résumé périodique du top sur le canal. */
async function postTopSummary() {
  if (!cfg.channelId || paused) return;
  try {
    await channel.postTop(await getRanking(5 * 60_000));
  } catch (err) {
    console.error(`[canal] résumé impossible : ${explainTelegramError(err)}`);
  }
}

async function tick() {
  try {
    const res = await runScan();
    const sent = await postAlerts(res);
    console.log(
      `[${new Date().toISOString()}] ${res.watched} suivis · ${res.inRange} dans la fourchette · ` +
        `${res.ranked.length} retenus · meilleur ${res.ranked[0] ? Math.round(res.ranked[0].result.total) : '-'} · ${sent} alerte(s)`,
    );
    return { res, sent };
  } catch (err) {
    console.error('[scan] échec :', err);
    return null;
  }
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
      '<b>🔎 Scanner de meme coins</b>',
      '',
      `Je surveille les tokens ${esc(cfg.chains.join(', '))} entre <b>${fmtUsd(cfg.minMarketCap)}</b> et <b>${fmtUsd(cfg.maxMarketCap)}</b> de market cap,`,
      'je les filtre (liquidité, volume, sécurité RugCheck…) et je les note sur 100.',
      '',
      '/top — meilleurs tokens en ce moment',
      '/check &lt;adresse&gt; — analyse d’un token',
      '/scan — forcer un scan + alertes',
      '/topcanal — publier le top sur le canal',
      '/testcanal — vérifier que je peux publier sur le canal',
      '/settings — paramètres',
      '/pause · /resume — alertes automatiques du canal',
      '',
      '<i>⚠️ Outil d’aide à la recherche, pas un conseil financier.</i>',
    ].join('\n'),
    HTML,
  ),
);

bot.command('top', async (ctx) => {
  const wait = await ctx.reply('⏳ Scan en cours…');
  try {
    const res = await getRanking();
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, topMessage(res.ranked, res, cfg), HTML);
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Erreur : ${esc(err.message)}`, HTML);
  }
});

bot.command('scan', async (ctx) => {
  const wait = await ctx.reply('⏳ Scan forcé en cours…');
  const out = await tick();
  const txt = out
    ? `✅ Scan terminé : ${out.res.ranked.length} tokens retenus, ${out.sent} alerte(s) publiée(s).` +
      (!cfg.channelId ? '\n(TELEGRAM_CHANNEL_ID non défini : pas d’alertes canal)' : '') +
      (paused ? '\n(alertes en pause)' : '')
    : '❌ Le scan a échoué, voir les logs.';
  await ctx.api.editMessageText(ctx.chat.id, wait.message_id, txt);
});

bot.command('check', async (ctx) => {
  const [address, chainArg] = ctx.match.trim().split(/\s+/);
  if (!address) return ctx.reply('Usage : /check <adresse du token> [chaîne]');
  const chain = (chainArg || cfg.chains[0]).toLowerCase();
  const wait = await ctx.reply('⏳ Analyse…');
  try {
    const a = await analyze(cfg, chain, address);
    let txt;
    if (!a) {
      txt = `❌ Aucune paire trouvée pour ce token sur ${esc(chain)}.`;
    } else {
      txt = tokenMessage(a, { title: '🔬 Analyse' });
      txt += a.reasons.length
        ? `\n\n<b>❌ Ne passe pas les filtres :</b>\n• ${a.reasons.map(esc).join('\n• ')}`
        : '\n\n<b>✅ Passe tous les filtres.</b>';
    }
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, txt, HTML);
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ Erreur : ${esc(err.message)}`, HTML);
  }
});

bot.command('settings', (ctx) =>
  ctx.reply(
    [
      '<b>⚙️ Paramètres</b>',
      `Chaînes : ${esc(cfg.chains.join(', '))}`,
      `Market cap : ${fmtUsd(cfg.minMarketCap)} – ${fmtUsd(cfg.maxMarketCap)}`,
      `Liquidité min : ${fmtUsd(cfg.minLiquidity)} · Volume 24h min : ${fmtUsd(cfg.minVolume24h)}`,
      `Transactions 24h min : ${cfg.minTxns24h}`,
      `Âge de la paire : ${cfg.minAgeHours} h – ${cfg.maxAgeHours} h`,
      `Hausse 24h max : +${cfg.maxPriceChange24h} %`,
      `RugCheck : ${cfg.rugcheckEnabled ? `activé (risque max ${cfg.rugcheckMaxScore}/100)` : 'désactivé'}`,
      '',
      `Scan toutes les ${cfg.scanIntervalMin} min · score min d’alerte ${cfg.minAlertScore}/100`,
      `Max ${cfg.maxAlertsPerScan} alertes / scan · cooldown ${cfg.alertCooldownHours} h`,
      `Résumé du top sur le canal : ${cfg.topSummaryHours > 0 ? `toutes les ${cfg.topSummaryHours} h` : 'désactivé'}`,
      `Canal : ${cfg.channelId ? esc(cfg.channelId) : 'non défini'} · alertes ${paused ? '⏸ en pause' : '▶️ actives'}`,
    ].join('\n'),
    HTML,
  ),
);

bot.command('testcanal', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  try {
    await bot.api.sendMessage(cfg.channelId, '✅ <b>Test</b> : le scanner de meme coins peut publier sur ce canal.', HTML);
    await ctx.reply('✅ Message de test publié sur le canal.');
  } catch (err) {
    await ctx.reply(`❌ ${explainTelegramError(err)}`);
  }
});

bot.command('topcanal', async (ctx) => {
  if (!cfg.channelId) return ctx.reply('❌ TELEGRAM_CHANNEL_ID n’est pas défini dans le .env.');
  const wait = await ctx.reply('⏳ Publication du top sur le canal…');
  try {
    const res = await getRanking();
    await channel.postTop(res);
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, '✅ Top publié sur le canal.');
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, wait.message_id, `❌ ${explainTelegramError(err)}`);
  }
});

bot.command('pause', (ctx) => {
  paused = true;
  return ctx.reply('⏸ Alertes automatiques en pause.');
});

bot.command('resume', (ctx) => {
  paused = false;
  return ctx.reply('▶️ Alertes automatiques relancées.');
});

bot.catch((err) => console.error('[bot] erreur :', err.error || err));

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */

(async () => {
  await bot.api.setMyCommands([
    { command: 'top', description: 'Meilleurs meme coins en ce moment' },
    { command: 'check', description: 'Analyser un token : /check <adresse>' },
    { command: 'scan', description: 'Forcer un scan + alertes' },
    { command: 'topcanal', description: 'Publier le top sur le canal' },
    { command: 'testcanal', description: 'Tester la publication sur le canal' },
    { command: 'settings', description: 'Paramètres actifs' },
    { command: 'pause', description: 'Mettre les alertes en pause' },
    { command: 'resume', description: 'Relancer les alertes' },
  ]);
  await checkChannel();

  tick();
  setInterval(tick, cfg.scanIntervalMin * 60_000);
  if (cfg.topSummaryHours > 0) setInterval(postTopSummary, cfg.topSummaryHours * 3_600_000);

  bot.start({ onStart: (me) => console.log(`Bot @${me.username} démarré.`) });
})().catch((err) => {
  console.error(`❌ Démarrage impossible : ${err?.error_code === 401 ? 'TELEGRAM_BOT_TOKEN invalide (vérifie le token donné par @BotFather).' : explainTelegramError(err)}`);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => bot.stop().then(() => process.exit(0)));
