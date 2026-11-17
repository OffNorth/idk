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

/** Price Volume Trend : cumul de (variation % du prix × volume). */
function pvt(candles) {
  const out = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].c;
    out.push(out[i - 1] + (prev ? ((candles[i].c - prev) / prev) * (candles[i].v || 0) : 0));
  }
  return out;
}

/**
 * Tendance journalière pour chaque bougie 1 h (dernière bougie jour CLÔTURÉE avant la fin de l'heure) :
 *  +1 = haussière (clôture > MM200 et MM20 > MM50), −1 = baissière (l'inverse), 0 = neutre / inconnue.
 */
function dailyTrend(hourly, daily, barSec = 3600) {
  const out = new Array(hourly.length).fill(0);
  if (!daily || daily.length < 200) return out;
  const closes = daily.map((d) => d.c);
  const m20 = sma(closes, 20);
  const m50 = sma(closes, 50);
  const m200 = sma(closes, 200);
  let j = -1;
  for (let i = 0; i < hourly.length; i++) {
    const end = hourly[i].t + barSec;
    while (j + 1 < daily.length && daily[j + 1].t + 86400 <= end) j++;
    if (j < 0 || m200[j] === null) continue;
    if (closes[j] > m200[j] && m20[j] > m50[j]) out[i] = 1;
    else if (closes[j] < m200[j] && m20[j] < m50[j]) out[i] = -1;
  }
  return out;
}

/** Chandeliers de retournement : +1 haussier (marteau / avalement), −1 baissier (étoile filante / avalement). */
function candlePattern(candles) {
  return candles.map((c, i) => {
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l;
    if (range <= 0) return 0;
    const upper = c.h - Math.max(c.o, c.c);
    const lower = Math.min(c.o, c.c) - c.l;
    const p = candles[i - 1];
    const bullEngulf = p && p.c < p.o && c.c > c.o && c.c >= p.o && c.o <= p.c;
    const bearEngulf = p && p.c > p.o && c.c < c.o && c.c <= p.o && c.o >= p.c;
    const hammer = lower >= 2 * body && upper <= Math.max(body, range * 0.1) && body > 0;
    const star = upper >= 2 * body && lower <= Math.max(body, range * 0.1) && body > 0;
    if (bullEngulf || hammer) return 1;
    if (bearEngulf || star) return -1;
    return 0;
  });
}

/** Plus haut / plus bas des n dernières bougies (courante incluse) et position de chacun. */
function swings(candles, n) {
  const hi = [];
  const lo = [];
  const hiIdx = [];
  const loIdx = [];
  for (let i = 0; i < candles.length; i++) {
    let h = -Infinity;
    let l = Infinity;
    let hI = i;
    let lI = i;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      if (candles[j].h > h) { h = candles[j].h; hI = j; }
      if (candles[j].l < l) { l = candles[j].l; lI = j; }
    }
    hi.push(h);
    lo.push(l);
    hiIdx.push(hI);
    loIdx.push(lI);
  }
  return { hi, lo, hiIdx, loIdx };
}

/**
 * Range de la session asiatique (00:00–06:59 UTC) du jour, pour chaque bougie 1 h à partir de 07:00 UTC.
 * null avant 07:00 ou si la session est incomplète.
 */
function asiaRange(candles) {
  const hi = new Array(candles.length).fill(null);
  const lo = new Array(candles.length).fill(null);
  let day = -1;
  let h = -Infinity;
  let l = Infinity;
  let n = 0;
  candles.forEach((c, i) => {
    const d = Math.floor(c.t / 86400);
    const hour = Math.floor((c.t % 86400) / 3600);
    if (d !== day) {
      day = d;
      h = -Infinity;
      l = Infinity;
      n = 0;
    }
    if (hour < 7) {
      h = Math.max(h, c.h);
      l = Math.min(l, c.l);
      n++;
    } else if (n >= 6) {
      hi[i] = h;
      lo[i] = l;
    }
  });
  return { hi, lo };
}

/** Ichimoku : tenkan (9), kijun (26) et nuage projeté de 26 bougies (valeurs applicables à la bougie i). */
function ichimoku(candles) {
  const mid = (n, i) => {
    if (i < n - 1) return null;
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      h = Math.max(h, candles[j].h);
      l = Math.min(l, candles[j].l);
    }
    return (h + l) / 2;
  };
  const tenkan = candles.map((_, i) => mid(9, i));
  const kijun = candles.map((_, i) => mid(26, i));
  const spanA = candles.map((_, i) => (tenkan[i] !== null && kijun[i] !== null ? (tenkan[i] + kijun[i]) / 2 : null));
  const spanB = candles.map((_, i) => mid(52, i));
  const top = candles.map((_, i) => (i >= 26 && spanA[i - 26] !== null && spanB[i - 26] !== null ? Math.max(spanA[i - 26], spanB[i - 26]) : null));
  const bottom = candles.map((_, i) => (i >= 26 && spanA[i - 26] !== null && spanB[i - 26] !== null ? Math.min(spanA[i - 26], spanB[i - 26]) : null));
  return { tenkan, kijun, top, bottom };
}

