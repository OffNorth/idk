/**
 * Indicateurs techniques classiques. Toutes les fonctions renvoient un tableau aligné sur l'entrée
 * (valeur null tant que l'indicateur n'a pas assez d'historique).
 * Bougie = { t, o, h, l, c } (t en secondes).
 */

function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function ema(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (i >= n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles, n = 14) {
  const out = [];
  candles.forEach((c, i) => {
    const tr = i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    out.push(i === 0 ? tr : (out[i - 1] * (n - 1) + tr) / n);
  });
  return out;
}

function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = [];
  const lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    upper.push(mid[i] + k * sd);
    lower.push(mid[i] - k * sd);
  }
  return { mid, upper, lower };
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const signal = ema(line, sig);
  return { line, signal };
}

/** Plus haut / plus bas des n bougies PRÉCÉDENTES (bougie courante exclue). */
function donchian(candles, n) {
  const hh = new Array(candles.length).fill(null);
  const ll = new Array(candles.length).fill(null);
  for (let i = n; i < candles.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n; j < i; j++) {
      h = Math.max(h, candles[j].h);
      l = Math.min(l, candles[j].l);
    }
    hh[i] = h;
    ll[i] = l;
  }
  return { hh, ll };
}

/** Supertrend : line = niveau du stop, dir = 1 (haussier) ou -1 (baissier). */
function supertrend(candles, n = 10, mult = 3) {
  const a = atr(candles, n);
  const line = [];
  const dir = [];
  let upper = 0;
  let lower = 0;
  candles.forEach((c, i) => {
    const hl2 = (c.h + c.l) / 2;
    const bu = hl2 + mult * a[i];
    const bl = hl2 - mult * a[i];
    if (i === 0) {
      upper = bu;
      lower = bl;
      dir.push(1);
      line.push(bl);
      return;
    }
    const prevC = candles[i - 1].c;
    upper = bu < upper || prevC > upper ? bu : upper;
    lower = bl > lower || prevC < lower ? bl : lower;
    let d = dir[i - 1];
    if (d === 1 && c.c < lower) d = -1;
    else if (d === -1 && c.c > upper) d = 1;
    dir.push(d);
    line.push(d === 1 ? lower : upper);
  });
  return { line, dir };
}

/** Calcule tous les indicateurs utilisés par les stratégies, une seule fois. */
function computeAll(candles) {
  const closes = candles.map((c) => c.c);
  return {
    closes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    atr: atr(candles, 14),
    bb: bollinger(closes, 20, 2),
    macd: macd(closes),
    dc20: donchian(candles, 20),
    dc10: donchian(candles, 10),
    st: supertrend(candles, 10, 3),
  };
}

module.exports = { sma, ema, rsi, atr, bollinger, macd, donchian, supertrend, computeAll };
