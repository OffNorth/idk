/**
 * Indicateurs et stratégies intraday du NAS100 (bougies 5 min de l'indice ^NDX, séance cash 9:30–16:00 New York),
 * d'après la « Formation complète : Trading en bourse, TradingView & NAS100 » (module 5) :
 *   A. cassure du range d'ouverture 15 min (ORB), B. repli VWAP / EMA 20 dans la tendance, C. chasse aux stops.
 * Les heures sont en heure de New York (changement d'heure géré), comme 15:30 / 17:30 heure de Paris.
 */
const { ema, atr, rsi, candlePattern } = require('./indicators');

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Heure de New York d'un timestamp : { day: 'AAAA-MM-JJ', min: minutes depuis minuit }. */
function nyTime(t) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** Regroupe des bougies par clé et renvoie, pour chaque bougie d'origine, l'indice du dernier groupe TERMINÉ. */
function groupBars(candles, keyOf) {
  const groups = [];
  const lastDone = [];
  let cur = null;
  candles.forEach((c) => {
    const k = keyOf(c);
    if (!cur || cur.k !== k) {
      if (cur) groups.push(cur);
      cur = { k, o: c.o, h: c.h, l: c.l, c: c.c, t: c.t };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
    lastDone.push(groups.length - 1);
  });
  if (cur) groups.push(cur);
  return { groups, lastDone };
}

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;

/**
 * @param hourly  bougies 1 h plus longues (optionnel) pour l'EMA 200 H1 ; sinon calculée sur les bougies 5 min regroupées.
 */
function computeIntraday(candles, barSec = 300, hourly = null) {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const time = candles.map((c) => nyTime(c.t));
  const day = time.map((x) => x.day);
  const min = time.map((x) => x.min);

  // VWAP de la séance cash (repart à 9:30 chaque jour)
  const vwap = new Array(n).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || day[i] !== day[i - 1]) {
      pv = 0;
      vol = 0;
    }
    if (min[i] < RTH_OPEN) continue;
    const c = candles[i];
    const v = c.v > 0 ? c.v : 1;
    pv += ((c.h + c.l + c.c) / 3) * v;
    vol += v;
    vwap[i] = pv / vol;
  }

  // Tendance H1 : EMA 200 sur bougies 1 h (dernière heure terminée)
  let ema200h;
  if (hourly && hourly.length > 200) {
    const he = ema(hourly.map((h) => h.c), 200);
    let j = -1;
    ema200h = candles.map((c) => {
      while (j + 1 < hourly.length && hourly[j + 1].t + 3600 <= c.t + barSec) j++;
      return j >= 199 ? he[j] : null;
    });
  } else {
    const h1 = groupBars(candles, (c) => Math.floor(c.t / 3600));
    const h1Ema = ema(h1.groups.map((g) => g.c), 200);
    ema200h = h1.lastDone.map((g) => (g >= 199 ? h1Ema[g] : null));
  }

  // Tendance et volatilité M15
  const m15 = groupBars(candles, (c) => Math.floor(c.t / 900));
  const m15c = m15.groups.map((g) => g.c);
  const e20 = ema(m15c, 20);
  const e50 = ema(m15c, 50);
  const a15 = atr(m15.groups, 14);
  const ema20m15 = m15.lastDone.map((g) => (g >= 50 ? e20[g] : null));
  const ema50m15 = m15.lastDone.map((g) => (g >= 50 ? e50[g] : null));
  const atr15 = m15.lastDone.map((g) => (g >= 14 ? a15[g] : null));

  // Range d'ouverture 9:30–9:45 et plus haut / plus bas de la veille (séance cash)
  const orHi = new Array(n).fill(null);
  const orLo = new Array(n).fill(null);
  const pdh = new Array(n).fill(null);
  const pdl = new Array(n).fill(null);
  const dayHi = new Array(n).fill(null);
  const dayLo = new Array(n).fill(null);
  let dH = -Infinity;
  let dL = Infinity;
  let prevH = null;
  let prevL = null;
  let oH = -Infinity;
  let oL = Infinity;
  for (let i = 0; i < n; i++) {
    if (i > 0 && day[i] !== day[i - 1]) {
      if (dH > -Infinity) {
        prevH = dH;
        prevL = dL;
      }
      dH = -Infinity;
      dL = Infinity;
      oH = -Infinity;
      oL = Infinity;
    }
    const c = candles[i];
    pdh[i] = prevH;
    pdl[i] = prevL;
    if (min[i] >= RTH_OPEN && min[i] < RTH_CLOSE) {
      dH = Math.max(dH, c.h);
      dL = Math.min(dL, c.l);
      dayHi[i] = dH;
      dayLo[i] = dL;
    }
    if (min[i] >= RTH_OPEN && min[i] + barSec / 60 <= RTH_OPEN + 15) {
      oH = Math.max(oH, c.h);
      oL = Math.min(oL, c.l);
    } else if (min[i] >= RTH_OPEN + 15 && oH > -Infinity) {
      orHi[i] = oH;
      orLo[i] = oL;
    }
  }

  return {
    candles, closes, barSec, day, min,
    vwap, ema200h, ema20m15, ema50m15, atr15,
    ema20: ema(closes, 20),
    atr: atr(candles, 14),
    rsi: rsi(closes, 14),
    pattern: candlePattern(candles),
    orHi, orLo, pdh, pdl, dayHi, dayLo,
  };
}