/** ADX (Wilder) avec +DI / −DI. */
function adx(candles, n = 14) {
  const len = candles.length;
  const pdi = new Array(len).fill(null);
  const mdi = new Array(len).fill(null);
  const out = new Array(len).fill(null);
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  let dxAvg = null;
  for (let i = 1; i < len; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const up = c.h - p.h;
    const down = p.l - c.l;
    const t = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    const pm = up > down && up > 0 ? up : 0;
    const mm = down > up && down > 0 ? down : 0;
    if (i <= n) {
      tr += t;
      pdm += pm;
      mdm += mm;
    } else {
      tr = tr - tr / n + t;
      pdm = pdm - pdm / n + pm;
      mdm = mdm - mdm / n + mm;
    }
    if (i >= n && tr > 0) {
      pdi[i] = (100 * pdm) / tr;
      mdi[i] = (100 * mdm) / tr;
      const s = pdi[i] + mdi[i];
      const dx = s > 0 ? (100 * Math.abs(pdi[i] - mdi[i])) / s : 0;
      dxAvg = dxAvg === null ? dx : (dxAvg * (n - 1) + dx) / n;
      if (i >= 2 * n) out[i] = dxAvg;
    }
  }
  return { adx: out, pdi, mdi };
}

/** Bougies Heikin-Ashi. */
function heikinAshi(candles) {
  const out = [];
  candles.forEach((c, i) => {
    const hc = (c.o + c.h + c.l + c.c) / 4;
    const ho = i === 0 ? (c.o + c.c) / 2 : (out[i - 1].o + out[i - 1].c) / 2;
    out.push({ o: ho, c: hc, h: Math.max(c.h, ho, hc), l: Math.min(c.l, ho, hc) });
  });
  return out;
}

/**
 * Signal dollar pour chaque bougie, à partir de l'EUR/USD journalier (dernier jour clôturé) :
 * +1 = euro au-dessus de sa moyenne 50 jours (dollar faible, favorable à l'or), −1 = l'inverse, 0 = inconnu.
 */
function dollarSignal(candles, fxDaily, barSec) {
  const out = new Array(candles.length).fill(0);
  if (!fxDaily || fxDaily.length < 60) return out;
  const closes = fxDaily.map((d) => d.c);
  const m50 = sma(closes, 50);
  let j = -1;
  for (let i = 0; i < candles.length; i++) {
    const end = candles[i].t + barSec;
    while (j + 1 < fxDaily.length && fxDaily[j + 1].t + 86400 <= end) j++;
    if (j >= 0 && m50[j] !== null) out[i] = closes[j] > m50[j] ? 1 : -1;
  }
  return out;
}

/**
 * Calendrier (bougies journalières) : rang du jour de bourse dans le mois (1 = premier)
 * et nombre de jours ouvrés (lun–ven) restant dans le mois APRÈS ce jour.
 */
function calendar(candles) {
  const tdom = [];
  const bizLeft = [];
  candles.forEach((c, i) => {
    const d = new Date(c.t * 1000);
    const prev = i > 0 ? new Date(candles[i - 1].t * 1000) : null;
    const same = prev && prev.getUTCMonth() === d.getUTCMonth() && prev.getUTCFullYear() === d.getUTCFullYear();
    tdom.push(same ? tdom[i - 1] + 1 : 1);
    let left = 0;
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    while (x.getUTCMonth() === d.getUTCMonth()) {
      const wd = x.getUTCDay();
      if (wd !== 0 && wd !== 6) left++;
      x.setUTCDate(x.getUTCDate() + 1);
    }
    bizLeft.push(left);
  });
  return { tdom, bizLeft };
}

