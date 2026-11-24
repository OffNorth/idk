/**
 * Or : stratégies liées aux séances d'ASIE et de NEW YORK (heures de New York et de Londres, changements d'heure
 * compris). Outils partagés par la recherche (`npm run sessions`, session-research.js) et le bot en direct.
 * Recherche nov. 2026 (or au comptant réel 5 min 2009–2026, 51 variantes) : 2 positives sur les 3 tranches (les deux
 * cassures du range asiatique), avantage faible (+0,03 R par trade), aucune amélioration des challenges FTMO / Lucid →
 * la meilleure (g_asiabrk) est seulement À L'ESSAI en paper trading (pas sur les comptes FTMO / Lucid).
 */
const { computeScalp2, nyOffset } = require('./scalp2');

// Heure de Londres (décalage en minutes, mis en cache par jour)
const LF = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false });
const lonCache = new Map();
const lonOffset = (t) => {
  const d = Math.floor(t / 86400);
  let o = lonCache.get(d);
  if (o === undefined) {
    const h = Number(LF.format(new Date((d * 86400 + 12 * 3600) * 1000))) % 24;
    o = (h - 12) * 60; // minutes à ajouter à l'UTC
    lonCache.set(d, o);
  }
  return o;
};

/**
 * Ajoute à des indicateurs scalp2 (minutes UTC) les minutes et jours locaux de New York et de Londres (une fois).
 * En direct, les stratégies 5 min partagent le même objet d'indicateurs : chaque évaluation appelle withTz.
 */
function withTz(x) {
  if (x.tz) return x;
  const candles = x.candles;
  const n = candles.length;
  x.tz = { utc: { min: x.min, day: x.day }, ny: { min: new Array(n), day: new Array(n) }, lon: { min: new Array(n), day: new Array(n) } };
  for (let i = 0; i < n; i++) {
    const t = candles[i].t;
    const ny = t - nyOffset(t) * 60;
    const lo = t + lonOffset(t) * 60;
    x.tz.ny.min[i] = Math.floor((ny % 86400) / 60); x.tz.ny.day[i] = Math.floor(ny / 86400);
    x.tz.lon.min[i] = Math.floor((lo % 86400) / 60); x.tz.lon.day[i] = Math.floor(lo / 86400);
  }
  x.cache = x.cache || {};
  return x;
}
const memo = new WeakMap();
function compute(candles) {
  if (!memo.has(candles)) memo.set(candles, withTz(computeScalp2(candles, 300, 'gold')));
  return memo.get(candles);
}
const wkday = (x, i) => { const d = new Date(x.candles[i].t * 1000).getUTCDay(); return d >= 1 && d <= 5; };
const hm = (h, m = 0) => h * 60 + m;

/** Range [start, start + len) (minutes locales du fuseau) du jour local, disponible ensuite : { hi, lo }. */
function rangeOf(x, tz, start, len) {
  const k = `r:${tz}:${start}:${len}`;
  if (x.cache[k]) return x.cache[k];
  const { min, day } = x.tz[tz];
  const n = x.candles.length;
  const hi = new Array(n).fill(null); const lo = new Array(n).fill(null);
  let dd = null; let h = -Infinity; let l = Infinity;
  for (let i = 0; i < n; i++) {
    if (day[i] !== dd) { dd = day[i]; h = -Infinity; l = Infinity; }
    if (min[i] >= start && min[i] < start + len) { h = Math.max(h, x.candles[i].h); l = Math.min(l, x.candles[i].l); }
    if (min[i] >= start + len && h > -Infinity) { hi[i] = h; lo[i] = l; }
  }
  return (x.cache[k] = { hi, lo });
}
/** Prix de clôture de la bougie qui finit à `at` (minutes locales) du jour local, disponible ensuite. */
function priceAt(x, tz, at) {
  const k = `p:${tz}:${at}`;
  if (x.cache[k]) return x.cache[k];
  const { min, day } = x.tz[tz];
  const n = x.candles.length;
  const out = new Array(n).fill(null);
  let dd = null; let p = null;
  for (let i = 0; i < n; i++) {
    if (day[i] !== dd) { dd = day[i]; p = null; }
    if (min[i] + 5 <= at) p = x.closes[i];
    out[i] = min[i] + 5 > at ? p : null;
  }
  return (x.cache[k] = out);
}
/** Vrai à la 1re bougie du jour local où cond(i) est vraie. */
function firstOfDay(x, tz, key, cond) {
  const k = `f:${key}`;
  if (x.cache[k]) return x.cache[k];
  const { day } = x.tz[tz];
  const out = new Array(x.candles.length).fill(false);
  let dd = null; let done = false;
  for (let i = 0; i < out.length; i++) {
    if (day[i] !== dd) { dd = day[i]; done = false; }
    if (!done && cond(i)) { out[i] = true; done = true; }
  }
  return (x.cache[k] = out);
}

