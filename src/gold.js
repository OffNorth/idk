/**
 * Paper trading de l'or (PAXG/USD, 1 PAXG = 1 once d'or), en bougies 1 h.
 *
 * Stratégie de suivi de tendance :
 *   - LONG  quand l'EMA 20 croise au-dessus de l'EMA 50 et RSI 14 < 70
 *   - SHORT quand l'EMA 20 croise en dessous de l'EMA 50 et RSI 14 > 30
 *   - Stop loss = GOLD_ATR_SL × ATR 14, take profit = GOLD_ATR_TP × ATR 14
 *   - Un croisement inverse clôture la position en cours et ouvre la position opposée
 * Simulation uniquement : aucun ordre réel n'est passé.
 */
const { getJson } = require('./http');

const FILE = 'gold.json';
const H = 3600;

async function fetchCandles() {
  // Coinbase : [time, low, high, open, close, volume], du plus récent au plus ancien
  const cb = await getJson('https://api.exchange.coinbase.com/products/PAXG-USD/candles?granularity=3600');
  if (Array.isArray(cb) && cb.length > 60) {
    return cb.map(([t, l, h, o, c]) => ({ t, o, h, l, c })).sort((a, b) => a.t - b.t);
  }
  // Secours : Kraken
  const kr = await getJson('https://api.kraken.com/0/public/OHLC?pair=PAXGUSD&interval=60');
  const rows = kr?.result && Object.values(kr.result).find(Array.isArray);
  if (rows?.length > 60) return rows.map(([t, o, h, l, c]) => ({ t, o: +o, h: +h, l: +l, c: +c }));
  return null;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    if (i >= period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles, period = 14) {
  const out = [];
  candles.forEach((c, i) => {
    const tr = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    out.push(i === 0 ? tr : (out[i - 1] * (period - 1) + tr) / period);
  });
  return out;
}

/** Signal sur la dernière bougie CLÔTURÉE : 'long', 'short' ou null. */
function signal(closedCandles) {
  const closes = closedCandles.map((c) => c.c);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const r = rsi(closes);
  const a = atr(closedCandles);
  const i = closes.length - 1;
  const info = { t: closedCandles[i].t, price: closes[i], atr: a[i], rsi: r[i], fast: fast[i], slow: slow[i] };
  if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i] && r[i] < 70) return { side: 'long', ...info };
  if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i] && r[i] > 30) return { side: 'short', ...info };
  return { side: null, ...info };
}

class GoldTrader {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.state = store.loadJson(FILE, { position: null, closed: [], lastSignalT: 0 });
  }

  save() {
    if (this.state.closed.length > 300) this.state.closed = this.state.closed.slice(-300);
    this.store.saveJson(FILE, this.state);
  }

  /** Un passage : gestion de la position puis recherche de signal. Retourne les événements à publier. */
  async run() {
    if (!this.cfg.goldEnabled) return [];
    const candles = await fetchCandles();
    if (!candles) {
      console.warn('[or] prix indisponible, passage ignoré');
      return [];
    }
    const now = Math.floor(Date.now() / 1000);
    const closedCandles = candles.filter((c) => c.t + H <= now);
    const last = candles[candles.length - 1];
    const events = [];
    this.state.lastPrice = last.c;

    // 1. Stop loss / take profit touchés depuis l'entrée ? (bougies depuis l'ouverture, en cours incluse)
    const pos = this.state.position;
    if (pos) {
      for (const c of candles.filter((x) => x.t + H > pos.entryCandleT + H)) {
        const hitSl = pos.side === 'long' ? c.l <= pos.sl : c.h >= pos.sl;
        const hitTp = pos.side === 'long' ? c.h >= pos.tp : c.l <= pos.tp;
        if (hitSl) { events.push(this.#close(pos.sl, 'stop loss')); break; } // prudent : SL avant TP
        if (hitTp) { events.push(this.#close(pos.tp, 'take profit')); break; }
      }
    }

    // 2. Nouveau signal sur la dernière bougie clôturée (une seule fois par bougie)
    if (closedCandles.length < 60) return events;
    const sig = signal(closedCandles);
    this.state.lastSignal = { ...sig };
    if (sig.side && sig.t > this.state.lastSignalT) {
      this.state.lastSignalT = sig.t;
      const cur = this.state.position;
      if (cur && cur.side !== sig.side) events.push(this.#close(last.c, 'signal inverse'));
      if (!this.state.position) events.push(this.#open(sig, last.c));
    }
    this.save();
    return events;
  }

  #open(sig, price) {
    const { goldAtrSl, goldAtrTp, goldSizeUsd } = this.cfg;
    const dir = sig.side === 'long' ? 1 : -1;
    const pos = {
      side: sig.side,
      entry: price,
      sl: price - dir * goldAtrSl * sig.atr,
      tp: price + dir * goldAtrTp * sig.atr,
      size: goldSizeUsd,
      entryAt: Date.now(),
      entryCandleT: sig.t,
      rsi: sig.rsi,
    };
    this.state.position = pos;
    this.save();
    return { type: 'open', pos };
  }

  #close(price, reason) {
    const pos = this.state.position;
    const dir = pos.side === 'long' ? 1 : -1;
    const fees = 2 * (this.cfg.goldFeePct / 100);
    const pnlPct = (dir * (price / pos.entry - 1) - fees) * 100;
    const trade = { ...pos, exit: price, exitAt: Date.now(), reason, pnlPct, pnlUsd: (pos.size * pnlPct) / 100 };
    this.state.position = null;
    this.state.closed.push(trade);
    this.save();
    return { type: 'close', trade };
  }

  stats() {
    const closed = this.state.closed;
    const pos = this.state.position;
    const wins = closed.filter((t) => t.pnlUsd > 0).length;
    let unrealized = 0;
    if (pos && this.state.lastPrice) {
      const dir = pos.side === 'long' ? 1 : -1;
      unrealized = pos.size * dir * (this.state.lastPrice / pos.entry - 1);
    }
    return {
      trades: closed.length,
      wins,
      winRate: closed.length ? (wins / closed.length) * 100 : 0,
      realized: closed.reduce((s, t) => s + t.pnlUsd, 0),
      unrealized,
      position: pos,
      lastPrice: this.state.lastPrice,
      lastSignal: this.state.lastSignal,
    };
  }
}

module.exports = { GoldTrader, signal, ema, rsi, atr };
