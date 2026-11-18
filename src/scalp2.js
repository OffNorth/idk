/**
 * Scalp, 2e série (bougies 1 et 5 min) — or et Nasdaq 100, plusieurs trades par jour.
 * Leçons de la 1re série (src/strategies.js, s_*) : sur de très petites bougies, le gain moyen par trade est minuscule
 * et les frais l'emportent. Ici, chaque idée vise un mouvement plus ample (objectif ≥ 1,5 à 2 fois le risque) et ne
 * trade qu'aux heures où le marché bouge (Londres / New York), dans le sens de la tendance 1 h quand c'est pertinent.
 *
 * Heures : New York (changement d'heure géré) pour le Nasdaq ; UTC pour l'or (Londres 7 h, New York 13 h 30).
 * L'or en PAXG s'échange aussi le week-end : ces bougies sont ignorées (le vrai marché de l'or est fermé).
 */
const { ema, atr, rsi, bollinger, sma } = require('./indicators');

/* ------------------------------------------------------------------ */
/* Heure de New York rapide (décalage calculé une fois par jour)        */
/* ------------------------------------------------------------------ */

const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
const offCache = new Map();
/** Décalage UTC → New York (en minutes, 240 en été, 300 en hiver) pour le jour UTC de t. */
function nyOffset(t) {
  const d = Math.floor(t / 86400);
  let o = offCache.get(d);
  if (o === undefined) {
    const noon = d * 86400 + 12 * 3600;
    const h = Number(NYF.format(new Date(noon * 1000))) % 24;
    o = (12 - h) * 60;
    offCache.set(d, o);
  }
  return o;
}

