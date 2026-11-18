/**
 * Boutons sous les messages du groupe (claviers « inline » Telegram) et images à la demande.
 *
 *  - Panneau (/menu, graphique quotidien) : une image dont le contenu change quand on appuie sur les boutons
 *    (portefeuille, classement, positions, cours, historique, fiches des stratégies). Tout le groupe peut l'utiliser.
 *  - Sous chaque ouverture / clôture : carte du trade, cours avec entrée / stop / objectif, fiche de la stratégie.
 *  - Sous le bilan : accès direct aux images.
 *
 * Données des boutons (≤ 64 octets) :
 *   m:<vue>:<marché>[:arg[:arg]]   vue du panneau (h portefeuille, r classement, o positions, c cours, y historique,
 *                                  l liste des stratégies, s fiche, t test d'une stratégie sur l'historique)
 *   x:<action>:<marché>:<id>:<t>   bouton sous un trade (k carte, c cours, s fiche)
 */
const { InputFile } = require('grammy');
const { MarketTrader, marketById, activeMarkets } = require('./markets');
const { selectStrategies } = require('./strategies');
const { liveChart, historyChart, colorize } = require('./portfolio');
const C = require('./cards');
const { esc } = require('./format');
const { VERDICT } = require('./catalog');

const MK = { g: 'gold', n: 'nas100', e: 'eurusd' };
const KM = { gold: 'g', nas100: 'n', eurusd: 'e' };
const YEARS = { gold: [2001, 2010, 2016, 2021], nas100: [1990, 2000, 2010, 2020], eurusd: [2004, 2010, 2016, 2021] };
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
/** Cours : 4 décimales sous 10 (EUR/USD), entier au-delà de 1 000, 2 décimales sinon. */
const quote = (v) => (Math.abs(v) < 10 ? `$${v.toFixed(4)}` : Math.abs(v) >= 1000 ? money(v) : `$${v.toFixed(2)}`);
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;
const PAGE = 6;

/* ------------------------------------------------------------------ */
/* Claviers                                                            */
/* ------------------------------------------------------------------ */

const btn = (text, data) => ({ text, callback_data: data.slice(0, 64) });

/** Clavier du panneau : choix du marché, vues principales, puis rangées propres à la vue. */
function panelKeyboard(cfg, view, marketId, extra = []) {
  const k = KM[marketId];
  const markets = activeMarkets(cfg);
  const rows = [];
  if (markets.length > 1) {
    rows.push(markets.map((m) => btn(`${m.id === marketId ? '• ' : ''}${m.emoji} ${m.id === 'nas100' ? 'Nasdaq' : m.name}`, `m:${view === 's' || view === 't' ? 'h' : view}:${KM[m.id]}`)));
  }
  rows.push([btn('📈 Portefeuille', `m:h:${k}`), btn('🏆 Classement', `m:r:${k}`), btn('📍 Positions', `m:o:${k}`)]);
  rows.push([btn('🕯 Cours', `m:c:${k}:1d`), btn('🕰 Historique', `m:y:${k}`), btn('📚 Stratégies', `m:l:${k}:0`)]);
  if (cfg.ftmoEnabled) rows.push([btn('🏦 FTMO 🇺🇸 Nasdaq', 'm:f:n'), btn('🏦 FTMO 🥇 Or', 'm:f:g')].filter((b) => b.callback_data !== 'm:f:n' || cfg.ftmoNasEnabled));
  return { inline_keyboard: [...extra, ...rows] };
}

/** Boutons sous une ouverture / clôture publiée sur le canal. */
function tradeKeyboard(ev) {
  const k = KM[ev.market.id];
  const t = ev.type === 'open' ? ev.pos.entryT : ev.trade.entryT;
  const id = ev.strategy.id;
  return {
    inline_keyboard: [
      [btn(ev.type === 'open' ? '🧾 Carte du trade' : '🧾 Carte du résultat', `x:k:${k}:${id}:${t}`), btn('🕯 Cours + niveaux', `x:c:${k}:${id}:${t}`)],
      [btn('ℹ️ La stratégie', `x:s:${k}:${id}:${t}`), btn('🎛 Menu', `m:h:${k}`)],
    ],
  };
}