/** Série journalière externe (VIX, taux 10 ans, dollar…) alignée sur les bougies (dernière valeur connue) + moyennes. */
function alignVix(candles, vix) {
  const n = candles.length;
  const col = () => new Array(n).fill(null);
  const out = { c: col(), sma10: col(), sma20: col(), sma50: col(), sma200: col(), r21: col(), r126: col(), r252: col() };
  if (!vix || vix.length < 60) return out;
  const closes = vix.map((v) => v.c);
  const src = { sma10: sma(closes, 10), sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200), r21: roc(closes, 21), r126: roc(closes, 126), r252: roc(closes, 252) };
  let j = -1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < vix.length && vix[j + 1].t <= candles[i].t) j++;
    if (j < 0) continue;
    out.c[i] = closes[j];
    for (const k of Object.keys(src)) out[k][i] = src[k][j];
  }
  return out;
}

/** Rapport prix / série externe (ex. or / argent) et sa moyenne sur n bougies. */
function ratioSeries(closes, other, n = 50) {
  const r = closes.map((c, i) => (other.c[i] ? c / other.c[i] : null));
  const avg = r.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) {
      if (r[j] === null) return null;
      s += r[j];
    }
    return s / n;
  });
  return { r, avg };
}

/** Plus bas / plus haut des clôtures sur n bougies (courante incluse) — fenêtre glissante en O(n). */
function rollingCloses(closes, n) {
  const min = [];
  const max = [];
  const qMin = [];
  const qMax = [];
  for (let i = 0; i < closes.length; i++) {
    while (qMin.length && closes[qMin[qMin.length - 1]] >= closes[i]) qMin.pop();
    while (qMax.length && closes[qMax[qMax.length - 1]] <= closes[i]) qMax.pop();
    qMin.push(i);
    qMax.push(i);
    while (qMin[0] <= i - n) qMin.shift();
    while (qMax[0] <= i - n) qMax.shift();
    min.push(closes[qMin[0]]);
    max.push(closes[qMax[0]]);
  }
  return { min, max };
}

/** Volatilité réalisée sur 20 bougies (écart-type des rendements) et sa moyenne sur 252 bougies. */
function realizedVol(closes) {
  const ret = closes.map((c, i) => (i ? Math.log(c / closes[i - 1]) : 0));
  const rv20 = ret.map((_, i) => {
    if (i < 20) return null;
    let m = 0;
    for (let j = i - 19; j <= i; j++) m += ret[j];
    m /= 20;
    let v = 0;
    for (let j = i - 19; j <= i; j++) v += (ret[j] - m) ** 2;
    return Math.sqrt(v / 19);
  });
  const avg = sma(rv20.map((x) => x ?? 0), 252).map((x, i) => (i >= 272 ? x : null));
  return { rv20, rv20avg: avg };
}

/** Rendement sur n bougies (null au début). */
function roc(closes, n) {
  return closes.map((c, i) => (i >= n ? c / closes[i - n] - 1 : null));
}

/** Calcule tous les indicateurs utilisés par les stratégies, une seule fois. barSec = durée d'une bougie. */
function computeAll(candles, daily = null, barSec = 3600, fx = null, vix = null, aux = {}) {
  const closes = candles.map((c) => c.c);
  const p = pvt(candles);
  const bb = bollinger(closes, 20, 2);
  const bandwidth = closes.map((_, i) => (bb.mid[i] ? (bb.upper[i] - bb.lower[i]) / bb.mid[i] : null));
  return {
    ibs: candles.map((c) => (c.h > c.l ? (c.c - c.l) / (c.h - c.l) : 0.5)),
    c7: rollingCloses(closes, 7),
    cal: barSec === 86400 ? calendar(candles) : null,
    vix: alignVix(candles, vix),
    tnx: alignVix(candles, aux.tnx),
    dxy: alignVix(candles, aux.dxy),
    peer: alignVix(candles, aux.peer),
    sox: alignVix(candles, aux.sox),
    gsr: (() => { const sil = alignVix(candles, aux.silver); return ratioSeries(closes, sil, 50); })(),
    roc21: roc(closes, 21),
    roc126: roc(closes, 126),
    roc252: roc(closes, 252),
    c50: rollingCloses(closes, 50),
    c252: rollingCloses(closes, 252),
    month: candles.map((c) => new Date(c.t * 1000).getUTCMonth() + 1),
    weekday: candles.map((c) => new Date(c.t * 1000).getUTCDay()),
    rsi2sum: (() => { const r = rsi(closes, 2); return r.map((v, i) => (i > 0 && v !== null && r[i - 1] !== null ? v + r[i - 1] : null)); })(),
    pctB: closes.map((c, i) => (bb.upper[i] !== null && bb.upper[i] > bb.lower[i] ? (c - bb.lower[i]) / (bb.upper[i] - bb.lower[i]) : null)),
    c20: rollingCloses(closes, 20),
    ...realizedVol(closes),
    ema10: ema(closes, 10),
    ichi: ichimoku(candles),
    adx: adx(candles, 14),
    ha: heikinAshi(candles),
    bandwidth,
    dollar: dollarSignal(candles, fx, barSec),
    candles,
    closes,
    barSec,
    hour: candles.map((c) => Math.floor((c.t % 86400) / 3600)),
    sma5: sma(closes, 5),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi2: rsi(closes, 2),
    roc63: roc(closes, 63),
    dc55: donchian(candles, 55),
    asia: barSec === 3600 ? asiaRange(candles) : null,
    sma10: sma(closes, 10),
    sma60: sma(closes, 60),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi: rsi(closes, 14),
    atr: atr(candles, 14),
    bb,
    macd: macd(closes),
    dc20: donchian(candles, 20),
    dc10: donchian(candles, 10),
    st: supertrend(candles, 10, 3),
    pvt: p,
    pvtSig: ema(p, 21),
    dTrend: dailyTrend(candles, daily, barSec),
    pattern: candlePattern(candles),
    sw48: swings(candles, 48),
  };
}