/** Valeur de la dernière bougie TERMINÉE d'une unité supérieure (sans regarder l'avenir). */
function htf(candles, sec, fn) {
  const groups = [];
  const idx = [];
  let cur = null;
  for (const c of candles) {
    const k = Math.floor(c.t / sec);
    if (!cur || cur.k !== k) {
      if (cur) groups.push(cur);
      cur = { k, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
    idx.push(groups.length - 1); // dernier groupe terminé
  }
  const vals = fn(groups);
  return idx.map((g) => (g >= 0 ? vals[g] : null));
}

/**
 * @param {'gold'|'nas100'} market
 */
function computeScalp2(candles, barSec = 300, market = 'gold') {
  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const nas = market === 'nas100';
  // minutes « de marché » : heure de New York pour le Nasdaq, UTC pour l'or
  const min = new Array(n);
  const day = new Array(n);
  const wd = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = candles[i].t;
    const lt = nas ? t - nyOffset(t) * 60 : t;
    min[i] = Math.floor((lt % 86400) / 60);
    day[i] = Math.floor(lt / 86400);
    wd[i] = new Date(lt * 1000).getUTCDay();
  }
  const a = atr(candles, 14);
  const vol = candles.map((c) => (c.v > 0 ? c.v : 0));
  const vAvg = sma(vol, 20);

  // VWAP de séance : 9 h 30 New York (Nasdaq) ou 7 h UTC, ouverture de Londres (or)
  const anchor = nas ? 9 * 60 + 30 : 7 * 60;
  const vwap = new Array(n).fill(null);
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || day[i] !== day[i - 1]) { pv = 0; vv = 0; }
    if (min[i] < anchor) continue;
    const c = candles[i];
    const v = c.v > 0 ? c.v : 1;
    pv += ((c.h + c.l + c.c) / 3) * v;
    vv += v;
    vwap[i] = pv / vv;
  }

  // Tendance 1 h : EMA 20 et EMA 50 des bougies 1 h terminées
  // (sur bougies 1 h et plus : tendance des JOURS terminés à la place)
  const tSec = barSec >= 3600 ? 86400 : 3600;
  const h1e20 = htf(candles, tSec, (g) => ema(g.map((x) => x.c), 20));
  const h1e50 = htf(candles, tSec, (g) => ema(g.map((x) => x.c), 50));

  // Plus haut / bas de la veille, du jour, range asiatique (00 h–06 h UTC) / pré-ouverture (4 h–9 h 30 NY), range d'ouverture 5 min
  const pdh = new Array(n).fill(null);
  const pdl = new Array(n).fill(null);
  const dOpen = new Array(n).fill(null);
  const rHi = new Array(n).fill(null);
  const rLo = new Array(n).fill(null);
  const orHi = new Array(n).fill(null);
  const orLo = new Array(n).fill(null);
  const pClose = new Array(n).fill(null); // clôture de la veille (séance)
  const rStart = nas ? 4 * 60 : 0;
  const rEnd = nas ? 9 * 60 + 30 : 6 * 60;
  const orEnd = nas ? 9 * 60 + 35 : 7 * 60 + 5;
  const sessEnd = nas ? 16 * 60 : 20 * 60;
  let dH = -Infinity, dL = Infinity, prevH = null, prevL = null, open = null, rh = -Infinity, rl = Infinity, oh = -Infinity, ol = Infinity;
  let lastSessClose = null, prevSessClose = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (i > 0 && day[i] !== day[i - 1]) {
      if (dH > -Infinity) { prevH = dH; prevL = dL; }
      if (lastSessClose !== null) prevSessClose = lastSessClose;
      dH = -Infinity; dL = Infinity; open = null; rh = -Infinity; rl = Infinity; oh = -Infinity; ol = Infinity;
    }
    pdh[i] = prevH;
    pdl[i] = prevL;
    pClose[i] = prevSessClose;
    if (min[i] >= rEnd && rh > -Infinity) { rHi[i] = rh; rLo[i] = rl; }
    if (min[i] >= orEnd && oh > -Infinity) { orHi[i] = oh; orLo[i] = ol; }
    if (min[i] >= anchor && open === null) open = c.o;
    dOpen[i] = open;
    if (min[i] >= rStart && min[i] < rEnd) { rh = Math.max(rh, c.h); rl = Math.min(rl, c.l); }
    if (min[i] >= anchor && min[i] < orEnd) { oh = Math.max(oh, c.h); ol = Math.min(ol, c.l); }
    if (min[i] >= anchor && min[i] < sessEnd) {
      dH = Math.max(dH, c.h);
      dL = Math.min(dL, c.l);
      lastSessClose = c.c;
    }
  }

  // Plus haut / bas des 20 bougies précédentes, largeur de Bollinger et son plus bas sur 100 bougies
  const hi20 = new Array(n).fill(null);
  const lo20 = new Array(n).fill(null);
  for (let i = 20; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - 20; j < i; j++) { h = Math.max(h, candles[j].h); l = Math.min(l, candles[j].l); }
    hi20[i] = h;
    lo20[i] = l;
  }
  const bb = bollinger(closes, 20, 2);
  const bw = closes.map((_, i) => (bb.mid[i] ? (bb.upper[i] - bb.lower[i]) / bb.mid[i] : null));
  const bwMin = bw.map((_, i) => {
    if (i < 120) return null;
    let m = Infinity;
    for (let j = i - 100; j < i; j++) if (bw[j] !== null) m = Math.min(m, bw[j]);
    return m;
  });

  return {
    candles, closes, barSec, market, min, day, wd, atr: a, vol, vAvg, vwap, h1e20, h1e50,
    pdh, pdl, dOpen, rHi, rLo, orHi, orLo, pClose, bb, bw, bwMin, hi20, lo20,
    ema20: ema(closes, 20), rsi2: rsi(closes, 2),
    ibs: candles.map((c) => (c.h > c.l ? (c.c - c.l) / (c.h - c.l) : 0.5)),
    ...oscillators(candles, closes, a),
    sess: nas ? { open: anchor, close: sessEnd } : { open: 7 * 60, close: 20 * 60 },
  };
}

/** Williams %R 10, CCI 20, stochastique rapide (14, 3), canal de Keltner (EMA 20 ± 2 ATR). */
function oscillators(candles, closes, a) {
  const n = candles.length;
  const wr10 = new Array(n).fill(null);
  const k14 = new Array(n).fill(null);
  for (let i = 13; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - 13; j <= i; j++) { h = Math.max(h, candles[j].h); l = Math.min(l, candles[j].l); if (j === i - 9) { /* rien */ } }
    k14[i] = h > l ? ((closes[i] - l) / (h - l)) * 100 : 50;
    let h10 = -Infinity, l10 = Infinity;
    for (let j = i - 9; j <= i; j++) { h10 = Math.max(h10, candles[j].h); l10 = Math.min(l10, candles[j].l); }
    wr10[i] = h10 > l10 ? ((h10 - closes[i]) / (h10 - l10)) * -100 : -50;
  }
  const stochK = sma(k14.map((v) => v ?? 50), 3);
  const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
  const tpMa = sma(tp, 20);
  const cci20 = tp.map((v, i) => {
    if (i < 19 || tpMa[i] === null) return null;
    let md = 0;
    for (let j = i - 19; j <= i; j++) md += Math.abs(tp[j] - tpMa[i]);
    md /= 20;
    return md > 0 ? (v - tpMa[i]) / (0.015 * md) : 0;
  });
  const e20 = ema(closes, 20);
  return { wr10, stochK, cci20, kUp: e20.map((v, i) => v + 2 * a[i]), kDn: e20.map((v, i) => v - 2 * a[i]) };
}

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */

const weekday = (ind, i) => ind.wd[i] >= 1 && ind.wd[i] <= 5;
/** Dans la séance active (après le 1er quart d'heure, avant la dernière demi-heure). */
const active = (ind, i) => weekday(ind, i) && ind.min[i] >= ind.sess.open + 15 && ind.min[i] < ind.sess.close - 30;
/** Fin de séance ou hors séance : tout est fermé. */
const flat = (ind, i) => !weekday(ind, i) || ind.min[i] >= ind.sess.close - 5 || ind.min[i] < ind.sess.open;
const trendUp = (ind, i) => ind.h1e20[i] !== null && ind.h1e50[i] !== null && ind.h1e20[i] > ind.h1e50[i] && ind.closes[i] > ind.h1e20[i];
const trendDown = (ind, i) => ind.h1e20[i] !== null && ind.h1e50[i] !== null && ind.h1e20[i] < ind.h1e50[i] && ind.closes[i] < ind.h1e20[i];
const lowest = (ind, i, k) => Math.min(...ind.candles.slice(Math.max(0, i - k + 1), i + 1).map((c) => c.l));
const highest = (ind, i, k) => Math.max(...ind.candles.slice(Math.max(0, i - k + 1), i + 1).map((c) => c.h));
const NONE = (ind, i) => ({ entry: null, exitLong: flat(ind, i), exitShort: flat(ind, i), sl: 0, tp: null });
/** Entrée avec stop à un prix donné et objectif en multiple du risque (refusée si le risque est absurde). */
function enter(ind, i, side, stopPrice, rr = 2, target = null) {
  const c = ind.closes[i];
  const risk = side === 'long' ? c - stopPrice : stopPrice - c;
  const a = ind.atr[i];
  if (!(risk > 0.2 * a) || risk > 4 * a) return NONE(ind, i);
  let tp = rr * risk;
  if (target !== null) {
    const dist = side === 'long' ? target - c : c - target;
    if (dist < 1.2 * risk) return NONE(ind, i); // objectif trop proche : pas rentable après frais
    tp = dist;
  }
  return { entry: side, exitLong: flat(ind, i), exitShort: flat(ind, i), sl: risk, tp };
}

const BASE = { tf: '5m', onlyTf: ['1m', '5m'], scalp: true, scalp2: true, warmup: 700, markets: ['gold', 'nas100'] };

/* ------------------------------------------------------------------ */
/* Stratégies                                                          */
/* ------------------------------------------------------------------ */

