/**
 * Stratégies tirées de la littérature (recherche web, nov. 2026) — testées par `npm run ftmo-papers`.
 *
 *  - Effet de nuit de l'or : Blose, Gondhalekar & Kort, « Overnight gold returns » (Applied Economics Letters 2014) et
 *    J. Economics & Finance 2018 : rendements de nuit positifs, de journée négatifs (COMEX, London Fix) ; thèse CBS
 *    « Gold Price Dynamics Around the Clock » : l'or monte pendant les heures asiatiques, baisse le reste du temps.
 *  - Zone de bruit (Noise Area) : Zarattini, Aziz & Barbon, « Beat the Market: An Effective Intraday Momentum Strategy
 *    for S&P500 ETF (SPY) » (Swiss Finance Institute 24-97, 2024).
 *  - Cassure de la 1re bougie de 5 min : Zarattini & Aziz, « Can Day Trading Really Be Profitable? » (SSRN 4416622, 2023).
 *
 * Les fabriques (night, noise, orbDir) servent au banc d'essai pour les variantes ; les versions nommées sont celles
 * qu'on peut activer dans le bot.
 */
const { computeScalp2, helpers } = require('./scalp2');

const { weekday, trendUp } = helpers;

/** Effet de nuit : achat à `entry` (minutes UTC), revente à `exit` le lendemain matin ; jours d'entrée lun.–jeu. */
function night({ id, entry = 21 * 60, exit = 7 * 60, stopPct = 0.8, trend = false, name, desc }) {
  const inWin = (m) => m >= entry || m < exit;
  return {
    id, name, desc, tf: '5m', onlyTf: ['5m'], markets: ['gold'], scalp: true, research2: true, warmup: 700,
    compute: (c, s, m) => computeScalp2(c, s, m),
    evaluate(x, i) {
      const m = x.min[i];
      const out = { entry: null, exitLong: !inWin(m), exitShort: true, sl: 0, tp: null };
      // entrée lun.–jeu. (la sortie tombe mar.–ven. ; pas de week-end en position, l'or CFD ferme le vendredi soir)
      if (m !== entry || x.wd[i] < 1 || x.wd[i] > 4) return out;
      if (trend && !trendUp(x, i)) return out;
      return { ...out, entry: 'long', sl: (x.closes[i] * stopPct) / 100 };
    },
  };
}

/**
 * Zone de bruit (Zarattini, Aziz & Barbon) : σ(minute) = moyenne sur `look` jours de |clôture / ouverture − 1| à cette
 * minute de la séance ; bornes = max(ouverture, clôture de la veille) × (1 + σ) et min(…) × (1 − σ). Contrôle aux
 * demi-heures : achat au-dessus, vente en dessous ; sortie si le prix repasse le VWAP ou la borne ; tout fermé à la fin.
 */
