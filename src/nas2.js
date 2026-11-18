/**
 * Nasdaq 100 : effets de marché documentés, pas encore dans le bot.
 *   n_overnight   — l'essentiel de la hausse des actions US se fait la nuit (clôture → ouverture) : achat à la clôture de 16 h
 *                   New York, vente sur la 1re bougie après l'ouverture du lendemain, toutes les nuits.
 *   n_gapfill     — un écart d'ouverture (gap) modéré a tendance à se refermer dans la journée.
 *   n_firsthour   — une première heure forte annonce souvent une journée dans le même sens.
 *   n_preholiday  — la veille d'un jour férié américain, les indices montent plus souvent qu'à l'ordinaire.
 * Les trois premières en bougies 5 min (heure de New York), la dernière en journalier.
 */
const { computeScalp2, helpers } = require('./scalp2');

const { weekday } = helpers;
const NY = { open: 9 * 60 + 30, close: 16 * 60 };
const BASE = { tf: '5m', onlyTf: ['5m'], markets: ['nas100'], scalp: true, nas2: true, warmup: 700, compute: (c, s, m) => computeScalp2(c, s, m) };
const none = (exit = false) => ({ entry: null, exitLong: exit, exitShort: exit, sl: 0, tp: null });

/* ---------- Jours fériés de la Bourse de New York (règles officielles) ---------- */

function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return Date.UTC(y, month - 1, ((h + l - 7 * m + 114) % 31) + 1);
}
const nth = (y, mo, wd, n) => { const d = new Date(Date.UTC(y, mo, 1)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d.getTime(); };
const last = (y, mo, wd) => { const d = new Date(Date.UTC(y, mo + 1, 0)); while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1); return d.getTime(); };
/** Fixe : reporté au vendredi si samedi, au lundi si dimanche. */
const observed = (t) => { const d = new Date(t); if (d.getUTCDay() === 6) return t - 86400e3; if (d.getUTCDay() === 0) return t + 86400e3; return t; };
const holidayCache = new Map();
/** Jours fériés NYSE (ms à minuit UTC) d'une année. */
function nyseHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set([
    observed(Date.UTC(y, 0, 1)), nth(y, 0, 1, 3), nth(y, 1, 1, 3), easter(y) - 2 * 86400e3, last(y, 4, 1),
    ...(y >= 2022 ? [observed(Date.UTC(y, 5, 19))] : []), observed(Date.UTC(y, 6, 4)), nth(y, 8, 1, 1), nth(y, 10, 4, 4), observed(Date.UTC(y, 11, 25)),
  ]);
  holidayCache.set(y, set);
  return set;
}
/** Le prochain jour de semaine après t (secondes) est-il férié ? */
function beforeHoliday(t) {
  const d = new Date(Math.floor(t / 86400) * 86400e3);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return nyseHolidays(d.getUTCFullYear()).has(d.getTime());
}

