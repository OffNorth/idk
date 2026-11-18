/**
 * Nasdaq intraday (5 min) : stratégies de MOMENTUM retenues par le test en masse `npm run nas-intraday-grid`
 * (QQQ 1 min Polygon nov. 2024 → nov. 2026, 3 tranches de 8 mois, frais 0,003 % + financement).
 * Le retour à la moyenne ne marche pas en intraday sur le Nasdaq (1 variante sur 112) : ici on suit le mouvement.
 * À l'essai : seulement 2 ans de données 1 min, gains faibles.
 */
const { computeScalp2, helpers } = require('./scalp2');

const { weekday } = helpers;
const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

/** Indicateurs communs + ranges d'ouverture 5 et 15 min, prix de 10 h et ouverture de séance. */
function compute(candles, barSec, market) {
  return augment(computeScalp2(candles, barSec, market), barSec);
}

/** Ajoute les champs propres à ces stratégies (le bot en direct peut partager les indicateurs de base entre stratégies). */
function augment(x, barSec) {
  if (x.or5) return x;
  const candles = x.candles;
  barSec = barSec || (candles.length > 1 ? candles[candles.length - 1].t - candles[candles.length - 2].t : 300);
  const n = candles.length;
  const mins = barSec / 60;
  const m = x.min;
  const inSess = (i) => weekday(x, i) && m[i] >= OPEN && m[i] < CLOSE;
  x.inSess = inSess;
  x.endMin = (i) => m[i] + mins;
  const range = (N) => {
    const hi = new Array(n).fill(null);
    const lo = new Array(n).fill(null);
    let dd = null; let h = -Infinity; let l = Infinity;
    for (let i = 0; i < n; i++) {
      if (x.day[i] !== dd) { dd = x.day[i]; h = -Infinity; l = Infinity; }
      if (inSess(i) && m[i] < OPEN + N) { h = Math.max(h, candles[i].h); l = Math.min(l, candles[i].l); }
      if (inSess(i) && m[i] >= OPEN + N && h > -Infinity) { hi[i] = h; lo[i] = l; }
    }
    return { hi, lo };
  };
  x.or5 = range(5);
  x.or15 = range(15);
  x.sOpen = new Array(n).fill(null);
  x.p10 = new Array(n).fill(null);
  // Une seule entrée par jour : jours déjà « servis » par stratégie (rempli au calcul, sans regarder l'avenir)
  x.first = {};
  let dd = null; let o = null; let p = null;
  for (let i = 0; i < n; i++) {
    if (x.day[i] !== dd) { dd = x.day[i]; o = null; p = null; }
    if (o === null && inSess(i)) o = candles[i].o;
    if (inSess(i) && x.endMin(i) <= 10 * 60) p = x.closes[i];
    x.sOpen[i] = o;
    x.p10[i] = p;
  }
  return x;
}

/** Vrai seulement à la première bougie du jour où la condition est remplie. */
function firstOfDay(x, key, cond) {
  augment(x);
  if (!x.first[key]) {
    const out = new Array(x.closes.length).fill(false);
    let dd = null; let done = false;
    for (let i = 0; i < out.length; i++) {
      if (x.day[i] !== dd) { dd = x.day[i]; done = false; }
      if (!done && cond(i)) { out[i] = true; done = true; }
    }
    x.first[key] = out;
  }
  return x.first[key];
}

const BASE = { tf: '5m', onlyTf: ['5m'], markets: ['nas100'], scalp: true, nasintra: true, warmup: 300, compute };
const flatAt = (x, i) => !weekday(augment(x), i) || x.endMin(i) >= CLOSE - 5 || x.min[i] < OPEN;
const none = (x, i) => { const f = flatAt(x, i); return { entry: null, exitLong: f, exitShort: f, sl: 0, tp: null }; };

const NASINTRA = [
  {
    ...BASE,
    id: 'n_mom10',
    name: 'Nasdaq : la matinée donne le sens de la fin de journée',
    desc: 'Momentum intraday : si à 10 h New York le Nasdaq a déjà fait plus de 0,5 % depuis la clôture de la veille (dans un sens ou l’autre), on prend ce sens à 15 h et on sort à 15 h 55. Stop 3 ATR. Test en masse : +0,3 % · +0,9 % · +2,9 % sur 3 tranches de 8 mois, ≈ 0,5 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flatAt(x, i)) return out;
      const r = (j) => (x.p10[j] !== null && x.pClose[j] ? (x.p10[j] / x.pClose[j] - 1) * 100 : 0);
      const up = firstOfDay(x, 'mom10u', (j) => x.inSess(j) && x.endMin(j) >= 15 * 60 && r(j) > 0.5);
      const dn = firstOfDay(x, 'mom10d', (j) => x.inSess(j) && x.endMin(j) >= 15 * 60 && r(j) < -0.5);
      if (up[i]) return { ...out, entry: 'long', sl: 3 * x.atr[i] };
      if (dn[i]) return { ...out, entry: 'short', sl: 3 * x.atr[i] };
      return out;
    },
  },
  {
    ...BASE,
    id: 'n_orb15',
    name: 'Nasdaq : cassure des 15 premières minutes à la hausse',
    desc: 'Si la séance a ouvert au-dessus de la clôture de la veille, achat à la première clôture 5 min au-dessus du plus haut des 15 premières minutes (avant midi), stop au plus bas de ce range, sortie à 15 h 55. Test en masse : +3,5 % · +0,6 % · +2,0 %, ≈ 0,4 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flatAt(x, i)) return out;
      const R = x.or15;
      const up = firstOfDay(x, 'orb15', (j) => R.hi[j] !== null && x.closes[j] > R.hi[j] && x.min[j] < 12 * 60);
      if (up[i] && x.sOpen[i] > x.pClose[i]) return { ...out, entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - R.lo[i]) };
      return out;
    },
  },
  {
    ...BASE,
    id: 'n_orb5s',
    name: 'Nasdaq : cassure des 5 premières minutes à la baisse',
    desc: 'Vente à la première clôture 5 min sous le plus bas des 5 premières minutes de la séance (avant midi), stop au plus haut de ce range, sortie à 15 h 55. Les cassures à la baisse vont plus loin que celles à la hausse en intraday. Test en masse : +0,6 % · +8,5 % · +1,3 %, ≈ 0,7 trade par jour.',
    evaluate(x, i) {
      const out = none(x, i);
      if (flatAt(x, i)) return out;
      const R = x.or5;
      const dn = firstOfDay(x, 'orb5s', (j) => R.lo[j] !== null && x.closes[j] < R.lo[j] && x.min[j] < 12 * 60);
      if (dn[i]) return { ...out, entry: 'short', sl: Math.max(0.2 * x.atr[i], R.hi[i] - x.closes[i]) };
      return out;
    },
  },
];

module.exports = { NASINTRA };
