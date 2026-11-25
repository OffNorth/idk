/**
 * État en direct pour la catégorie « Bot » du site (marches-eight.vercel.app) : comptes FTMO et Lucid simulés,
 * positions ouvertes (entrée, SL, TP), derniers trades, refus de l'IA. Envoyé à la fonction Supabase « bot » à chaque
 * passage (au plus toutes les 15 s), sans bloquer le bot. Aucun secret dans l'état.
 * Clé d'écriture : générée par le bot au 1er envoi (data/bot-push-key.json) ; la fonction n'en garde que l'empreinte.
 */
const crypto = require('crypto');
const { activeMarkets } = require('./markets');

const URL_DEFAULT = 'https://glvxxxoxcxsxdnbofgqf.supabase.co/functions/v1/bot';
const SYMBOL = { gold: 'GC=F', nas100: '^NDX', spx: '^GSPC', eurusd: 'EURUSD=X', silver: 'SI=F', dow: '^DJI', russell: '^RUT',
  ...Object.fromEntries(Object.entries(require('./stocks').STOCKS).map(([k, v]) => [k, v.symbol])) };
const r6 = (v) => (Number.isFinite(v) ? Number(v.toPrecision(8)) : null);

/** Compte FTMO / Lucid simulé → objet compact pour le site. */
function accountView(cfg, store, id, prices) {
  const { createFtmo, accountOf } = require('./ftmoAccount');
  const A = accountOf(cfg, id);
  if (!A.enabled) return null;
  const f = createFtmo({ cfg, store, account: id });
  const st = f.status(prices);
  const s = st.s;
  const P = st.program || {};
  const papers = {};
  const tpOf = (p) => {
    papers[p.market] ??= store.loadJson(`${p.market}.json`, null);
    const pos = papers[p.market]?.accounts?.[p.sid]?.position;
    return pos && Math.abs(pos.entryT - p.entryT) < 2 ? pos.tp ?? null : null;
  };
  const rep = cfg.ftmoAi === 'block' ? f.refusedReport(prices) : { n: 0, rows: [] };
  return {
    id: A.id === 'lucid' ? 'lucid' : 'ftmo',
    firm: A.firm || 'FTMO',
    label: A.label,
    program: P.label || '',
    attempt: s.attempt,
    phase: s.phase,
    capital: s.capital,
    balance: r6(s.balance),
    equity: r6(st.equity),
    realized: r6(st.realized),
    unrealized: r6(st.unrealized),
    target: r6(st.target),
    targetPct: st.targetPct ?? null,
    progress: r6(st.progress),
    dailyLimitPct: Number.isFinite(P.daily) ? P.daily : null,
    dailyFloor: Number.isFinite(P.daily) ? r6(s.dayStart - (s.capital * P.daily) / 100) : null,
    dailyUsed: r6(st.dailyUsed),
    maxLoss: P.maxUsd ? P.maxUsd : (s.capital * (P.max || 10)) / 100,
    maxFloor: r6(st.floor),
    maxUsed: r6(st.maxUsed),
    trailing: !!(P.trailing || P.eod),
    days: (s.days || []).length,
    minDays: P.minDays ?? 4,
    bestDayPct: P.bestDay || 0,
    split: P.split || 80,
    payouts: s.phase === 'funded' ? { n: s.funded?.payouts?.length || 0, paid: Math.round(s.funded?.paid || 0), trader: Math.round(s.funded?.traderPaid || 0), list: (s.funded?.payouts || []).slice(-20) } : null,
    fillDelaySec: cfg.fillDelaySec || 0,
    open: Object.values(s.open || {}).map((p) => ({
      market: p.market, sid: p.sid, name: p.name, side: p.side, entry: r6(p.entry), sl: r6(p.sl), tp: r6(tpOf(p)), entryT: p.entryT, signal: p.signal ? r6(p.signal) : null,
      notional: Math.round(p.notional), n: p.n || null, contract: p.contract || null, risk: Math.round(p.risk || 0),
      pnl: r6(st.openPnl(p)), ai: p.ai ? Math.round(p.ai.p * 100) : null,
    })),
    closed: (s.closed || []).slice(-150).map((t) => ({
      market: t.market, sid: t.sid, name: t.name, side: t.side, entry: r6(t.entry), exit: r6(t.exit), sl: r6(t.sl), entryT: t.entryT, exitT: t.exitT,
      pnl: Math.round(t.pnl), risk: t.risk ? Math.round(t.risk) : null, reason: t.reason, n: t.n || null,
    })),
    history: (s.history || []).slice(-5),
    // Trades des challenges précédents (archive), les plus récents
    archive: f.archived().slice(-300).map((t) => ({
      market: t.market, sid: t.sid, name: t.name, side: t.side, entry: r6(t.entry), exit: r6(t.exit), sl: r6(t.sl), entryT: t.entryT, exitT: t.exitT,
      pnl: Math.round(t.pnl), risk: t.risk ? Math.round(t.risk) : null, reason: t.reason, n: t.n || null, attempt: t.attempt,
    })),
    refused: rep.n ? { n: rep.n, closed: rep.closed, closedPnl: Math.round(rep.closedPnl), wins: rep.wins, open: rep.open, openPnl: Math.round(rep.openPnl),
      last: rep.rows.slice(-15).map((r) => ({ market: r.market, sid: r.sid, side: r.side, entry: r6(r.entry), entryT: r.entryT, state: r.state, pnl: Math.round(r.pnl), p: Math.round(r.ai.p * 100) })) } : null,
  };
}