/* ------------------------------------------------------------------ */
/* Scalp (bougies 1 / 5 min) : jeu d'indicateurs léger                 */
/* ------------------------------------------------------------------ */

/** VWAP de séance (remise à zéro à 00:00 UTC) et écart-type pondéré autour du VWAP. */
function sessionVwap(candles) {
  const vwap = [];
  const sd = [];
  let day = -1;
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (const c of candles) {
    const d = Math.floor(c.t / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
      pv2 = 0;
    }
    const tp = (c.h + c.l + c.c) / 3;
    const v = c.v > 0 ? c.v : 1e-9;
    pv += tp * v;
    pv2 += tp * tp * v;
    vol += v;
    const m = pv / vol;
    vwap.push(m);
    sd.push(Math.sqrt(Math.max(0, pv2 / vol - m * m)));
  }
  return { vwap, sd };
}

/** Stochastique lent (%K lissé, %D). */
function stochastic(candles, n = 14, k = 3, d = 3) {
  const raw = candles.map((c, i) => {
    if (i < n - 1) return 50;
    let h = -Infinity;
    let l = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      h = Math.max(h, candles[j].h);
      l = Math.min(l, candles[j].l);
    }
    return h > l ? ((c.c - l) / (h - l)) * 100 : 50;
  });
  const K = sma(raw, k).map((x) => (x === null ? 50 : x));
  const D = sma(K, d).map((x) => (x === null ? 50 : x));
  return { k: K, d: D };
}

/**
 * Range d'ouverture d'une séance : plus haut / plus bas entre `startMin` et `startMin + lenMin` (minutes UTC),
 * disponible pour les bougies suivantes du même jour.
 */
function openingRange(candles, barSec, startMin, lenMin) {
  const hi = new Array(candles.length).fill(null);
  const lo = new Array(candles.length).fill(null);
  let day = -1;
  let h = -Infinity;
  let l = Infinity;
  candles.forEach((c, i) => {
    const d = Math.floor(c.t / 86400);
    const m = Math.floor((c.t % 86400) / 60);
    if (d !== day) {
      day = d;
      h = -Infinity;
      l = Infinity;
    }
    const end = m + barSec / 60;
    if (m >= startMin && end <= startMin + lenMin) {
      h = Math.max(h, c.h);
      l = Math.min(l, c.l);
    } else if (m >= startMin + lenMin && h > -Infinity) {
      hi[i] = h;
      lo[i] = l;
    }
  });
  return { hi, lo };
}

/** Indicateurs utilisés par les stratégies de scalp (bien plus léger que computeAll). */
function computeScalp(candles, barSec = 300) {
  const closes = candles.map((c) => c.c);
  return {
    candles,
    closes,
    barSec,
    minute: candles.map((c) => Math.floor((c.t % 86400) / 60)),
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    ema50: ema(closes, 50),
    rsi: rsi(closes, 14),
    rsi7: rsi(closes, 7),
    atr: atr(candles, 14),
    bb: bollinger(closes, 20, 2),
    vw: sessionVwap(candles),
    stoch: stochastic(candles, 14, 3, 3),
    orLondon: openingRange(candles, barSec, 7 * 60, 30),
    orNy: openingRange(candles, barSec, 13 * 60 + 30, 30),
  };
}

module.exports = {
  sessionVwap, stochastic, openingRange, computeScalp,
  sma, ema, rsi, atr, bollinger, macd, donchian, supertrend, pvt, dailyTrend, candlePattern, swings, asiaRange, roc,
  ichimoku, adx, heikinAshi, dollarSignal, calendar, alignVix, rollingCloses, computeAll,
};
