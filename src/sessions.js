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
  // durée d'une bougie en minutes (5 en direct ; 60 pour des bougies horaires)
  x.barMin = x.barSec ? x.barSec / 60 : candles.length > 1 ? Math.max(1, Math.round((candles[1].t - candles[0].t) / 60)) : 5;
  return x;
}
const memos = { gold: new WeakMap(), nas100: new WeakMap() };
/** Indicateurs de base du marché (minutes UTC pour l'or, de New York pour le Nasdaq, comme scalp2) + fuseaux. */
function computeFor(candles, market = 'gold') {
  const memo = memos[market] || memos.gold;
  if (!memo.has(candles)) {
    const sec = candles.length > 1 ? candles[1].t - candles[0].t : 300;
    memo.set(candles, withTz(computeScalp2(candles, sec > 0 && sec <= 3600 ? sec : 300, market)));
  }
  return memo.get(candles);
}
const compute = (candles) => computeFor(candles, 'gold');

/** Fuseau « nuit de New York » (heure de New York + 6 h : la journée commence à 18 h NY, réouverture des futures). */
function withNyx(x) {
  withTz(x);
  if (x.tz.nyx) return x;
  const n = x.candles.length;
  const min = new Array(n); const day = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = x.candles[i].t;
    const l = t - nyOffset(t) * 60 + 6 * 3600;
    min[i] = Math.floor((l % 86400) / 60); day[i] = Math.floor(l / 86400);
  }
  x.tz.nyx = { min, day };
  return x;
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
    if (min[i] + x.barMin <= at) p = x.closes[i];
    out[i] = min[i] + x.barMin > at ? p : null;
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

const base = (id, name, evaluate, desc = '', market = 'gold') => ({
  id, name, desc, tf: '5m', onlyTf: ['5m'], scalp: true, warmup: 300, markets: [market],
  compute: (candles) => computeFor(candles, market), evaluate: (x, i) => evaluate(withNyx(x), i),
});
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
    const out = none(!wkday(x, i) || m >= exitAt || m + x.barMin < at); // la bougie qui finit à `at` compte
    if (out.exitLong) return out;
    const P = priceAt(x, tz, ref);
    const r = (j) => (P[j] ? (x.closes[j] / P[j] - 1) * 100 : 0);
    const go = firstOfDay(x, tz, `${id}g`, (j) => x.tz[tz].min[j] + x.barMin >= at && x.tz[tz].min[j] < exitAt && Math.abs(r(j)) > th && wkday(x, j));
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


/**
 * Cassure du plus haut / plus bas de la séance précédente [s, e) (minutes locales du fuseau) entre entryStart et
 * entryEnd ; sortie à exitAt ; stop k ATR.
 */
function levelBreak({ id, name, desc = '', market = 'gold', tz, s, e, entryStart, entryEnd, exitAt, stopAtr = 2 }) {
  return base(id, name, (x, i) => {
    const k = `lb:${tz}:${s}:${e}`;
    if (!x.cache[k]) {
      const { min, day } = x.tz[tz];
      const n = x.candles.length;
      const ph = new Array(n).fill(null); const pl = new Array(n).fill(null);
      let dd = null; let h = -Infinity; let l = Infinity; let H = null; let L = null;
      for (let j = 0; j < n; j++) {
        if (day[j] !== dd) { if (dd !== null && h > -Infinity) { H = h; L = l; } dd = day[j]; h = -Infinity; l = Infinity; }
        if (min[j] >= s && min[j] < e) { h = Math.max(h, x.candles[j].h); l = Math.min(l, x.candles[j].l); }
        ph[j] = H; pl[j] = L;
      }
      x.cache[k] = { ph, pl };
    }
    const { ph, pl } = x.cache[k];
    const m = x.tz[tz].min[i];
    const out = none(!wkday(x, i) || m >= exitAt || m < entryStart);
    if (out.exitLong) return out;
    const cl = x.closes;
    const up = firstOfDay(x, tz, `${id}u`, (j) => ph[j] !== null && cl[j] > ph[j] && x.tz[tz].min[j] >= entryStart && x.tz[tz].min[j] < entryEnd);
    const dn = firstOfDay(x, tz, `${id}d`, (j) => pl[j] !== null && cl[j] < pl[j] && x.tz[tz].min[j] >= entryStart && x.tz[tz].min[j] < entryEnd);
    if (up[i]) return { ...out, entry: 'long', sl: stopAtr * x.atr[i] };
    if (dn[i]) return { ...out, entry: 'short', sl: stopAtr * x.atr[i] };
    return out;
  }, desc, market);
}

/** Stratégies retenues à l'essai (paper trading seulement). */
const SESSIONS = [
  breakout({
    id: 'g_asiabrk', name: 'Or : cassure du range asiatique à l’ouverture de Londres',
    desc: 'Range de la nuit asiatique (0 h → 7 h UTC : Tokyo, Hong Kong, Shanghai). Première clôture 5 min au-dessus du plus haut → achat, sous le plus bas → vente (avant 11 h UTC) ; stop de l’autre côté du range, sortie à 19 h UTC. Or au comptant 2009–2026 : +20 % · +13 % · +16 % sur 3 tranches, ≈ 0,9 trade par jour ; n’améliore pas le challenge FTMO → à l’essai en paper trading.',
    tz: 'utc', start: 0, len: hm(7), entryEnd: hm(11), exitAt: hm(19),
  }),
  levelBreak({
    id: 'g_nypdl', name: 'Or : cassure du plus haut / plus bas de la veille pendant New York',
    desc: 'Plus haut et plus bas de la séance précédente de l’or (18 h → 17 h New York). Pendant New York (8 h 20 → 12 h NY), première clôture 5 min au-dessus → achat, en dessous → vente ; stop 1,5 ATR, sortie à 16 h 55 NY. Or au comptant 2009–2026 : +17 % · +23 % · +2,8 % sur 3 tranches (+0,13 R par trade, ≈ 0,7 trade / jour) ; n’améliore pas le challenge FTMO → à l’essai en paper trading.',
    tz: 'nyx', s: 0, e: hm(23), entryStart: hm(14, 20), entryEnd: hm(18), exitAt: hm(22, 55), stopAtr: 1.5,
  }),
  levelBreak({
    id: 'n_pdlbrk', name: 'Nasdaq : cassure du plus haut / plus bas de la veille', market: 'nas100',
    desc: 'Plus haut et plus bas de la séance précédente (9 h 30 → 16 h NY). Entre 9 h 35 et 12 h, première clôture 5 min au-dessus → achat, en dessous → vente ; stop 3 ATR, sortie à 15 h 55. QQQ nov. 2024 → nov. 2026 : +1,2 % · +0,4 % · +4,9 % sur 3 tranches de 8 mois (≈ 0,8 trade / jour) ; n’améliore pas les challenges → à l’essai en paper trading.',
    tz: 'ny', s: hm(9, 30), e: hm(16), entryStart: hm(9, 35), entryEnd: hm(12), exitAt: hm(15, 55), stopAtr: 3,
  }),
];

module.exports = { SESSIONS, computeFor, withNyx, levelBreak, compute, withTz, rangeOf, priceAt, firstOfDay, breakout, momentum, night, hm, wkday, lonOffset };
