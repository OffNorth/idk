/**
 * Or intraday : MOMENTUM (suivre le mouvement de la séance). Sur l'or au comptant réel (HistData 2009–2026,
 * `npm run gold-intraday-grid`), 40 variantes de momentum sur 46 choisies sont confirmées sur 2020–2026 — l'inverse de
 * PAXG, dont la cotation faisait croire à des retours à la moyenne. Séance de l'or : 7 h → 20 h UTC (Londres → New York).
 * Mêmes règles que les variantes du test en masse (nas-intraday-grid.js, mode or).
 */
const { computeScalp2, helpers } = require('./scalp2');

const { weekday } = helpers;
const OPEN = 7 * 60;
const CLOSE = 20 * 60;

/** Indicateurs de base + ranges d'ouverture, ouverture de séance et prix à 8 h UTC (calculés une fois). */
function augment(x) {
  if (x.gm) return x;
  const c = x.candles;
  const n = c.length;
  const mins = (x.barSec || 300) / 60;
  const m = x.min;
  const inSess = (i) => weekday(x, i) && m[i] >= OPEN && m[i] < CLOSE;
  const endMin = (i) => m[i] + mins;
  const range = (N) => {
    const hi = new Array(n).fill(null);
    const lo = new Array(n).fill(null);
    let dd = null; let h = -Infinity; let l = Infinity;
    for (let i = 0; i < n; i++) {
      if (x.day[i] !== dd) { dd = x.day[i]; h = -Infinity; l = Infinity; }
      if (inSess(i) && m[i] < OPEN + N) { h = Math.max(h, c[i].h); l = Math.min(l, c[i].l); }
      if (inSess(i) && m[i] >= OPEN + N && h > -Infinity) { hi[i] = h; lo[i] = l; }
    }
    return { hi, lo };
  };
  const sOpen = new Array(n).fill(null);
  const p8 = new Array(n).fill(null);
  let dd = null; let o = null; let p = null;
  for (let i = 0; i < n; i++) {
    if (x.day[i] !== dd) { dd = x.day[i]; o = null; p = null; }
    if (o === null && inSess(i)) o = c[i].o;
    if (inSess(i) && endMin(i) <= 8 * 60) p = x.closes[i];
    sOpen[i] = o;
    p8[i] = p;
  }
  x.gm = { inSess, endMin, or30: range(30), or60: range(60), sOpen, p8, first: {} };
  return x;
}

/** Vrai seulement à la première bougie du jour où la condition est remplie (une entrée par jour et par sens). */
function firstOfDay(x, key, cond) {
  const g = augment(x).gm;
  if (!g.first[key]) {
    const out = new Array(x.closes.length).fill(false);
    let dd = null; let done = false;
    for (let i = 0; i < out.length; i++) {
      if (x.day[i] !== dd) { dd = x.day[i]; done = false; }
      if (!done && cond(i)) { out[i] = true; done = true; }
    }
    g.first[key] = out;
  }
  return g.first[key];
}

const flat = (x, i) => { const g = augment(x).gm; return !weekday(x, i) || g.endMin(i) >= CLOSE - 5 || x.min[i] < OPEN; };
const none = (x, i) => { const f = flat(x, i); return { entry: null, exitLong: f, exitShort: f, sl: 0, tp: null }; };
const BASE = { markets: ['gold'], scalp: true, goldmom: true, warmup: 700, compute: (c, s, m) => augment(computeScalp2(c, s, m)) };

