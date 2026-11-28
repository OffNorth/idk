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
const { computeAll, computeScalp } = require('./indicators');
const { selectStrategies, tfOf, TF_SEC } = require('./strategies');

const FILE = 'gold.json';
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

/** Historique long gardé en mémoire `ttlSec` secondes (évite de re-télécharger à chaque passage). */
const cache = new Map();
async function cachedHistory(granularity, days, ttlSec) {
  const key = `${granularity}:${days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return hit.data;
  const data = await fetchHistory(days, granularity);
  if (data.length > 50) {
    cache.set(key, { at: Date.now(), data });
    return data;
  }
  return hit ? hit.data : fetchCandles(granularity);
}

/**
 * Historique glissant (scalp) : téléchargé une fois sur `days` jours, puis complété à chaque passage
 * par les 300 dernières bougies (une seule requête), au lieu de tout re-télécharger.
 */
const rolling = new Map();
async function rollingHistory(granularity, days) {
  const key = `${granularity}:${days}`;
  let hit = rolling.get(key);
  if (!hit || Date.now() - hit.full > 6 * 3_600_000) {
    const data = await fetchHistory(days, granularity);
    if (data.length > 50) {
      hit = { full: Date.now(), map: new Map(data.map((c) => [c.t, c])) };
      rolling.set(key, hit);
    }
  } else {
    const recent = await fetchCandles(granularity);
    for (const c of recent || []) hit.map.set(c.t, c);
  }
  if (!hit) return fetchCandles(granularity);
  const from = Math.floor(Date.now() / 1000) - days * 86400;
  for (const t of hit.map.keys()) if (t < from) hit.map.delete(t);
  return [...hit.map.values()].sort((a, b) => a.t - b.t);
}

/** EUR/USD journalier (Kraken, ~2 ans), gardé 1 h en mémoire. Sert de mesure de la force du dollar. */
async function fetchEurUsd() {
  const hit = cache.get('eurusd');
  if (hit && Date.now() - hit.at < 3_600_000) return hit.data;
  const kr = await getJson('https://api.kraken.com/0/public/OHLC?pair=EURUSD&interval=1440', { quiet: true });
  const rows = kr?.result && Object.values(kr.result).find(Array.isArray);
  if (!rows?.length) return hit ? hit.data : null;
  const data = rows.map(([t, o, h, l, c]) => ({ t, o: +o, h: +h, l: +l, c: +c }));
  cache.set('eurusd', { at: Date.now(), data });
  return data;
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

/**
 * Clôture d'une position. feePct = frais par côté (%), financingPct = coût de financement annuel (%)
 * appliqué au prorata des jours en position (CFD : « swap » de nuit).
 */
/**
 * Tendance journalière à la dernière clôture TERMINÉE (bougie du jour en cours exclue) : 1 si clôture > EMA 50 > EMA 200,
 * −1 si clôture < EMA 50 < EMA 200, 0 sinon (neutre) ; null s'il manque de l'historique (< 200 jours).
 */
function dailyTrend(daily, now) {
  const done = daily.filter((k) => k.t + 86400 <= now && k.c > 0);
  if (done.length < 210) return null;
  const ema = (n) => { const k = 2 / (n + 1); let e = done[0].c; for (const d of done) e = d.c * k + e * (1 - k); return e; };
  const c = done[done.length - 1].c, e50 = ema(50), e200 = ema(200);
  return { t: done[done.length - 1].t, dir: c > e50 && e50 > e200 ? 1 : c < e50 && e50 < e200 ? -1 : 0, c, e50, e200 };
}

function closePos(pos, price, reason, t, feePct, financingPct = 0) {
  const dir = pos.side === 'long' ? 1 : -1;
  const days = Math.max(0, (t - pos.entryT) / 86400);
  const financing = (financingPct * days) / 365;
  const pnlPct = (dir * (price / pos.entry - 1) - (2 * feePct) / 100 - financing / 100) * 100;
  return { ...pos, exit: price, exitT: t, reason, pnlPct, pnlUsd: (pos.size * pnlPct) / 100, financingPct: financing };
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

/** Gain / perte latent d'une position au prix `price`. */
function unrealized(pos, price) {
  if (!pos || !price) return 0;
  return pos.size * (pos.side === 'long' ? 1 : -1) * (price / pos.entry - 1);
}

/**
 * Backtest d'une stratégie.
 *  compound : true → chaque trade mise `positionPct` % du capital du moment (gains réinvestis),
 *             false → taille fixe `size` par trade.
 *  curveEvery : > 0 → enregistre la valeur du compte toutes les N bougies (courbe de capital).
 */
function backtest(strategy, candles, {
  size = 1000, feePct = 0.05, daily = null, from = 0, to = Infinity, barSec = 3600, fx = null, vix = null, aux = {}, ind: pre = null,
  compound = false, capital: startCapital = size, positionPct = 100, curveEvery = 0, financingPct = 0, market = null,
} = {}) {
  const ind = pre || (strategy.compute ? strategy.compute(candles, barSec, market || strategy.markets?.[0])
    : strategy.intraday ? require('./intraday').computeIntraday(candles, barSec)
      : strategy.scalp ? computeScalp(candles, barSec) : computeAll(candles, daily, barSec, fx, vix, aux));
  const trades = [];
  const curve = [];
  let pos = null;
  let capital = startCapital;
  const close = (price, reason, t) => {
    const trade = closePos(pos, price, reason, t, feePct, financingPct);
    capital += trade.pnlUsd;
    trade.capital = capital;
    trades.push(trade);
    pos = null;
  };
  const start = Math.max(strategy.warmup, 1, from);
  const end = Math.min(candles.length, to);
  for (let i = start; i < end; i++) {
    const c = candles[i];
    if (pos && pos.openIdx < i) {
      // Pire moment du trade (en % du prix d'entrée), utile pour la perte du jour « positions ouvertes comprises » (FTMO)
      const adverse = pos.side === 'long' ? (Math.max(c.l, pos.sl) / pos.entry - 1) * 100 : (1 - Math.min(c.h, pos.sl) / pos.entry) * 100;
      pos.worstPct = Math.min(pos.worstPct ?? 0, adverse);
      const hit = hitInCandle(pos, c);
      if (hit) close(hit.price, hit.reason, c.t);
    }
    const sig = strategy.evaluate(ind, i);
    if (pos) {
      trailStop(strategy, pos, ind, i);
      if ((pos.side === 'long' && sig.exitLong) || (pos.side === 'short' && sig.exitShort)) close(c.c, 'exit signal', c.t);
    }
    if (!pos && sig.entry && i < end - 1 && capital > 0) {
      pos = openPos(sig.entry, c.c, sig, compound ? (capital * positionPct) / 100 : size, c.t);
      pos.openIdx = i;
    }
    if (curveEvery > 0 && ((i - start) % curveEvery === 0 || i === end - 1)) {
      curve.push({ t: c.t + barSec, v: capital + unrealized(pos, c.c) });
    }
  }
  const lastPrice = candles[end - 1]?.c;
  return { ...summarize(trades), open: pos, list: trades, capital, equity: capital + unrealized(pos, lastPrice), curve };
}

/* ------------------------------------------------------------------ */
/* Trading simulé en direct                                            */
/* ------------------------------------------------------------------ */

/**
 * Paper trading en direct d'un marché (or, Nasdaq 100…). `market` fournit :
 *   id, name, emoji, file, enabled, strategies (ids), startCapital, positionPct, feePct, financingPct,
 *   fetch(tfs, needsFx) → { price, stops (bougies 5 min), daily, fx, series: { tf: bougies } }
 */
class MarketTrader {
  constructor(market, store, cfg) {
    this.market = market;
    this.store = store;
    this.cfg = cfg;
    this.strategies = selectStrategies(market.strategies);
    const s = store.loadJson(market.file, {});
    this.state = s.accounts ? s : { accounts: {} }; // ancien format → on repart de zéro
  }

  save() {
    for (const acc of Object.values(this.state.accounts)) {
      if (acc.closed.length > 300) acc.closed = acc.closed.slice(-300);
    }
    this.store.saveJson(this.market.file, this.state);
  }

  account(id) {
    const start = this.market.startCapital;
    if (!this.state.accounts[id]) this.state.accounts[id] = { position: null, closed: [], lastEvalT: 0, capital: start };
    const acc = this.state.accounts[id];
    // anciens comptes (avant le réinvestissement) : capital = départ + gains déjà réalisés
    if (acc.capital === undefined) acc.capital = start + acc.closed.reduce((s, t) => s + t.pnlUsd, 0);
    return acc;
  }

  /** Valeur du compte : capital + gain / perte latent de la position ouverte. */
  equity(acc, price = this.state.lastPrice) {
    return acc.capital + unrealized(acc.position, price);
  }

  /** Enregistre la valeur de chaque compte (au plus une fois par heure ; une par jour après 90 jours). */
  snapshot(now) {
    const curve = (this.state.curve ||= []);
    const last = curve[curve.length - 1];
    if (last && now - last.t < 3600) return;
    const eq = {};
    for (const strat of this.strategies) eq[strat.id] = Math.round(this.equity(this.account(strat.id)) * 100) / 100;
    curve.push({ t: now, eq });
    const old = now - 90 * 86400;
    const seen = new Set();
    this.state.curve = curve.filter((p) => {
      if (p.t >= old) return true;
      const day = Math.floor(p.t / 86400);
      if (seen.has(day)) return false;
      seen.add(day);
      return true;
    });
  }

  /** Courbes de capital par stratégie active (pour le graphique), point actuel inclus. */
  curves() {
    const now = Math.floor(Date.now() / 1000);
    return this.strategies.map((strat) => {
      const points = (this.state.curve || []).filter((p) => p.eq[strat.id] !== undefined).map((p) => ({ t: p.t, v: p.eq[strat.id] }));
      points.push({ t: now, v: this.equity(this.account(strat.id)) });
      return { strategy: strat, points };
    });
  }

  /**
   * Passage d'une source de bougies à l'autre : écart de cotation mesuré (M.basis : OANDA − Yahoo sur les mêmes
   * bougies 5 min), positions ouvertes du marché décalées d'autant (paper, comptes FTMO / Lucid) pour qu'un stop ne
   * soit pas touché juste à cause du changement de source.
   */
  async switchFeed(from, to) {
    const M = this.market;
    const paperOpen = Object.values(this.state.accounts).filter((a) => a.position);
    const { shiftOpen, openOn } = require('./ftmoAccount');
    let shift = 0;
    // Écart de chaque source par rapport à Yahoo (Yahoo : 0) ; celui d'une source qu'on quitte en panne : dernier mesuré
    const known = this.state.feedBasis || {};
    const basisOf = async (feed) => {
      if (feed === 'yahoo' || !M.basis) return 0;
      const b = await M.basis(feed).catch(() => null);
      return b ?? (feed === from ? known[feed] ?? null : null);
    };
    const needed = paperOpen.length || openOn(this.store, M.id);
    const [bFrom, bTo] = await Promise.all([needed ? basisOf(from) : 0, basisOf(to)]);
    if (to !== 'yahoo' && bTo !== null) this.state.feedBasis = { ...known, [to]: bTo };
    if (needed) {
      if (bFrom === null || bTo === null) console.warn(`[${M.id}] écart ${from} → ${to} non mesurable : positions gardées telles quelles`);
      else shift = bTo - bFrom;
    }
    if (shift) {
      for (const a of paperOpen) {
        for (const k of ['entry', 'sl', 'initSl', 'tp', 'best']) if (Number.isFinite(a.position[k])) a.position[k] += shift;
      }
      shiftOpen(this.store, M.id, shift);
    }
    this.state.feed = to;
    this.state.feedSwitch = { at: Math.floor(Date.now() / 1000), from, to, shift };
    console.log(`[${M.id}] bougies : ${from} → ${to}${shift ? ` (positions décalées de ${shift.toFixed(Math.abs(shift) < 1 ? 5 : 2)})` : ''}`);
  }

  /** Un passage pour toutes les stratégies. Retourne les événements à publier. */
  async run() {
    const M = this.market;
    if (!M.enabled) return [];
    const tfs = [...new Set(this.strategies.map(tfOf))];
    const needsFx = this.strategies.some((s) => s.needsFx);
    const needsVix = this.strategies.some((s) => s.needsVix) || (this.cfg.ftmoEnabled && this.cfg.ftmoAi && this.cfg.ftmoAi !== 'off'); // VIX : contexte de l'IA validatrice
    const auxList = require('./aux').auxKeys(this.strategies);
    let data;
    try {
      data = await M.fetch(tfs, { needsFx, needsVix, aux: auxList });
    } catch (err) {
      console.warn(`[${M.id}] données indisponibles (${err.message}), passage ignoré`);
      return [];
    }
    // Bougies Yahoo figées mais cours à jour (jour férié américain, panne) : bougies maison (src/staleFeed.js)
    if (this.cfg.staleFeedFallback !== false) data = await require('./staleFeed').patch(M, data).catch(() => data);
    this.state.synthetic = !!data.synthetic;
    const { price, stops, daily, fx, vix, aux = {}, series } = data;
    if (!price) {
      console.warn(`[${M.id}] prix indisponible, passage ignoré`);
      return [];
    }
    // Changement de source des bougies (Yahoo ↔ OANDA / Binance) : les positions ouvertes sont décalées de l'écart de cotation
    const feed = data.feed || 'yahoo';
    if (feed !== (this.state.feed || 'yahoo')) {
      try {
        await this.switchFeed(this.state.feed || 'yahoo', feed);
      } catch (err) {
        console.warn(`[${M.id}] changement de source reporté (${err.message})`);
        return [];
      }
    }
    const now = Math.floor(Date.now() / 1000);
    // Indicateurs calculés une fois par unité de temps et par famille de stratégies, sur les bougies clôturées
    const kindOf = (s) => (s.compute ? 'scalp2' : s.intraday ? 'intraday' : 'all');
    const byTf = {};
    for (const strat of this.strategies) {
      const tf = tfOf(strat);
      const key = `${tf}:${kindOf(strat)}`;
      if (byTf[key] || !series[tf]) continue;
      const sec = TF_SEC[tf];
      const closed = series[tf].filter((c) => c.t + sec <= now);
      const ind = strat.compute ? strat.compute(closed, sec, M.id)
        : strat.intraday ? require('./intraday').computeIntraday(closed, sec, series['1h'])
          : computeAll(closed, daily, sec, fx, vix, aux);
      byTf[key] = { closed, ind };
    }
    const events = [];
    this.state.lastPrice = price;
    this.state.lastUpdate = Date.now();
    this.state.lastBarT = stops?.[stops.length - 1]?.t ?? null; // début de la dernière bougie 5 min (retard de la source)
    // Contexte de marché pour l'IA validatrice du compte FTMO (60 dernières bougies journalières, VIX)
    if (daily?.length) this.state.ctx = { daily: daily.slice(-60).map((k) => ({ t: k.t, c: k.c })), vix: vix?.length ? vix.slice(-5).map((k) => ({ t: k.t, c: k.c })) : null };
    // Tendance journalière de la veille (clôture vs EMA 50 vs EMA 200), pour le filtre de tendance de l'intraday FTMO
    if (daily?.length) this.state.trend = dailyTrend(daily, Math.floor(Date.now() / 1000));

    for (const strat of this.strategies) {
      const acc = this.account(strat.id);

      // 1. Stop / objectif touchés depuis le dernier passage (bougies 5 min)
      const prevCheck = acc.position ? acc.position.checkedFrom ?? acc.position.entryT : null;
      if (acc.position && stops) {
        for (const c of stops.filter((x) => x.t + 300 > acc.position.checkedFrom)) {
          const hit = hitInCandle(acc.position, c);
          if (hit) {
            events.push(this.#close(strat, acc, hit.price, hit.reason, now));
            break;
          }
        }
      }
      // Cours actuel au-delà du stop (ou de l'objectif) alors que la bougie 5 min correspondante n'est pas encore
      // publiée (délai des données) : clôture AVANT toute sortie sur signal. Marché continu depuis le passage précédent
      // (< 1 h) → au niveau du stop, comme un vrai ordre stop ; sinon (coupure, week-end) → au cours actuel.
      if (acc.position && price) {
        const hit = hitInCandle(acc.position, { h: price, l: price });
        if (hit) {
          const continuous = prevCheck && now - prevCheck < 3600;
          events.push(this.#close(strat, acc, continuous ? hit.price : price, continuous ? hit.reason : `${hit.reason} (gap)`, now));
        }
      }
      if (acc.position && stops) acc.position.checkedFrom = now;

      // 2. Nouvelle bougie clôturée sur l'unité de temps de la stratégie → évaluation
      const d = byTf[`${tfOf(strat)}:${kindOf(strat)}`];
      if (!d) continue;
      const { closed, ind } = d;
      const i = closed.length - 1;
      if (i < strat.warmup || closed[i].t <= acc.lastEvalT) continue;
      acc.lastEvalT = closed[i].t;
      const sig = strat.evaluate(ind, i);
      if (acc.position) {
        trailStop(strat, acc.position, ind, i);
        const p = acc.position;
        if ((p.side === 'long' && sig.exitLong) || (p.side === 'short' && sig.exitShort)) {
          events.push(this.#close(strat, acc, price, 'exit signal', now));
        }
      }
      if (!acc.position && sig.entry) {
        const size = Math.max(0, (acc.capital * M.positionPct) / 100);
        if (size <= 0) continue;
        acc.position = openPos(sig.entry, price, sig, size, now);
        events.push({ type: 'open', market: M, strategy: strat, pos: acc.position, rsi: ind.rsi?.[i] ?? ind.rsi2?.[i] ?? null });
      }
    }
    this.snapshot(now);
    this.save();
    return events;
  }

  #close(strat, acc, price, reason, t) {
    // Scalps (1 à 15 min) : frais d'un CFD (écart serré) plutôt que ceux d'un achat d'or physique / PAXG
    const scalp = ['1m', '5m', '15m'].includes(strat.tf) && this.market.scalpFeePct != null;
    const trade = closePos(acc.position, price, reason, t, scalp ? this.market.scalpFeePct : this.market.feePct, this.market.financingPct);
    acc.capital += trade.pnlUsd;
    trade.capital = acc.capital;
    acc.position = null;
    acc.closed.push(trade);
    return { type: 'close', market: this.market, strategy: strat, trade, capital: acc.capital, start: this.market.startCapital };
  }

  stats() {
    const price = this.state.lastPrice;
    const start = this.market.startCapital;
    const rows = this.strategies.map((strat) => {
      const acc = this.account(strat.id);
      const equity = this.equity(acc, price);
      return {
        strategy: strat,
        ...summarize(acc.closed),
        position: acc.position,
        unrealized: unrealized(acc.position, price),
        capital: acc.capital,
        equity,
        returnPct: (equity / start - 1) * 100,
      };
    });
    const totalEquity = rows.reduce((s, r) => s + r.equity, 0);
    return {
      market: this.market,
      price,
      rows,
      start,
      totalStart: start * rows.length,
      totalEquity,
      totalPnl: rows.reduce((s, r) => s + r.pnlUsd, 0),
      since: (this.state.curve || [])[0]?.t || null,
    };
  }
}

module.exports = { dailyTrend, MarketTrader, backtest, unrealized, fetchHistory, fetchBacktestData, fetchCandles, cachedHistory, rollingHistory, fetchEurUsd, hitInCandle, closePos };
