/**
 * Paper trading de l'or (PAXG/USD, 1 PAXG ≈ 1 once d'or) avec plusieurs stratégies en parallèle.
 * Chaque stratégie a son propre compte simulé (GOLD_SIZE_USD par trade) : on peut comparer leurs résultats.
 *
 *  - Signaux calculés sur les bougies 1 h clôturées (une évaluation par bougie et par stratégie)
 *  - Stop loss / take profit vérifiés sur les bougies 5 min (plus précis)
 *  - Frais simulés : GOLD_FEE_PCT à l'entrée et à la sortie
 * Simulation uniquement : aucun ordre réel n'est passé.
 */
const { getJson } = require('./http');
const { computeAll } = require('./indicators');
const { selectStrategies } = require('./strategies');

const FILE = 'gold.json';
const H = 3600;
const CB = 'https://api.exchange.coinbase.com/products/PAXG-USD/candles';

const parseCb = (rows) => rows.map(([t, l, h, o, c, v]) => ({ t, o, h, l, c, v })).sort((a, b) => a.t - b.t);

/** Bougies récentes (granularité en secondes : 300, 3600 ou 86400). Coinbase, secours Kraken. */
async function fetchCandles(granularity = 3600) {
  const cb = await getJson(`${CB}?granularity=${granularity}`, { quiet: true });
  if (Array.isArray(cb) && cb.length > 50) return parseCb(cb);
  const kr = await getJson(`https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=${granularity / 60}`, { quiet: true });
  const rows = kr?.result && Object.values(kr.result).find(Array.isArray);
  if (rows?.length > 50) return rows.map(([t, o, h, l, c, , v]) => ({ t, o: +o, h: +h, l: +l, c: +c, v: +v }));
  return null;
}