const GOLDMOM = [
  {
    ...BASE,
    tf: '5m', onlyTf: ['5m'],
    id: 'g_orb30',
    name: 'Or : cassure des 30 premières minutes de Londres',
    desc: 'Range de 7 h à 7 h 30 UTC (ouverture de Londres). Première clôture 5 min au-dessus du plus haut → achat, sous le plus bas → vente (avant 9 h 30 UTC) ; stop de l’autre côté du range, sortie à 19 h 55 UTC. Or au comptant 2009–2026 : +24 % · +22 % · +24 % sur 3 tranches, ≈ 1,25 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flat(x, i)) return out;
      const R = x.gm.or30;
      const cl = x.closes;
      const up = firstOfDay(x, 'orb30u', (j) => R.hi[j] !== null && cl[j] > R.hi[j] && x.min[j] < 9 * 60 + 30);
      const dn = firstOfDay(x, 'orb30d', (j) => R.lo[j] !== null && cl[j] < R.lo[j] && x.min[j] < 9 * 60 + 30);
      if (up[i]) return { ...out, entry: 'long', sl: Math.max(0.2 * x.atr[i], cl[i] - R.lo[i]) };
      if (dn[i]) return { ...out, entry: 'short', sl: Math.max(0.2 * x.atr[i], R.hi[i] - cl[i]) };
      return out;
    },
  },
  {
    ...BASE,
    tf: '5m', onlyTf: ['5m'],
    id: 'g_orb60',
    name: 'Or : cassure de la première heure de Londres',
    desc: 'Range de 7 h à 8 h UTC. Première clôture 5 min au-dessus du plus haut → achat, sous le plus bas → vente (avant 9 h 30 UTC) ; stop de l’autre côté du range, sortie à 19 h 55 UTC. Or au comptant 2009–2026 : +15 % · +12 % · +16 % sur 3 tranches, ≈ 1 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flat(x, i)) return out;
      const R = x.gm.or60;
      const cl = x.closes;
      const up = firstOfDay(x, 'orb60u', (j) => R.hi[j] !== null && cl[j] > R.hi[j] && x.min[j] < 9 * 60 + 30);
      const dn = firstOfDay(x, 'orb60d', (j) => R.lo[j] !== null && cl[j] < R.lo[j] && x.min[j] < 9 * 60 + 30);
      if (up[i]) return { ...out, entry: 'long', sl: Math.max(0.2 * x.atr[i], cl[i] - R.lo[i]) };
      if (dn[i]) return { ...out, entry: 'short', sl: Math.max(0.2 * x.atr[i], R.hi[i] - cl[i]) };
      return out;
    },
  },
  {
    ...BASE,
    tf: '15m', onlyTf: ['15m'],
    id: 'g_mom8',
    name: 'Or : la matinée de Londres donne le sens de l’après-midi',
    desc: 'Si à 8 h UTC l’or a déjà bougé de plus de 0,25 % depuis la clôture de la veille (20 h UTC), on prend ce sens à 12 h 30 UTC et on sort à 19 h 55. Stop 3 ATR. Or au comptant 2009–2026 : +2 % · +8 % · +43 %, ≈ 0,5 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flat(x, i)) return out;
      const g = x.gm;
      const r = (j) => (g.p8[j] !== null && x.pClose[j] ? (g.p8[j] / x.pClose[j] - 1) * 100 : 0);
      const up = firstOfDay(x, 'mom8u', (j) => g.inSess(j) && g.endMin(j) >= 12 * 60 + 30 && r(j) > 0.25);
      const dn = firstOfDay(x, 'mom8d', (j) => g.inSess(j) && g.endMin(j) >= 12 * 60 + 30 && r(j) < -0.25);
      if (up[i]) return { ...out, entry: 'long', sl: 3 * x.atr[i] };
      if (dn[i]) return { ...out, entry: 'short', sl: 3 * x.atr[i] };
      return out;
    },
  },
  {
    ...BASE,
    tf: '15m', onlyTf: ['15m'],
    id: 'g_gap',
    name: 'Or : écart d’ouverture qui se prolonge',
    desc: 'L’or ouvre (7 h UTC) à plus de 0,3 % de sa clôture de la veille et poursuit dans ce sens après 15 minutes → on suit l’écart jusqu’à 19 h 55 UTC. Stop 2 ATR. Or au comptant 2009–2026 : +12 % · 0 % · +46 %, ≈ 0,35 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flat(x, i)) return out;
      const g = x.gm;
      const gap = (j) => (g.sOpen[j] && x.pClose[j] ? (g.sOpen[j] / x.pClose[j] - 1) * 100 : 0);
      const up = firstOfDay(x, 'gapu', (j) => g.inSess(j) && x.min[j] >= OPEN + 15 && gap(j) > 0.3 && x.closes[j] > g.sOpen[j]);
      const dn = firstOfDay(x, 'gapd', (j) => g.inSess(j) && x.min[j] >= OPEN + 15 && gap(j) < -0.3 && x.closes[j] < g.sOpen[j]);
      if (up[i]) return { ...out, entry: 'long', sl: 2 * x.atr[i] };
      if (dn[i]) return { ...out, entry: 'short', sl: 2 * x.atr[i] };
      return out;
    },
  },
];

module.exports = { GOLDMOM };