const NAS2 = [
  {
    ...BASE,
    id: 'n_overnight',
    name: 'Nasdaq : effet de nuit (clôture → ouverture)',
    desc: 'Effet très documenté (Cooper, Cliff & Gulen 2008 ; Kelly & Clark 2011) : l’essentiel de la hausse des actions US se fait pendant la nuit. Achat à la clôture de 16 h New York (dernière bougie de la séance), revente sur la première bougie après l’ouverture du lendemain (9 h 35). Toutes les nuits, sans filtre. Stop de protection à 3 %.',
    evaluate(x, i) {
      const m = x.min[i];
      const exit = m >= NY.open && m < NY.close - 10; // vente sur la 1re bougie de la séance suivante
      if (!weekday(x, i)) return none(false);
      if (m === NY.close - 5) return { entry: 'long', exitLong: false, exitShort: true, sl: 0.03 * x.closes[i], tp: null };
      return none(exit);
    },
  },
  {
    ...BASE,
    id: 'n_gapfill',
    name: 'Nasdaq : comblement de l’écart d’ouverture',
    desc: 'Si le Nasdaq ouvre entre 0,4 % et 1,5 % sous la clôture de la veille (ou au-dessus), il a tendance à revenir vers cette clôture dans la journée. Entrée à la clôture de la 1re bougie de 5 min dans le sens du comblement, objectif la clôture de la veille, stop à la même distance de l’autre côté, sortie au plus tard à 15 h 55.',
    evaluate(x, i) {
      const m = x.min[i];
      const flat = !weekday(x, i) || m >= NY.close - 5 || m < NY.open;
      if (!weekday(x, i) || m !== NY.open || x.pClose[i] === null || x.dOpen[i] === null) return none(flat);
      const gap = x.dOpen[i] / x.pClose[i] - 1;
      if (Math.abs(gap) < 0.004 || Math.abs(gap) > 0.015) return none(flat);
      const c = x.closes[i];
      const dist = Math.abs(x.pClose[i] - c);
      if (dist < 0.5 * x.atr[i]) return none(flat);
      return { entry: gap < 0 ? 'long' : 'short', exitLong: false, exitShort: false, sl: dist, tp: dist };
    },
  },
  {
    ...BASE,
    id: 'n_firsthour',
    name: 'Nasdaq : première heure forte',
    desc: 'Si le Nasdaq a pris plus de 0,5 % entre l’ouverture et 10 h 30 New York (ou perdu plus de 0,5 %), on suit ce sens jusqu’à 15 h 55. Stop à la moitié du mouvement de la première heure (au moins 1 ATR).',
    evaluate(x, i) {
      const m = x.min[i];
      const flat = !weekday(x, i) || m >= NY.close - 5 || m < NY.open;
      if (!weekday(x, i) || m !== NY.open + 55 || x.dOpen[i] === null) return none(flat);
      const r = x.closes[i] / x.dOpen[i] - 1;
      if (Math.abs(r) < 0.005) return none(flat);
      const sl = Math.max(x.atr[i], Math.abs(x.closes[i] - x.dOpen[i]) / 2);
      return { entry: r > 0 ? 'long' : 'short', exitLong: flat, exitShort: flat, sl, tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_preholiday',
    name: 'Nasdaq : veille de jour férié',
    desc: 'Effet de calendrier connu (Ariel 1990) : les indices US montent plus souvent la veille d’un jour férié de la Bourse de New York. Achat à la clôture de l’avant-veille du jour férié, revente à la clôture de la veille. Stop 2 ATR.',
    evaluate(x, i) {
      const t = x.candles[i].t;
      // Le calendrier des fériés est connu à l'avance. Demain est la veille d'un férié → achat aujourd'hui, sortie demain soir
      const nextDay = (() => { const d = new Date(Math.floor(t / 86400) * 86400e3); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || nyseHolidays(d.getUTCFullYear()).has(d.getTime())); return d.getTime() / 1000; })();
      const enter = beforeHoliday(nextDay) && !beforeHoliday(t);
      return { entry: enter ? 'long' : null, exitLong: !enter, exitShort: true, sl: 2 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_opex',
    name: 'Nasdaq : semaine d’expiration des options',
    desc: 'Effet documenté (Stivers & Sun 2013) : les indices US montent plus souvent pendant la semaine de l’expiration mensuelle des options (celle du 3e vendredi du mois). Achat à la clôture du vendredi précédent, revente à la clôture du 3e vendredi. Stop 3 ATR.',
    evaluate(x, i) {
      const d = new Date(x.candles[i].t * 1000);
      const thirdFriday = (y, m) => { const f = new Date(Date.UTC(y, m, 1)); while (f.getUTCDay() !== 5) f.setUTCDate(f.getUTCDate() + 1); f.setUTCDate(f.getUTCDate() + 14); return f; };
      const tf = thirdFriday(d.getUTCFullYear(), d.getUTCMonth());
      const daysTo = Math.round((tf - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400e3);
      // Entrée : dernière séance de la semaine précédant la semaine d'expiration (vendredi, ou jeudi si vendredi férié)
      const enter = daysTo >= 7 && daysTo <= 9 && d.getUTCDay() >= 4;
      const exit = daysTo <= 0;
      return { entry: enter ? 'long' : null, exitLong: exit, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_santa',
    name: 'Nasdaq : rallye de Noël',
    desc: 'Effet de calendrier connu (« Santa Claus rally », Hirsch) : les 5 dernières séances de décembre et les 2 premières de janvier sont souvent positives. Achat à la clôture du 6e jour de bourse avant la fin de l’année, revente à la clôture du 2e jour de bourse de janvier. Stop 3 ATR.',
    evaluate(x, i) {
      const d = new Date(x.candles[i].t * 1000);
      const m = d.getUTCMonth();
      const tdom = x.cal ? x.cal.tdom[i] : 99;
      const left = x.cal ? x.cal.bizLeft[i] : 99;
      return { entry: m === 11 && left === 6 ? 'long' : null, exitLong: m === 0 && tdom >= 2, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_weekrev',
    name: 'Nasdaq : rebond après une mauvaise semaine',
    desc: 'Retour à la moyenne hebdomadaire dans la tendance : si le Nasdaq a perdu plus de 3 % sur la semaine (5 séances) tout en restant au-dessus de sa moyenne 200 jours, achat à la clôture ; revente quand il retrouve son plus haut de 5 séances, ou au bout de 10 séances. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      if (i < 15) return { entry: null, exitLong: false, exitShort: true, sl: 0, tp: null };
      const wk = c[i] / c[i - 5] - 1;
      const hi5 = Math.max(...c.slice(i - 5, i));
      return { entry: wk < -0.03 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] >= hi5, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...BASE,
    id: 'n_halfhalf',
    name: 'Nasdaq : 1re demi-heure → dernière demi-heure',
    desc: 'Gao, Han, Li & Zhou (2018) : le rendement de la première demi-heure (9 h 30 → 10 h New York) annonce le sens de la dernière demi-heure. Entrée à 15 h 30 dans le sens de la 1re demi-heure (si elle a bougé de plus de 0,2 %), sortie à 15 h 55. Stop 1,5 ATR.',
    evaluate(x, i) {
      const m = x.min[i];
      const out = !weekday(x, i) || m >= NY.close - 5 || m < NY.close - 30;
      if (!weekday(x, i) || m !== NY.close - 30 || x.dOpen[i] === null) return none(out);
      // clôture de 10 h : dernière bougie avant 10 h du même jour
      let j = i;
      while (j > 0 && x.day[j] === x.day[i] && x.min[j] >= NY.open + 30) j--;
      if (x.day[j] !== x.day[i] || x.min[j] < NY.open) return none(out);
      const r = x.closes[j] / x.dOpen[i] - 1;
      if (Math.abs(r) < 0.002) return none(out);
      return { entry: r > 0 ? 'long' : 'short', exitLong: false, exitShort: false, sl: 1.5 * x.atr[i], tp: null };
    },
  },
  {
    ...BASE,
    id: 'n_trendday',
    name: 'Nasdaq : journée de tendance (VWAP à midi)',
    desc: 'À midi New York, si le prix est au-dessus du VWAP de la séance ET au-dessus de l’ouverture (journée acheteuse), achat jusqu’à 15 h 55 ; inverse si en dessous des deux. Stop sous le VWAP (au moins 1 ATR).',
    evaluate(x, i) {
      const m = x.min[i];
      const flat = !weekday(x, i) || m >= NY.close - 5 || m < NY.open;
      if (!weekday(x, i) || m !== 12 * 60 || x.vwap[i] === null || x.dOpen[i] === null) return none(flat);
      const c = x.closes[i];
      const v = x.vwap[i];
      if (c > v && c > x.dOpen[i]) return { entry: 'long', exitLong: flat, exitShort: true, sl: Math.max(x.atr[i], c - v), tp: null };
      if (c < v && c < x.dOpen[i]) return { entry: 'short', exitLong: true, exitShort: flat, sl: Math.max(x.atr[i], v - c), tp: null };
      return none(flat);
    },
  },
];

module.exports = { NAS2, nyseHolidays, beforeHoliday };
