/**
 * Stratégies « style FTMO » (or et Nasdaq 100) : chaque trade a un stop clair, pour dimensionner la position au risque
 * (0,5–1 % du compte par trade). Bougies 1 h dans la tendance journalière, et cassures sur bougies journalières.
 * Heures de marché : UTC pour l'or (Londres 7 h → 20 h), New York pour le Nasdaq (9 h 30 → 16 h, heure d'été gérée).
 */
const { ema, atr, sma } = require('./indicators');
const { nyOffset } = require('./scalp2');

/** Indicateurs des stratégies 1 h. */
function computeF(candles, barSec = 3600, market = 'gold') {
  const n = candles.length;
  const nas = market === 'nas100';
  const closes = candles.map((c) => c.c);
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
  // Bougies journalières terminées (jour de marché) → EMA 20 / 50, plus haut / bas / clôture de la veille
  const days = [];
  const doneIdx = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!cur || cur.d !== day[i]) {
      if (cur) days.push(cur);
      cur = { d: day[i], o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
    doneIdx.push(days.length - 1);
  }
  const dc = days.map((d) => d.c);
  const d20 = ema(dc, 20);
  const d50 = ema(dc, 50);
  const at = (arr) => doneIdx.map((k) => (k >= 0 ? arr[k] : null));
  // Range de nuit : 0 h–7 h UTC (or) / 4 h–9 h 30 New York (Nasdaq)
  const rS = nas ? 4 * 60 : 0;
  const rE = nas ? 9 * 60 + 30 : 7 * 60;
  const rHi = new Array(n).fill(null);
  const rLo = new Array(n).fill(null);
  let rh = -Infinity;
  let rl = Infinity;
  for (let i = 0; i < n; i++) {
    if (i > 0 && day[i] !== day[i - 1]) { rh = -Infinity; rl = Infinity; }
    if (min[i] >= rE && rh > -Infinity) { rHi[i] = rh; rLo[i] = rl; }
    if (min[i] >= rS && min[i] < rE) { rh = Math.max(rh, candles[i].h); rl = Math.min(rl, candles[i].l); }
  }
  return {
    candles, closes, barSec, market, min, day, wd,
    atr: atr(candles, 14), ema20: ema(closes, 20), ema50: ema(closes, 50),
    d20: at(d20), d50: at(d50), pdh: at(days.map((d) => d.h)), pdl: at(days.map((d) => d.l)), pdc: at(dc),
    rHi, rLo,
    sess: nas ? { open: 9 * 60 + 30, close: 16 * 60 } : { open: 7 * 60, close: 20 * 60 },
  };
}

const weekday = (x, i) => x.wd[i] >= 1 && x.wd[i] <= 5;
const inSess = (x, i) => weekday(x, i) && x.min[i] >= x.sess.open && x.min[i] < x.sess.close - 60;
const flatH = (x, i) => !weekday(x, i) || x.min[i] >= x.sess.close - 60 || x.min[i] < x.sess.open;
const dUp = (x, i) => x.d20[i] !== null && x.d50[i] !== null && x.d20[i] > x.d50[i] && x.closes[i] > x.d20[i];
const dDown = (x, i) => x.d20[i] !== null && x.d50[i] !== null && x.d20[i] < x.d50[i] && x.closes[i] < x.d20[i];
const low = (x, i, k) => Math.min(...x.candles.slice(Math.max(0, i - k + 1), i + 1).map((c) => c.l));
const high = (x, i, k) => Math.max(...x.candles.slice(Math.max(0, i - k + 1), i + 1).map((c) => c.h));
const NONE_H = (x, i) => ({ entry: null, exitLong: flatH(x, i), exitShort: flatH(x, i), sl: 0, tp: null });

/** Entrée avec stop à un prix et objectif en R (refus si le stop est trop serré ou trop large). */
function go(x, i, side, stop, rr, none) {
  const c = x.closes[i];
  const risk = side === 'long' ? c - stop : stop - c;
  const a = x.atr[i];
  if (!(risk > 0.3 * a) || risk > 3 * a) return none;
  return { ...none, entry: side, sl: risk, tp: rr * risk };
}