const SCALP2 = [
  {
    ...BASE,
    id: 'x_trendpb',
    name: 'Scalp repli sur EMA 20 dans la tendance 1 h',
    desc: 'Tendance 1 h haussière (EMA 20 > EMA 50, prix au-dessus) : achat quand une bougie touche l’EMA 20 puis clôture au-dessus, en hausse. Stop sous le plus bas des 5 dernières bougies, objectif 2 fois le risque. Inverse en tendance baissière. Tout fermé en fin de séance.',
    evaluate(ind, i) {
      if (!active(ind, i)) return NONE(ind, i);
      const k = ind.candles[i];
      const e = ind.ema20[i];
      if (trendUp(ind, i) && k.l <= e && k.c > e && k.c > k.o) return enter(ind, i, 'long', lowest(ind, i, 5) - 0.1 * ind.atr[i]);
      if (trendDown(ind, i) && k.h >= e && k.c < e && k.c < k.o) return enter(ind, i, 'short', highest(ind, i, 5) + 0.1 * ind.atr[i]);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_vwapbounce',
    name: 'Scalp rebond sur le VWAP',
    desc: 'Le prix est resté au-dessus du VWAP de la séance pendant au moins 1 h, en tendance 1 h haussière ; il revient toucher le VWAP et repart (clôture au-dessus, en hausse) → achat. Stop 1 ATR sous le VWAP, objectif 2 fois le risque. Inverse à la baisse.',
    evaluate(ind, i) {
      if (!active(ind, i) || ind.vwap[i] === null) return NONE(ind, i);
      const k = ind.candles[i];
      const v = ind.vwap[i];
      const bars = Math.round(3600 / ind.barSec);
      const above = () => { for (let j = i - bars; j < i; j++) if (ind.vwap[j] === null || ind.candles[j].l < ind.vwap[j]) return false; return true; };
      const below = () => { for (let j = i - bars; j < i; j++) if (ind.vwap[j] === null || ind.candles[j].h > ind.vwap[j]) return false; return true; };
      if (trendUp(ind, i) && k.l <= v && k.c > v && k.c > k.o && above()) return enter(ind, i, 'long', v - ind.atr[i]);
      if (trendDown(ind, i) && k.h >= v && k.c < v && k.c < k.o && below()) return enter(ind, i, 'short', v + ind.atr[i]);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_rangesweep',
    name: 'Scalp chasse aux stops du range de nuit',
    desc: 'Or : range asiatique (0 h–6 h UTC) ; Nasdaq : range de pré-ouverture (4 h–9 h 30 New York). Dans les 3 premières heures de la séance, si le prix dépasse un bord du range puis clôture de nouveau dedans (les stops ont été « chassés »), trade dans l’autre sens : stop au-delà de la mèche, objectif l’autre bord du range.',
    evaluate(ind, i) {
      const m = ind.min[i];
      if (!weekday(ind, i) || ind.rHi[i] === null || m < ind.sess.open || m > ind.sess.open + 180) return NONE(ind, i);
      const k = ind.candles[i];
      const hi = ind.rHi[i];
      const lo = ind.rLo[i];
      if (k.h > hi && k.c < hi && k.c < k.o) return enter(ind, i, 'short', k.h + 0.1 * ind.atr[i], 2, lo);
      if (k.l < lo && k.c > lo && k.c > k.o) return enter(ind, i, 'long', k.l - 0.1 * ind.atr[i], 2, hi);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_pdsweep',
    name: 'Scalp faux départ au-dessus / sous la veille',
    desc: 'Le prix dépasse le plus haut (ou plus bas) de la veille puis clôture de nouveau en dessous (au-dessus) avec une bougie de retournement → trade de retour vers le VWAP. Stop au-delà de la mèche, objectif le VWAP (au moins 1,2 fois le risque).',
    evaluate(ind, i) {
      if (!active(ind, i) || ind.pdh[i] === null || ind.vwap[i] === null) return NONE(ind, i);
      const k = ind.candles[i];
      if (k.h > ind.pdh[i] && k.c < ind.pdh[i] && k.c < k.o) return enter(ind, i, 'short', k.h + 0.1 * ind.atr[i], 2, ind.vwap[i]);
      if (k.l < ind.pdl[i] && k.c > ind.pdl[i] && k.c > k.o) return enter(ind, i, 'long', k.l - 0.1 * ind.atr[i], 2, ind.vwap[i]);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_orb5',
    name: 'Scalp cassure des 5 premières minutes',
    desc: 'Range de la première bougie de 5 min de la séance (9 h 30 New York ; 7 h UTC pour l’or). Cassure dans le sens de la tendance 1 h, avec un volume supérieur à 1,5 fois la moyenne, dans les 90 minutes : stop de l’autre côté du range, objectif 2 fois le risque.',
    evaluate(ind, i) {
      const m = ind.min[i];
      if (!weekday(ind, i) || ind.orHi[i] === null || m > ind.sess.open + 90) return NONE(ind, i);
      const k = ind.candles[i];
      const p = ind.closes[i - 1];
      const volOk = !ind.vAvg[i] || ind.vol[i] > 1.5 * ind.vAvg[i];
      if (volOk && trendUp(ind, i) && k.c > ind.orHi[i] && p <= ind.orHi[i]) return enter(ind, i, 'long', ind.orLo[i]);
      if (volOk && trendDown(ind, i) && k.c < ind.orLo[i] && p >= ind.orLo[i]) return enter(ind, i, 'short', ind.orHi[i]);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_lasthalf',
    name: 'Momentum de la dernière demi-heure',
    desc: 'Effet documenté sur les indices US (Gao, Han, Li & Zhou, 2018) : le sens de la journée jusqu’à 15 h 30 New York (depuis la clôture de la veille) tend à se prolonger dans la dernière demi-heure. Achat (ou vente) à 15 h 30, sortie à 15 h 55. Stop 1,5 ATR. Pour l’or : même idée sur la fin de séance de New York (19 h 30 → 19 h 55 UTC).',
    evaluate(ind, i) {
      const m = ind.min[i];
      const start = ind.sess.close - 30;
      const out = !weekday(ind, i) || m >= ind.sess.close - 5 || m < start;
      const none = { entry: null, exitLong: out, exitShort: out, sl: 0, tp: null };
      if (!weekday(ind, i) || m !== start || ind.pClose[i] === null) return none;
      const r = ind.closes[i] / ind.pClose[i] - 1;
      if (Math.abs(r) < 0.001) return none;
      return { ...none, entry: r > 0 ? 'long' : 'short', sl: 1.5 * ind.atr[i] * Math.sqrt(Math.max(1, 300 / ind.barSec)), exitLong: false, exitShort: false };
    },
  },
  {
    ...BASE,
    id: 'x_rsi2',
    name: 'Scalp RSI 2 dans la tendance 1 h',
    desc: 'Retour à la moyenne court : tendance 1 h haussière et RSI 2 sous 5 (plusieurs bougies de baisse d’affilée) → achat ; sortie quand le RSI 2 repasse au-dessus de 60. Stop 1,5 ATR. Inverse en tendance baissière (RSI 2 > 95).',
    evaluate(ind, i) {
      if (!active(ind, i)) return NONE(ind, i);
      const r = ind.rsi2[i];
      const base = { entry: null, exitLong: flat(ind, i) || r > 60, exitShort: flat(ind, i) || r < 40, sl: 1.5 * ind.atr[i], tp: null };
      if (trendUp(ind, i) && r < 5) return { ...base, entry: 'long' };
      if (trendDown(ind, i) && r > 95) return { ...base, entry: 'short' };
      return base;
    },
  },
  {
    ...BASE,
    id: 'x_squeeze',
    name: 'Scalp compression puis cassure',
    desc: 'Les bandes de Bollinger (20, 2) sont les plus serrées des 100 dernières bougies (marché compressé) ; à la première clôture hors des bandes dans le sens de la tendance 1 h, entrée. Stop à la moyenne 20, objectif 2 fois le risque.',
    evaluate(ind, i) {
      if (!active(ind, i) || ind.bwMin[i] === null) return NONE(ind, i);
      const tight = ind.bw[i - 1] !== null && ind.bw[i - 1] <= ind.bwMin[i - 1] * 1.05;
      if (!tight) return NONE(ind, i);
      const c = ind.closes[i];
      if (trendUp(ind, i) && c > ind.bb.upper[i]) return enter(ind, i, 'long', ind.bb.mid[i]);
      if (trendDown(ind, i) && c < ind.bb.lower[i]) return enter(ind, i, 'short', ind.bb.mid[i]);
      return NONE(ind, i);
    },
  },
  {
    ...BASE,
    id: 'x_break20',
    name: 'Scalp cassure du plus haut des 20 bougies',
    desc: 'Dans la tendance 1 h, clôture au-dessus du plus haut des 20 bougies précédentes avec un volume supérieur à 1,5 fois la moyenne → achat. Stop sous le plus bas des 5 dernières bougies, objectif 2 fois le risque. Inverse à la baisse.',
    evaluate(ind, i) {
      if (!active(ind, i) || ind.hi20[i] === null) return NONE(ind, i);
      const k = ind.candles[i];
      const volOk = !ind.vAvg[i] || ind.vol[i] > 1.5 * ind.vAvg[i];
      if (volOk && trendUp(ind, i) && k.c > ind.hi20[i] && ind.closes[i - 1] <= ind.hi20[i - 1]) return enter(ind, i, 'long', lowest(ind, i, 5) - 0.1 * ind.atr[i]);
      if (volOk && trendDown(ind, i) && k.c < ind.lo20[i] && ind.closes[i - 1] >= ind.lo20[i - 1]) return enter(ind, i, 'short', highest(ind, i, 5) + 0.1 * ind.atr[i]);
      return NONE(ind, i);
    },
  },
];

module.exports = { SCALP2, computeScalp2, nyOffset, helpers: { active, flat, trendUp, trendDown, weekday } };