function noise({ id, market = 'nas100', look = 14, every = 30, name, desc }) {
  const compute = (c, s, m) => {
    const x = computeScalp2(c, s, m);
    const n = c.length;
    const open = x.sess.open;
    const end = x.sess.close;
    const mins = s / 60;
    const dOpen = new Array(n).fill(null);
    const move = new Array(n).fill(null);
    let dd = null; let o = null;
    for (let i = 0; i < n; i++) {
      if (x.day[i] !== dd) { dd = x.day[i]; o = null; }
      if (weekday(x, i) && x.min[i] >= open && x.min[i] < end) {
        if (o === null) o = c[i].o;
        dOpen[i] = o;
        move[i] = Math.abs(c[i].c / o - 1);
      }
    }
    // moyenne des `look` derniers jours à la même minute de séance (jours terminés uniquement)
    const hist = new Map();
    const sigma = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (move[i] === null) continue;
      const k = x.min[i];
      const h = hist.get(k) || [];
      if (h.length >= look) sigma[i] = h.slice(-look).reduce((a, b) => a + b, 0) / look;
      h.push(move[i]);
      if (h.length > look * 2) h.splice(0, h.length - look);
      hist.set(k, h);
    }
    Object.assign(x, { nsOpen: dOpen, nsSigma: sigma, nsMins: mins });
    return x;
  };
  return {
    id, name, desc, tf: '5m', onlyTf: ['5m'], markets: [market], scalp: true, research2: true, warmup: 300, compute,
    evaluate(x, i) {
      const m = x.min[i];
      const endM = m + (x.nsMins || 5);
      const fl = !weekday(x, i) || endM >= x.sess.close - 5 || m < x.sess.open;
      const out = { entry: null, exitLong: fl, exitShort: fl, sl: 0, tp: null };
      if (fl || !x.nsSigma || x.nsSigma[i] === null || !x.pClose[i]) return out;
      const o = x.nsOpen[i];
      const up = Math.max(o, x.pClose[i]) * (1 + x.nsSigma[i]);
      const dn = Math.min(o, x.pClose[i]) * (1 - x.nsSigma[i]);
      const c = x.closes[i];
      const check = (endM - x.sess.open) % every === 0;
      if (!check) return out;
      const vw = x.vwap[i] ?? c;
      out.exitLong = c < Math.max(up, vw);
      out.exitShort = c > Math.min(dn, vw);
      if (c > up) return { ...out, exitShort: true, entry: 'long', sl: Math.max(c - Math.max(up, vw), 0.2 * x.atr[i], c * 0.002) };
      if (c < dn) return { ...out, exitLong: true, entry: 'short', sl: Math.max(Math.min(dn, vw) - c, 0.2 * x.atr[i], c * 0.002) };
      return out;
    },
  };
}

/** 1re bougie de 5 min de la séance : achat si elle est haussière, vente si baissière ; stop à l'extrême, objectif `rr` R. */
function orbDir({ id, market = 'nas100', rr = 10, name, desc }) {
  return {
    id, name, desc, tf: '5m', onlyTf: ['5m'], markets: [market], scalp: true, research2: true, warmup: 300,
    compute: (c, s, m) => computeScalp2(c, s, m),
    evaluate(x, i) {
      const m = x.min[i];
      const fl = !weekday(x, i) || m + 5 >= x.sess.close - 5 || m < x.sess.open;
      const out = { entry: null, exitLong: fl, exitShort: fl, sl: 0, tp: null };
      if (fl || m !== x.sess.open) return out;
      const k = x.candles[i];
      const risk = k.h - k.l;
      if (!(risk > 0) || k.c === k.o) return out;
      if (k.c > k.o) return { ...out, entry: 'long', sl: k.c - k.l, tp: rr * (k.c - k.l) };
      return { ...out, entry: 'short', sl: k.h - k.c, tp: rr * (k.h - k.c) };
    },
  };
}

const RESEARCH2 = [
  night({
    id: 'g_night',
    name: 'Or : effet de nuit',
    desc: 'Littérature (Blose, Gondhalekar & Kort 2014 / 2018 ; thèse CBS) : l’or gagne surtout la nuit et pendant les heures asiatiques, et perd en journée. Achat à 21 h UTC (clôture de New York) du lundi au jeudi, revente à 7 h UTC (ouverture de Londres). Stop 0,8 %.',
  }),
  noise({
    id: 'n_noise',
    name: 'Nasdaq : sortie de la zone de bruit',
    desc: 'Zarattini, Aziz & Barbon (2024) : la zone de bruit est le mouvement moyen depuis l’ouverture, à chaque heure, sur 14 jours. Aux demi-heures, achat si le Nasdaq sort au-dessus, vente en dessous ; sortie quand le prix repasse le VWAP ou la borne, tout fermé à 15 h 55.',
  }),
  orbDir({
    id: 'n_orbdir',
    name: 'Nasdaq : sens de la 1re bougie de 5 min',
    desc: 'Zarattini & Aziz (2023) : achat si la 1re bougie de 5 min de la séance est haussière, vente si elle est baissière ; stop à l’autre extrême de la bougie, objectif 10 fois le risque, sinon sortie à 15 h 55.',
  }),
];

module.exports = { RESEARCH2, night, noise, orbDir };