const base = (id, name, evaluate, desc = '') => ({ id, name, desc, tf: '5m', onlyTf: ['5m'], scalp: true, warmup: 300, markets: ['gold'], compute, evaluate: (x, i) => evaluate(withTz(x), i) });
const none = (exit) => ({ entry: null, exitLong: exit, exitShort: exit, sl: 0, tp: null });

/** Cassure d'un range : 1re clôture au-delà avant entryEnd ; stop de l'autre côté (ou k ATR au plus) ; sortie à exitAt. */
function breakout({ id, name, desc, tz, start, len, entryEnd, exitAt, stopAtr = 0, dir = 'both' }) {
  return base(id, name, (x, i) => {
    const m = x.tz[tz].min[i];
    const out = none(!wkday(x, i) || m >= exitAt || m < start);
    if (out.exitLong) return out;
    const R = rangeOf(x, tz, start, len);
    const cl = x.closes;
    const up = firstOfDay(x, tz, `${id}u`, (j) => R.hi[j] !== null && cl[j] > R.hi[j] && x.tz[tz].min[j] < entryEnd && x.tz[tz].min[j] < exitAt);
    const dn = firstOfDay(x, tz, `${id}d`, (j) => R.lo[j] !== null && cl[j] < R.lo[j] && x.tz[tz].min[j] < entryEnd && x.tz[tz].min[j] < exitAt);
    const cap = (d) => (stopAtr ? Math.min(d, stopAtr * x.atr[i]) : d);
    if (up[i] && dir !== 'short') return { ...out, entry: 'long', sl: Math.max(0.2 * x.atr[i], cap(cl[i] - R.lo[i])) };
    if (dn[i] && dir !== 'long') return { ...out, entry: 'short', sl: Math.max(0.2 * x.atr[i], cap(R.hi[i] - cl[i])) };
    return out;
  }, desc);
}

/** À l'heure `at`, mouvement depuis `ref` > seuil (%) → suivre (follow) ou contrer (fade) jusqu'à exitAt ; stop k ATR. */
function momentum({ id, name, desc, tz, ref, at, exitAt, th, mode = 'follow', stopAtr = 2 }) {
  return base(id, name, (x, i) => {
    const m = x.tz[tz].min[i];
    const out = none(!wkday(x, i) || m >= exitAt || m + 5 < at); // la bougie qui finit à `at` compte
    if (out.exitLong) return out;
    const P = priceAt(x, tz, ref);
    const r = (j) => (P[j] ? (x.closes[j] / P[j] - 1) * 100 : 0);
    const go = firstOfDay(x, tz, `${id}g`, (j) => x.tz[tz].min[j] + 5 >= at && x.tz[tz].min[j] < exitAt && Math.abs(r(j)) > th && wkday(x, j));
    if (!go[i]) return out;
    const upMove = r(i) > 0;
    const side = (mode === 'follow') === upMove ? 'long' : 'short';
    return { ...out, entry: side, sl: stopAtr * x.atr[i] };
  }, desc);
}

/** Effet de nuit : achat à 21 h UTC (lundi → jeudi), revente à 7 h UTC ; stop k ATR. */
function night({ id, name, inH = 21, outH = 7, stopAtr = 4 }) {
  return base(id, name, (x, i) => {
    const m = x.min[i];
    const exit = m >= hm(outH) && m < hm(inH);
    const d = new Date(x.candles[i].t * 1000).getUTCDay();
    const entry = m === hm(inH) && d >= 1 && d <= 4 ? 'long' : null;
    return { entry, exitLong: exit, exitShort: true, sl: stopAtr * x.atr[i], tp: null };
  });
}


/** Stratégies retenues à l'essai (paper trading seulement). */
const SESSIONS = [
  breakout({
    id: 'g_asiabrk', name: 'Or : cassure du range asiatique à l’ouverture de Londres',
    desc: 'Range de la nuit asiatique (0 h → 7 h UTC : Tokyo, Hong Kong, Shanghai). Première clôture 5 min au-dessus du plus haut → achat, sous le plus bas → vente (avant 11 h UTC) ; stop de l’autre côté du range, sortie à 19 h UTC. Or au comptant 2009–2026 : +20 % · +13 % · +16 % sur 3 tranches, ≈ 0,9 trade par jour ; n’améliore pas le challenge FTMO → à l’essai en paper trading.',
    tz: 'utc', start: 0, len: hm(7), entryEnd: hm(11), exitAt: hm(19),
  }),
];

module.exports = { SESSIONS, compute, withTz, rangeOf, priceAt, firstOfDay, breakout, momentum, night, hm, wkday, lonOffset };