/** Boutons sous le bilan d'un marché. */
function summaryKeyboard(marketId) {
  const k = KM[marketId];
  return {
    inline_keyboard: [
      [btn('📈 Graphique', `m:h:${k}`), btn('🏆 Classement', `m:r:${k}`), btn('📍 Positions', `m:o:${k}`)],
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Données                                                             */
/* ------------------------------------------------------------------ */

const candleCache = new Map();
/** Bougies d'un marché (1d ou 1h), en cache 2 min. */
async function candles(market, tf) {
  const key = `${market.id}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.data;
  const data = await market.fetch([tf]);
  const out = { list: data.series[tf] || [], price: data.price };
  if (out.list.length) candleCache.set(key, { at: Date.now(), data: out });
  return out;
}

function trader(cfg, store, marketId) {
  return new MarketTrader(marketById(cfg, marketId), store, cfg);
}

/** Retrouve un trade (position ouverte ou clôturée) d'une stratégie par sa date d'entrée. */
function findTrade(tr, id, entryT) {
  const acc = tr.state.accounts[id];
  if (!acc) return null;
  if (acc.position && Math.abs(acc.position.entryT - entryT) < 2) return { pos: acc.position };
  const trade = [...acc.closed].reverse().find((t) => Math.abs(t.entryT - entryT) < 2);
  return trade ? { trade } : null;
}

/* ------------------------------------------------------------------ */
/* Vues (image + légende + clavier)                                     */
/* ------------------------------------------------------------------ */

let heavy = Promise.resolve();
/** Calculs lourds (simulation sur l'historique) : un à la fois. */
function queued(fn) {
  const p = heavy.catch(() => {}).then(fn);
  heavy = p;
  return p;
}

async function render(cfg, store, view, marketId, args = []) {
  const market = marketById(cfg, marketId);
  if (!market || !market.enabled) throw new Error('marché inactif');
  const tr = trader(cfg, store, marketId);
  const st = tr.stats();
  const head = `${market.emoji} <b>${esc(market.name)}</b>`;

  if (view === 'f') {
    const { createFtmo } = require('./ftmoAccount');
    const prices = Object.fromEntries(activeMarkets(cfg).map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
    const acct = require('./ftmoAccount').accountOf(cfg, marketId);
    const fst = createFtmo({ cfg, store, account: acct.enabled ? marketId : 'gold' }).status(prices);
    const s = fst.s;
    const lines = [
      `🏦 <b>Compte FTMO simulé ${fst.account.emoji} ${fst.account.label}</b> · ${s.phase === 'funded' ? 'compte financé' : `étape ${s.phase} sur 2`} · challenge n° ${s.attempt}`,
      `Valeur <b>${money(fst.equity)}</b> (${pct((fst.equity / s.capital - 1) * 100)})${fst.target ? ` · objectif ${money(fst.target)}` : ''}`,
      `Stratégies suivies : ${fst.account.strategies.map((x) => `<code>${esc(x.split(':')[1])}</code>`).join(', ')} · risque ${fst.account.risk} % par trade${fst.account.id === 'nas100' ? ' · <i>à l’essai : rien n’est validé pour le challenge sur le Nasdaq</i>' : ''}`,
      ...(s.history || []).slice(-3).map((h) => `• challenge n° ${h.attempt}, étape ${h.phase} : ${esc(h.outcome)}${h.why ? ` (${esc(h.why)})` : ''}`),
    ];
    return { png: C.ftmoImage(fst), caption: lines.join('\n').slice(0, 1024), keyboard: panelKeyboard(cfg, 'f', marketId) };
  }

  if (view === 'h') {
    const { png } = liveChart(store, cfg, marketId);
    const strat = st.rows.filter((r) => r.strategy.id !== 'hold');
    const total = strat.reduce((s, r) => s + r.equity, 0);
    const best = [...strat].sort((a, b) => b.returnPct - a.returnPct)[0];
    const caption = [
      `${head} · portefeuille <b>${money(total)}</b> (${pct((total / (market.startCapital * strat.length) - 1) * 100)})`,
      best ? `En tête : ${esc(best.strategy.name)} (${pct(best.returnPct)})` : '',
      '<i>Paper trading, argent fictif. Touchez les boutons pour changer de vue.</i>',
    ].filter(Boolean).join('\n');
    return { png, caption, keyboard: panelKeyboard(cfg, 'h', marketId) };
  }

  if (view === 'r') {
    const colors = colorize(st.rows.map((r) => r.strategy));
    const rows = st.rows.map((r, k) => ({ r, color: colors[k] })).sort((a, b) => b.r.returnPct - a.r.returnPct)
      .map(({ r, color }) => ({ label: r.strategy.name, value: r.returnPct, text: pct(r.returnPct), rgb: color.rgb, badge: r.position ? (r.position.side === 'long' ? '▲' : '▼') : '' }));
    const png = C.rankingImage({ market, title: 'Classement des stratégies', subtitle: `Valeur de chaque compte depuis le lancement · gains réinvestis · ▲ = en position`, rows, minScale: 5 });
    const top = rows.slice(0, 3).map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${esc(r.label)} ${r.text}`).join('\n');
    return { png, caption: `${head} · 🏆 classement\n${top}`, keyboard: panelKeyboard(cfg, 'r', marketId) };
  }

  if (view === 'o') {
    const open = st.rows.filter((r) => r.position);
    const png = C.positionsImage({ market, rows: open, price: st.price });
    return { png, caption: `${head} · 📍 ${open.length} position${open.length > 1 ? 's' : ''} ouverte${open.length > 1 ? 's' : ''} · cours ${st.price ? quote(st.price) : 'n/d'}`, keyboard: panelKeyboard(cfg, 'o', marketId) };
  }

  if (view === 'c') {
    const tf = args[0] === '1h' ? '1h' : '1d';
    const { list, price } = await candles(market, tf);
    const shown = list.slice(tf === '1d' ? -120 : -96);
    const last = shown[shown.length - 1];
    const first = shown[0];
    const chg = last && first ? (last.c / first.c - 1) * 100 : 0;
    const png = C.priceChartImage({
      market,
      candles: shown,
      title: `${market.name} · ${price ? quote(price) : ''}`,
      subtitle: `Bougies ${tf === '1d' ? '1 jour · 120 derniers jours' : '1 heure · 4 derniers jours'} · ${pct(chg)} sur la période`,
      levels: price ? [{ price, label: 'Cours', rgb: [124, 196, 255] }] : [],
    });
    const extra = [[btn(`${tf === '1d' ? '• ' : ''}Bougies 1 jour`, `m:c:${KM[marketId]}:1d`), btn(`${tf === '1h' ? '• ' : ''}Bougies 1 heure`, `m:c:${KM[marketId]}:1h`)]];
    return { png, caption: `${head} · 🕯 cours ${price ? `<b>${quote(price)}</b>` : 'n/d'} (${pct(chg)} sur la période)`, keyboard: panelKeyboard(cfg, 'c', marketId, extra) };
  }

  if (view === 'y' || view === 't') {
    const id = view === 't' ? args[0] : null;
    const year = Number(view === 't' ? args[1] : args[0]) || (marketId === 'nas100' ? 2010 : 2021);
    const out = await queued(() => historyChart(cfg, { marketId, fromYear: year, ids: id ? [id, 'hold'] : null }));
    const lines = out.results.slice(0, 6).map(({ s, stats }) => `${esc(s.name)} : <b>${pct(stats.perYear)}/an</b>`);
    const yearsRow = YEARS[marketId].map((y) => btn(`${y === year ? '• ' : ''}${y}`, id ? `m:t:${KM[marketId]}:${id}:${y}` : `m:y:${KM[marketId]}:${y}`));
    const extra = id ? [yearsRow, [btn('⬅️ Retour à la fiche', `m:s:${KM[marketId]}:${id}`)]] : [yearsRow];
    return {
      png: out.png,
      caption: `${head} · 🕰 ${id ? 'test sur l’historique' : 'historique simulé'} depuis ${year} (gains réinvestis, frais inclus)\n${lines.join('\n')}\n<i>Résultats passés ≠ résultats futurs.</i>`.slice(0, 1024),
      keyboard: panelKeyboard(cfg, view, marketId, extra),
    };
  }

  if (view === 'l') {
    const list = selectStrategies(market.strategies);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const page = Math.min(Math.max(Number(args[0]) || 0, 0), pages - 1);
    const colors = colorize(st.rows.map((r) => r.strategy));
    const rows = st.rows.map((r, k) => ({ label: r.strategy.name, value: r.returnPct, text: pct(r.returnPct), rgb: colors[k].rgb }));
    const png = C.rankingImage({ market, title: `${list.length} stratégies actives`, subtitle: 'Touchez une stratégie pour voir sa fiche', rows, minScale: 5 });
    const items = list.slice(page * PAGE, page * PAGE + PAGE).map((s) => btn(s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name, `m:s:${KM[marketId]}:${s.id}`));
    const extra = [];
    for (let i = 0; i < items.length; i += 2) extra.push(items.slice(i, i + 2));
    if (pages > 1) extra.push([btn('◀️', `m:l:${KM[marketId]}:${(page - 1 + pages) % pages}`), btn(`Page ${page + 1} / ${pages}`, `m:l:${KM[marketId]}:${page}`), btn('▶️', `m:l:${KM[marketId]}:${(page + 1) % pages}`)]);
    return { png, caption: `${head} · 📚 stratégies actives (page ${page + 1} / ${pages})`, keyboard: panelKeyboard(cfg, 'l', marketId, extra) };
  }

  if (view === 's') {
    const id = args[0];
    const row = st.rows.find((r) => r.strategy.id === id);
    if (!row) throw new Error('stratégie inconnue sur ce marché');
    const colors = colorize(st.rows.map((r) => r.strategy));
    const color = colors[st.rows.indexOf(row)];
    const curve = (tr.curves().find((c) => c.strategy.id === id) || { points: [] }).points;
    const note = (VERDICT[id.split('@')[0]] || [])[1] || '';
    const png = C.strategyCardImage({ market, row, curve, note, color: color.rgb });
    const testable = (row.strategy.tf || '1h') === '1d';
    const extra = [[
      ...(testable ? [btn('🕰 Tester sur l’historique', `m:t:${KM[marketId]}:${id}:${YEARS[marketId][0]}`)] : []),
      btn('⬅️ Liste', `m:l:${KM[marketId]}:0`),
    ]];
    return {
      png,
      caption: `${head} · ℹ️ <b>${esc(row.strategy.name)}</b>\n${money(row.equity)} (${pct(row.returnPct)}) · ${row.trades} trades${row.position ? ` · en position (${row.position.side === 'long' ? 'achat' : 'vente'})` : ' · à plat'}`,
      keyboard: panelKeyboard(cfg, 's', marketId, extra),
    };
  }
  throw new Error('vue inconnue');
}

/** Images sous un trade : carte, cours + niveaux, fiche. */
async function renderTrade(cfg, store, action, marketId, id, entryT) {
  const market = marketById(cfg, marketId);
  const tr = trader(cfg, store, marketId);
  const strat = selectStrategies(market.strategies).find((s) => s.id === id) || { id, name: id, desc: '' };
  if (action === 's') return render(cfg, store, 's', marketId, [id]);
  const found = findTrade(tr, id, entryT);
  if (!found) throw new Error('trade introuvable (trop ancien ?)');
  const t = found.trade || found.pos;
  const tf = (found.trade ? found.trade.exitT : Date.now() / 1000) - t.entryT > 10 * 86400 ? '1d' : '1h';
  const { list, price } = await candles(market, tf);
  const acc = tr.account(id);
  const head = `${market.emoji} <b>${esc(market.name)} · ${esc(strat.name)}</b>`;
  const keyboard = {
    inline_keyboard: [
      [btn(action === 'k' ? '• 🧾 Carte' : '🧾 Carte', `x:k:${KM[marketId]}:${id}:${t.entryT}`), btn(action === 'c' ? '• 🕯 Cours' : '🕯 Cours', `x:c:${KM[marketId]}:${id}:${t.entryT}`), btn('ℹ️ Stratégie', `m:s:${KM[marketId]}:${id}`)],
      [btn('🎛 Menu', `m:h:${KM[marketId]}`)],
    ],
  };
  if (action === 'k') {
    const png = C.tradeCardImage({ market, strategy: strat, trade: found.trade, pos: found.pos, price, candles: list, capital: found.trade ? found.trade.capital ?? null : acc.capital, start: market.startCapital });
    const res = found.trade ? `résultat <b>${pct(found.trade.pnlPct)}</b>` : `en cours (${price ? pct((t.side === 'long' ? 1 : -1) * (price / t.entry - 1) * 100) : 'n/d'})`;
    return { png, caption: `${head}\n🧾 ${t.side === 'long' ? 'achat' : 'vente'} à ${quote(t.entry)} · ${res}`, keyboard };
  }
  const shown = list.filter((c) => c.t >= t.entryT - (tf === '1d' ? 40 : 30) * (tf === '1d' ? 86400 : 3600)).slice(-120);
  const markers = [{ t: t.entryT, price: t.entry, rgb: [124, 196, 255], label: t.side === 'long' ? 'achat' : 'vente' }];
  if (found.trade) markers.push({ t: found.trade.exitT, price: found.trade.exit, rgb: found.trade.pnlUsd >= 0 ? [34, 197, 94] : [240, 82, 82], label: 'sortie', below: true });
  const png = C.priceChartImage({
    market,
    candles: shown,
    title: `${market.name} · ${strat.name}`,
    subtitle: `Bougies ${tf === '1d' ? '1 jour' : '1 heure'} · entrée${t.sl ? ', stop' : ''}${t.tp ? ', objectif' : ''}${found.trade ? ', sortie' : ''}${price ? ` · cours ${quote(price)}` : ''}`,
    levels: C.positionLevels(found.trade ? { ...t, sl: t.initSl || t.sl } : t),
    markers,
  });
  return { png, caption: `${head}\n🕯 cours et niveaux du trade`, keyboard };
}

/* ------------------------------------------------------------------ */
/* Réponse aux boutons                                                  */
/* ------------------------------------------------------------------ */

const busy = new Set(); // messages en cours de mise à jour
const lastClick = new Map(); // anti-rafale par personne

/** Envoie la vue : remplace l'image du message (panneau) ou répond avec une nouvelle image. */
async function show(ctx, out, { replace }) {
  const media = { type: 'photo', media: new InputFile(out.png, 'image.png'), caption: out.caption, parse_mode: 'HTML' };
  if (replace) {
    try {
      await ctx.editMessageMedia(media, { reply_markup: out.keyboard });
      return;
    } catch (err) {
      if (/not modified/i.test(err.description || err.message)) return;
      if (!/no media|can't be edited|there is no|message to edit not found/i.test(err.description || err.message)) throw err;
    }
  }
  const msg = ctx.callbackQuery?.message;
  await ctx.api.sendPhoto(ctx.chat.id, new InputFile(out.png, 'image.png'), {
    caption: out.caption,
    parse_mode: 'HTML',
    reply_markup: out.keyboard,
    ...(msg ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}),
    ...(msg?.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
  });
}

/**
 * Branche les boutons sur le bot. `gameHandler(ctx, parts)` traite les boutons du jeu (préfixe g:).
 */
function attachInteractive(bot, { cfg, store, gameHandler = null }) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    if (parts[0] === 'g' && gameHandler) return gameHandler(ctx, parts);
    if (parts[0] !== 'm' && parts[0] !== 'x') return ctx.answerCallbackQuery().catch(() => {});

    const who = ctx.from?.id;
    const now = Date.now();
    if (who && now - (lastClick.get(who) || 0) < 1200) return ctx.answerCallbackQuery({ text: 'Doucement 🙂' }).catch(() => {});
    lastClick.set(who, now);
    const msg = ctx.callbackQuery.message;
    const key = msg ? `${msg.chat.id}:${msg.message_id}` : data;
    if (busy.has(key)) return ctx.answerCallbackQuery({ text: '⏳ Image en cours de création…' }).catch(() => {});
    busy.add(key);

    const marketId = MK[parts[2]];
    const slow = parts[1] === 'y' || parts[1] === 't';
    await ctx.answerCallbackQuery(slow ? { text: '⏳ Simulation en cours (jusqu’à 1 min la première fois)…' } : {}).catch(() => {});
    try {
      if (!marketId) throw new Error('marché inconnu');
      if (parts[0] === 'm') {
        const out = await render(cfg, store, parts[1], marketId, parts.slice(3));
        // Le panneau change d'image sur place ; un message texte (bilan, trade) reçoit une nouvelle image en réponse
        await show(ctx, out, { replace: Boolean(msg?.photo) });
      } else {
        const out = await renderTrade(cfg, store, parts[1], marketId, parts[3], Number(parts[4]));
        await show(ctx, out, { replace: Boolean(msg?.photo) });
      }
    } catch (err) {
      console.warn(`[boutons] ${data} : ${err.description || err.message}`);
      await ctx.answerCallbackQuery({ text: `❌ ${String(err.message).slice(0, 180)}`, show_alert: true }).catch(() => {});
    } finally {
      busy.delete(key);
    }
  });
}

/** Envoie un panneau (commande /menu, graphique quotidien). */
async function sendPanel(api, chatId, cfg, store, { view = 'h', marketId = 'nas100', args = [], extra = {} } = {}) {
  const out = await render(cfg, store, view, marketId, args);
  return api.sendPhoto(chatId, new InputFile(out.png, 'image.png'), { caption: out.caption, parse_mode: 'HTML', reply_markup: out.keyboard, ...extra });
}

module.exports = { attachInteractive, sendPanel, render, renderTrade, panelKeyboard, tradeKeyboard, summaryKeyboard, MK, KM };