/* ------------------------------------------------------------------ */
/* Stratégies (achat ET vente : intraday, pas de financement de nuit)  */
/* ------------------------------------------------------------------ */

const inWindow = (ind, i) => ind.min[i] >= RTH_OPEN + 15 && ind.min[i] < 11 * 60 + 30; // 9:45–11:30 NY
const flat = (ind, i) => ind.min[i] >= 15 * 60 + 55 || ind.min[i] < RTH_OPEN; // tout fermé avant la clôture
const BASE = { tf: '5m', markets: ['nas100'], intraday: true, warmup: 60 };

/** Nombre de bougies du jour, avant i, où `cond` était vraie (pour limiter à 2 trades par jour). */
function countToday(ind, i, cond) {
  let n = 0;
  for (let j = i - 1; j >= 0 && ind.day[j] === ind.day[i]; j--) if (cond(j)) n++;
  return n;
}

const INTRADAY = [
  {
    ...BASE,
    id: 'orb15',
    name: 'NAS100 · A. Cassure du range d’ouverture 15 min',
    desc: 'Formation NAS100, stratégie A : range de 9:30 à 9:45 (New York) ; pas de trade si le range dépasse 3 ATR M15. Entrée à la première clôture M5 hors du range, dans le sens du biais H1 (prix vs EMA 200 H1 et VWAP). Stop au milieu du range, objectif 2R, sortie si une bougie M5 reclôture dans le range. Un trade par jour au plus, tout fermé à 15:55.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const hi = ind.orHi[i];
      const lo = ind.orLo[i];
      const none = { entry: null, exitLong: flat(ind, i) || (hi !== null && c < hi), exitShort: flat(ind, i) || (lo !== null && c > lo), sl: 0, tp: null };
      if (hi === null || !inWindow(ind, i) || ind.ema200h[i] === null || ind.atr15[i] === null) return none;
      if (hi - lo > 3 * ind.atr15[i]) return none;
      const firstBreak = countToday(ind, i, (j) => ind.orHi[j] !== null && (ind.closes[j] > ind.orHi[j] || ind.closes[j] < ind.orLo[j])) === 0;
      if (!firstBreak) return none;
      const mid = (hi + lo) / 2;
      const up = c > ind.ema200h[i] && c > ind.vwap[i];
      const down = c < ind.ema200h[i] && c < ind.vwap[i];
      if (c > hi && up) {
        const risk = Math.max(c - mid, 0.3 * ind.atr[i]);
        return { ...none, exitLong: false, entry: 'long', sl: risk, tp: 2 * risk };
      }
      if (c < lo && down) {
        const risk = Math.max(mid - c, 0.3 * ind.atr[i]);
        return { ...none, exitShort: false, entry: 'short', sl: risk, tp: 2 * risk };
      }
      return none;
    },
  },
  {
    ...BASE,
    id: 'vwappb',
    name: 'NAS100 · B. Repli VWAP / EMA 20 dans la tendance',
    desc: 'Formation NAS100, stratégie B : tendance M15 (EMA 20 > EMA 50, prix du bon côté du VWAP) ; repli qui touche le VWAP ou l’EMA 20 ; bougie M5 de rejet (marteau / avalement) → entrée. Stop sous le plus bas du repli − 0,3 ATR M5, objectif 2R ; sortie si le prix repasse de l’autre côté du VWAP. 2 trades par jour au plus, de 9:45 à 11:30 New York.',
    evaluate(ind, i) {
      const k = ind.candles;
      const c = k[i];
      const v = ind.vwap[i];
      const none = { entry: null, exitLong: flat(ind, i) || (v !== null && c.c < v), exitShort: flat(ind, i) || (v !== null && c.c > v), sl: 0, tp: null };
      if (!inWindow(ind, i) || v === null || ind.ema50m15[i] === null) return none;
      const tol = 0.2 * ind.atr[i];
      const sig = (j) => {
        const b = k[j];
        const vw = ind.vwap[j];
        if (vw === null || ind.ema50m15[j] === null || !inWindow(ind, j)) return null;
        const upT = ind.ema20m15[j] > ind.ema50m15[j] && b.c > vw;
        const dnT = ind.ema20m15[j] < ind.ema50m15[j] && b.c < vw;
        const touchLow = Math.min(Math.abs(b.l - vw), Math.abs(b.l - ind.ema20[j])) <= tol || b.l <= vw;
        const touchHigh = Math.min(Math.abs(b.h - vw), Math.abs(b.h - ind.ema20[j])) <= tol || b.h >= vw;
        if (upT && touchLow && ind.pattern[j] === 1) return 'long';
        if (dnT && touchHigh && ind.pattern[j] === -1) return 'short';
        return null;
      };
      const s = sig(i);
      if (!s || countToday(ind, i, (j) => sig(j) !== null) >= 2) return none;
      const lowPb = Math.min(k[i].l, k[i - 1].l, k[i - 2].l);
      const highPb = Math.max(k[i].h, k[i - 1].h, k[i - 2].h);
      if (s === 'long') {
        const risk = Math.max(c.c - lowPb + 0.3 * ind.atr[i], 0.3 * ind.atr[i]);
        return { ...none, exitLong: false, entry: 'long', sl: risk, tp: 2 * risk };
      }
      const risk = Math.max(highPb - c.c + 0.3 * ind.atr[i], 0.3 * ind.atr[i]);
      return { ...none, exitShort: false, entry: 'short', sl: risk, tp: 2 * risk };
    },
  },
  {
    ...BASE,
    id: 'sweep',
    name: 'NAS100 · C. Chasse aux stops puis retournement',
    desc: 'Formation NAS100, stratégie C : après 9:30, le prix dépasse le plus haut (ou le plus bas) de la veille avec une mèche puis la bougie M5 reclôture de l’autre côté → entrée dans le sens du retour. Stop au-delà de la mèche, objectif le VWAP puis le côté opposé du range de la journée, seulement si l’objectif est à au moins 2R. Un trade par niveau et par jour, de 9:30 à 11:30 New York.',
    evaluate(ind, i) {
      const k = ind.candles;
      const c = k[i];
      const none = { entry: null, exitLong: flat(ind, i), exitShort: flat(ind, i), sl: 0, tp: null };
      if (ind.min[i] < RTH_OPEN || ind.min[i] >= 11 * 60 + 30 || ind.pdh[i] === null || ind.vwap[i] === null) return none;
      const pad = 0.1 * ind.atr[i];
      const sweptHigh = (j) => k[j].h > ind.pdh[j] && k[j].c < ind.pdh[j];
      const sweptLow = (j) => k[j].l < ind.pdl[j] && k[j].c > ind.pdl[j];
      if (sweptHigh(i) && countToday(ind, i, sweptHigh) === 0) {
        const risk = c.h + pad - c.c;
        const target = Math.max(c.c - ind.vwap[i], c.c - ind.dayLo[i]); // VWAP, puis bas de la journée
        if (risk > 0 && target >= 2 * risk) return { ...none, entry: 'short', sl: risk, tp: target };
      }
      if (sweptLow(i) && countToday(ind, i, sweptLow) === 0) {
        const risk = c.c - (c.l - pad);
        const target = Math.max(ind.vwap[i] - c.c, ind.dayHi[i] - c.c); // VWAP, puis haut de la journée
        if (risk > 0 && target >= 2 * risk) return { ...none, entry: 'long', sl: risk, tp: target };
      }
      return none;
    },
  },
];

module.exports = { computeIntraday, nyTime, INTRADAY };