/**
 * Diagnostic (sans secret) : groupe configuré ou non (ID masqué), dernier envoi réussi, dernière erreur, pause,
 * réglages des messages, copies en privé, signaux sautés par les comptes. Permet de trouver d'où vient un souci
 * de notifications sans accès au serveur.
 */
function diagOf(cfg, store) {
  const id = String(cfg.channelId || '');
  const counters = (file) => {
    const s = store.loadJson(file, null);
    return s ? { tooBig: s.tooBig || 0, tooBigBy: s.tooBigBy || {}, tooSmall: s.tooSmall || 0, missed: s.missed || 0, aiRefused: s.aiRefused || 0, skippedHedge: s.skipped || 0 } : null;
  };
  return {
    group: {
      set: !!id, id: id ? `${id.slice(0, 4)}…${id.slice(-3)}` : null, lastOk: store.getMeta('channelLastOk') || null,
      lastError: store.getMeta('channelLastError') || null, skippedNoId: store.getMeta('channelSkipped') || 0, moved: !!store.getMeta('channelMoved'),
    },
    paused: !!store.getMeta('paused'),
    tradeMessages: cfg.ftmoTradeMessages !== false,
    publishFtmoOnly: !!cfg.publishFtmoOnly,
    tradeDm: cfg.tradeDm || 'fallback',
    dmTargets: cfg.allowedUserIds?.size || (store.getMeta('firstPrivateUser') ? 1 : 0),
    dmLastOk: store.getMeta('dmLastOk') || null,
    lucidIntradayRisk: cfg.lucidIntradayRisk,
    ftmo: counters('ftmo.json'),
    lucid: counters('lucid.json'),
  };
}

/** État complet envoyé au site. */
function buildLive(cfg, store, version = '') {
  const markets = activeMarkets(cfg);
  const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
  const accounts = ['gold', 'lucid'].map((id) => accountView(cfg, store, id, prices)).filter(Boolean);
  const adapt = cfg.autoAdapt ? require('./adapt').summary(cfg, store) : '';
  // Trades paper des stratégies suivies (tous marchés, depuis le démarrage), 500 les plus récents
  const followed = new Set([...(cfg.ftmoStrategies || []), ...(cfg.ftmoNasStrategies || [])]);
  const paper = [];
  for (const m of markets) {
    const st = store.loadJson(m.file, null);
    for (const [sid, acc] of Object.entries(st?.accounts || {})) {
      if (!followed.has(`${m.id}:${sid}`)) continue;
      for (const t of acc.closed || []) paper.push({ market: m.id, sid, side: t.side, entry: r6(t.entry), exit: r6(t.exit), sl: r6(t.initSl ?? t.sl), entryT: t.entryT, exitT: t.exitT, pnlPct: r6(t.pnlPct), reason: t.reason });
    }
  }
  paper.sort((a, b) => a.exitT - b.exitT);
  return {
    v: 1,
    at: Date.now(),
    version: version || require('./version').version(),
    diag: diagOf(cfg, store),
    markets: markets.map((m) => ({ id: m.id, name: m.id === 'nas100' ? 'Nasdaq 100' : m.name, symbol: SYMBOL[m.id] || null, price: r6(prices[m.id]) })),
    accounts,
    ai: cfg.ftmoAi,
    adapt,
    paper: paper.slice(-500),
  };
}

let lastPush = 0;
let lastError = '';
/** Clé d'écriture du bot (générée une fois). */
function keyOf(store) {
  let k = store.loadJson('bot-push-key.json', null)?.key;
  if (!k) {
    k = crypto.randomBytes(32).toString('base64url');
    store.saveJson('bot-push-key.json', { key: k, createdAt: new Date().toISOString() });
  }
  return k;
}

/** Envoie l'état (au plus toutes les 15 s) ; ne lève jamais d'erreur. Retourne true si envoyé. */
async function pushLive(cfg, store, { now = Date.now(), version = '', fetchImpl = globalThis.fetch } = {}) {
  if (!cfg.livePush || !fetchImpl) return false;
  if (now - lastPush < 15_000) return false;
  lastPush = now;
  try {
    const body = JSON.stringify(buildLive(cfg, store, version));
    const res = await fetchImpl(`${cfg.livePushUrl || URL_DEFAULT}?action=put&slot=main`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-key': keyOf(store) }, body, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    if (lastError) console.log('[interface] envoi rétabli');
    lastError = '';
    return true;
  } catch (err) {
    const msg = String(err.message || err);
    if (msg !== lastError) console.warn(`[interface] envoi de l'état impossible : ${msg}`);
    lastError = msg;
    return false;
  }
}
const resetThrottle = () => { lastPush = 0; };

module.exports = { buildLive, pushLive, keyOf, resetThrottle, SYMBOL };