/** Historique sur N jours (pages de 300 bougies Coinbase), pour le backtest. */
async function fetchHistory(days = 90, granularity = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const byT = new Map();
  for (let end = now; end > now - days * 86400; end -= 300 * granularity) {
    const start = Math.max(end - 300 * granularity, now - days * 86400);
    const iso = (s) => new Date(s * 1000).toISOString();
    const rows = await getJson(`${CB}?granularity=${granularity}&start=${iso(start)}&end=${iso(end)}`);
    if (!Array.isArray(rows)) break;
    for (const c of parseCb(rows)) byT.set(c.t, c);
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Bougies 1 h + bougies jour (avec 220 jours de marge pour la MM200 journalière). */
async function fetchBacktestData(days = 90) {
  const [hourly, daily] = await Promise.all([fetchHistory(days, 3600), fetchHistory(days + 220, 86400)]);
  return { hourly, daily };
}

/* ------------------------------------------------------------------ */
/* Logique commune ouverture / clôture                                 */
/* ------------------------------------------------------------------ */

function openPos(side, price, sig, size, t) {
  const dir = side === 'long' ? 1 : -1;
  return {
    side,
    entry: price,
    sl: price - dir * sig.sl,
    initSl: price - dir * sig.sl,
    tp: sig.tp ? price + dir * sig.tp : null,
    size,
    best: price,
    entryT: t,
    checkedFrom: t,
  };
}

function closePos(pos, price, reason, t, feePct) {
  const dir = pos.side === 'long' ? 1 : -1;
  const pnlPct = (dir * (price / pos.entry - 1) - (2 * feePct) / 100) * 100;
  return { ...pos, exit: price, exitT: t, reason, pnlPct, pnlUsd: (pos.size * pnlPct) / 100 };
}

/** Stop / objectif touché dans une bougie ? (prudence : le stop passe avant l'objectif) */
function hitInCandle(pos, c) {
  const long = pos.side === 'long';
  if (long ? c.l <= pos.sl : c.h >= pos.sl) return { price: pos.sl, reason: 'stop loss' };
  if (pos.tp !== null && (long ? c.h >= pos.tp : c.l <= pos.tp)) return { price: pos.tp, reason: 'take profit' };
  return null;
}

/** Met à jour le meilleur prix et resserre le stop suiveur éventuel. */
function trailStop(strategy, pos, ind, i) {
  const c = ind.closes[i];
  pos.best = pos.side === 'long' ? Math.max(pos.best, c) : Math.min(pos.best, c);
  if (!strategy.trail) return;
  const next = strategy.trail(pos, ind, i);
  if (!Number.isFinite(next)) return;
  pos.sl = pos.side === 'long' ? Math.max(pos.sl, next) : Math.min(pos.sl, next);
}

function summarize(trades) {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const gross = (arr) => arr.reduce((s, t) => s + t.pnlUsd, 0);
  // drawdown max sur la courbe des gains cumulés
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    eq += t.pnlUsd;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    pnlUsd: gross(trades),
    profitFactor: losses.length && gross(losses) !== 0 ? gross(wins) / -gross(losses) : null,
    maxDrawdown: maxDd,
  };
}

/* ------------------------------------------------------------------ */
/* Backtest (bougies 1 h uniquement)                                   */
/* ------------------------------------------------------------------ */

function backtest(strategy, candles, { size = 1000, feePct = 0.05, daily = null, from = 0 } = {}) {
  const ind = computeAll(candles, daily);
  const trades = [];
  let pos = null;
  for (let i = Math.max(strategy.warmup, 1, from); i < candles.length; i++) {
    const c = candles[i];
    if (pos && pos.openIdx < i) {
      const hit = hitInCandle(pos, c);
      if (hit) {
        trades.push(closePos(pos, hit.price, hit.reason, c.t, feePct));
        pos = null;
      }
    }
    const sig = strategy.evaluate(ind, i);
    if (pos) {
      trailStop(strategy, pos, ind, i);
      if ((pos.side === 'long' && sig.exitLong) || (pos.side === 'short' && sig.exitShort)) {
        trades.push(closePos(pos, c.c, 'signal de sortie', c.t, feePct));
        pos = null;
      }
    }
    if (!pos && sig.entry && i < candles.length - 1) {
      pos = openPos(sig.entry, c.c, sig, size, c.t);
      pos.openIdx = i;
    }
  }
  return { ...summarize(trades), open: pos, list: trades };
}

/* ------------------------------------------------------------------ */
/* Trading simulé en direct                                            */
/* ------------------------------------------------------------------ */

class GoldTrader {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.strategies = selectStrategies(cfg.goldStrategies);
    const s = store.loadJson(FILE, {});
    this.state = s.accounts ? s : { accounts: {} }; // ancien format → on repart de zéro
  }

  save() {
    for (const acc of Object.values(this.state.accounts)) {
      if (acc.closed.length > 300) acc.closed = acc.closed.slice(-300);
    }
    this.store.saveJson(FILE, this.state);
  }

  account(id) {
    if (!this.state.accounts[id]) this.state.accounts[id] = { position: null, closed: [], lastEvalT: 0 };
    return this.state.accounts[id];
  }

  /** Un passage pour toutes les stratégies. Retourne les événements à publier. */
  async run() {
    if (!this.cfg.goldEnabled) return [];
    const [h1, m5, d1] = await Promise.all([fetchCandles(3600), fetchCandles(300), fetchCandles(86400)]);
    if (!h1) {
      console.warn('[or] prix indisponible, passage ignoré');
      return [];
    }
    const now = Math.floor(Date.now() / 1000);
    const price = (m5 && m5[m5.length - 1].c) || h1[h1.length - 1].c;
    const closed = h1.filter((c) => c.t + H <= now);
    const ind = computeAll(closed, d1);
    const i = closed.length - 1;
    const fee = this.cfg.goldFeePct;
    const events = [];
    this.state.lastPrice = price;
    this.state.lastUpdate = Date.now();

    for (const strat of this.strategies) {
      const acc = this.account(strat.id);

      // 1. Stop / objectif touchés depuis le dernier passage (bougies 5 min)
      if (acc.position && m5) {
        for (const c of m5.filter((x) => x.t + 300 > acc.position.checkedFrom)) {
          const hit = hitInCandle(acc.position, c);
          if (hit) {
            events.push(this.#close(strat, acc, hit.price, hit.reason, now, fee));
            break;
          }
        }
        if (acc.position) acc.position.checkedFrom = now;
      }

      // 2. Nouvelle bougie 1 h clôturée → évaluation de la stratégie
      if (i < strat.warmup || closed[i].t <= acc.lastEvalT) continue;
      acc.lastEvalT = closed[i].t;
      const sig = strat.evaluate(ind, i);
      if (acc.position) {
        trailStop(strat, acc.position, ind, i);
        const p = acc.position;
        if ((p.side === 'long' && sig.exitLong) || (p.side === 'short' && sig.exitShort)) {
          events.push(this.#close(strat, acc, price, 'signal de sortie', now, fee));
        }
      }
      if (!acc.position && sig.entry) {
        acc.position = openPos(sig.entry, price, sig, this.cfg.goldSizeUsd, now);
        events.push({ type: 'open', strategy: strat, pos: acc.position, rsi: ind.rsi[i] });
      }
    }
    this.save();
    return events;
  }

  #close(strat, acc, price, reason, t, fee) {
    const trade = closePos(acc.position, price, reason, t, fee);
    acc.position = null;
    acc.closed.push(trade);
    return { type: 'close', strategy: strat, trade };
  }

  stats() {
    const price = this.state.lastPrice;
    const rows = this.strategies.map((strat) => {
      const acc = this.account(strat.id);
      const p = acc.position;
      let unrealized = 0;
      if (p && price) unrealized = p.size * (p.side === 'long' ? 1 : -1) * (price / p.entry - 1);
      return { strategy: strat, ...summarize(acc.closed), position: p, unrealized };
    });
    return { price, rows, totalPnl: rows.reduce((s, r) => s + r.pnlUsd, 0) };
  }
}

module.exports = { GoldTrader, backtest, fetchHistory, fetchBacktestData, fetchCandles, hitInCandle };