const H1 = { tf: '1h', onlyTf: ['1h'], markets: ['gold', 'nas100'], ftmo: true, warmup: 1300, compute: (c, s, m) => computeF(c, s, m) };
const D1 = { tf: '1d', onlyTf: ['1d'], markets: ['gold', 'nas100'], ftmo: true, warmup: 60 };

const FTMO = [
  {
    ...H1,
    id: 'f_pullback',
    name: 'FTMO : repli 1 h dans la tendance journalière',
    desc: 'Tendance journalière haussière (EMA 20 > EMA 50 des jours, prix au-dessus) : sur bougies 1 h, achat quand le prix touche l’EMA 20 et clôture au-dessus, en hausse, au-dessus de l’EMA 50. Stop sous le plus bas des 6 dernières heures, objectif 2 fois le risque, tout fermé avant la fin de séance. Inverse en tendance baissière.',
    evaluate(x, i) {
      const none = NONE_H(x, i);
      if (!inSess(x, i)) return none;
      const k = x.candles[i];
      if (dUp(x, i) && k.c > x.ema50[i] && k.l <= x.ema20[i] && k.c > x.ema20[i] && k.c > k.o) return go(x, i, 'long', low(x, i, 6) - 0.2 * x.atr[i], 2, none);
      if (dDown(x, i) && k.c < x.ema50[i] && k.h >= x.ema20[i] && k.c < x.ema20[i] && k.c < k.o) return go(x, i, 'short', high(x, i, 6) + 0.2 * x.atr[i], 2, none);
      return none;
    },
  },
  {
    ...H1,
    id: 'f_pdbreak',
    name: 'FTMO : cassure du plus haut de la veille',
    desc: 'Tendance journalière haussière : achat à la première clôture 1 h au-dessus du plus haut de la veille pendant la séance. Stop sous le plus bas des 4 dernières heures, objectif 2 fois le risque, fermé avant la fin de séance. Inverse sous le plus bas de la veille en tendance baissière.',
    evaluate(x, i) {
      const none = NONE_H(x, i);
      if (!inSess(x, i) || x.pdh[i] === null) return none;
      const k = x.candles[i];
      const p = x.closes[i - 1];
      if (dUp(x, i) && k.c > x.pdh[i] && p <= x.pdh[i]) return go(x, i, 'long', low(x, i, 4) - 0.2 * x.atr[i], 2, none);
      if (dDown(x, i) && k.c < x.pdl[i] && p >= x.pdl[i]) return go(x, i, 'short', high(x, i, 4) + 0.2 * x.atr[i], 2, none);
      return none;
    },
  },
  {
    ...H1,
    id: 'f_nightbreak',
    name: 'FTMO : cassure du range de nuit dans la tendance',
    desc: 'Range de nuit (or : 0 h–7 h UTC, avant Londres ; Nasdaq : 4 h–9 h 30 New York, avant l’ouverture). Dans les 3 premières heures de la séance, clôture 1 h hors du range dans le sens de la tendance journalière : stop de l’autre côté du milieu du range, objectif 2 fois le risque.',
    evaluate(x, i) {
      const none = NONE_H(x, i);
      if (!weekday(x, i) || x.rHi[i] === null || x.min[i] < x.sess.open || x.min[i] >= x.sess.open + 180) return none;
      const k = x.candles[i];
      const p = x.closes[i - 1];
      const mid = (x.rHi[i] + x.rLo[i]) / 2;
      if (dUp(x, i) && k.c > x.rHi[i] && p <= x.rHi[i]) return go(x, i, 'long', mid, 2, none);
      if (dDown(x, i) && k.c < x.rLo[i] && p >= x.rLo[i]) return go(x, i, 'short', mid, 2, none);
      return none;
    },
  },
  {
    ...D1,
    id: 'f_insideday',
    name: 'FTMO : cassure d’un jour intérieur',
    desc: 'Après un « jour intérieur » (plus haut et plus bas à l’intérieur de la veille : le marché se compresse), clôture journalière au-dessus du plus haut de la veille dans une tendance haussière (prix > moyenne 50 jours) → achat. Stop sous le plus bas du jour intérieur, objectif 2 fois le risque. Inverse à la baisse.',
    evaluate(x, i) {
      const k = x.candles;
      const none = { entry: null, exitLong: false, exitShort: false, sl: 0, tp: null };
      if (i < 3) return none;
      const inside = k[i - 1].h < k[i - 2].h && k[i - 1].l > k[i - 2].l;
      if (!inside) return none;
      if (k[i].c > k[i - 1].h && k[i].c > x.sma50[i]) return go(x, i, 'long', Math.min(k[i - 1].l, k[i].l), 2, none);
      if (k[i].c < k[i - 1].l && k[i].c < x.sma50[i]) return go(x, i, 'short', Math.max(k[i - 1].h, k[i].h), 2, none);
      return none;
    },
  },
  {
    ...D1,
    id: 'f_nr7',
    name: 'FTMO : cassure après le jour le plus calme (NR7)',
    desc: 'Toby Crabel : le jour au plus petit écart haut-bas des 7 derniers (NR7) précède souvent un mouvement. Clôture suivante au-dessus de son plus haut, dans la tendance (prix > moyenne 50 jours) → achat ; stop sous son plus bas, objectif 2 fois le risque. Inverse à la baisse.',
    evaluate(x, i) {
      const k = x.candles;
      const none = { entry: null, exitLong: false, exitShort: false, sl: 0, tp: null };
      if (i < 9) return none;
      const r = (j) => k[j].h - k[j].l;
      let nr7 = true;
      for (let j = i - 7; j < i - 1; j++) if (r(j) <= r(i - 1)) nr7 = false;
      if (!nr7) return none;
      if (k[i].c > k[i - 1].h && k[i].c > x.sma50[i]) return go(x, i, 'long', Math.min(k[i - 1].l, k[i].l), 2, none);
      if (k[i].c < k[i - 1].l && k[i].c < x.sma50[i]) return go(x, i, 'short', Math.max(k[i - 1].h, k[i].h), 2, none);
      return none;
    },
  },
  {
    ...D1,
    id: 'f_weekbreak',
    name: 'FTMO : cassure du plus haut de la semaine passée',
    desc: 'Clôture journalière au-dessus du plus haut de la semaine précédente, prix au-dessus de la moyenne 50 jours → achat. Stop 2 ATR, puis stop suiveur à 3 ATR sous le plus haut atteint. Inverse sous le plus bas de la semaine précédente.',
    evaluate(x, i) {
      const k = x.candles;
      const none = { entry: null, exitLong: false, exitShort: false, sl: 0, tp: null };
      const wk = (t) => Math.floor((t / 86400 + 3) / 7); // semaines du lundi au dimanche
      const w = wk(k[i].t);
      let h = -Infinity;
      let l = Infinity;
      let found = false;
      for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
        const wj = wk(k[j].t);
        if (wj === w) continue;
        if (wj < w - 1) break;
        h = Math.max(h, k[j].h);
        l = Math.min(l, k[j].l);
        found = true;
      }
      if (!found) return none;
      const p = k[i - 1].c;
      if (k[i].c > h && p <= h && k[i].c > x.sma50[i]) return { ...none, entry: 'long', sl: 2 * x.atr[i] };
      if (k[i].c < l && p >= l && k[i].c < x.sma50[i]) return { ...none, entry: 'short', sl: 2 * x.atr[i] };
      return none;
    },
    trail(pos, x, i) {
      return pos.side === 'long' ? pos.best - 3 * x.atr[i] : pos.best + 3 * x.atr[i];
    },
  },
];

module.exports = { FTMO, computeF };
