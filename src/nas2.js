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
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_drop',
    name: 'Nasdaq : rebond après une forte baisse d’un jour',
    desc: 'Retour à la moyenne : le Nasdaq perd plus de 2,5 % en une séance tout en restant au-dessus de sa moyenne 200 jours → achat à la clôture ; revente à la première clôture au-dessus du plus haut de la veille, ou au bout de 5 séances. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      const k = x.candles;
      const r = c[i] / c[i - 1] - 1;
      return { entry: r < -0.025 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] > k[i - 1].h, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_reversal',
    name: 'Nasdaq : journée de retournement',
    desc: 'Le Nasdaq ouvre en baisse de plus de 0,7 % (gap) mais clôture au-dessus de son ouverture, dans une tendance haussière (prix > moyenne 200 jours) : les vendeurs du matin ont été absorbés. Achat à la clôture, revente à la clôture suivante au-dessus du plus haut du jour, ou au bout de 5 séances. Stop sous le plus bas du jour.',
    evaluate(x, i) {
      const k = x.candles;
      const gap = k[i].o / k[i - 1].c - 1;
      const ok = gap < -0.007 && k[i].c > k[i].o && k[i].c > x.sma200[i];
      const risk = Math.max(k[i].c - k[i].l, 0.5 * x.atr[i]);
      return { entry: ok ? 'long' : null, exitLong: k[i].c > k[i - 1].h, exitShort: true, sl: ok ? risk : 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_low10',
    name: 'Nasdaq : plus bas de 10 jours dans la tendance',
    desc: 'Au-dessus de la moyenne 200 jours, une clôture au plus bas des 10 dernières séances → achat ; revente à la clôture au plus haut des 5 dernières séances. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      if (i < 12) return { entry: null, exitLong: false, exitShort: true, sl: 0, tp: null };
      const lo10 = Math.min(...c.slice(i - 9, i + 1));
      const hi5 = Math.max(...c.slice(i - 4, i));
      return { entry: c[i] <= lo10 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] >= hi5, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    needsTnx: true,
    id: 'n_yieldfall',
    name: 'Nasdaq : chute rapide des taux',
    desc: 'Quand le taux 10 ans US baisse de plus de 5 % en 5 séances (ex. 4,40 % → 4,15 %), les valeurs de croissance en profitent : achat du Nasdaq s’il est au-dessus de sa moyenne 50 jours, revente au bout de 10 séances ou si les taux repassent au-dessus de leur moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const t = x.tnx;
      const ok = t.c[i] !== null && t.r21[i] !== undefined;
      const fall = ok && i >= 5 && t.c[i - 5] && t.c[i] / t.c[i - 5] - 1 < -0.05;
      const up = t.c[i] !== null && t.sma10[i] !== null && t.c[i] > t.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    needsVix: true,
    id: 'n_vixfade',
    name: 'Nasdaq : vendre la panique (bond du VIX)',
    desc: 'Le VIX (peur) bondit de plus de 30 % en 3 séances alors que le Nasdaq reste au-dessus de sa moyenne 200 jours → achat ; revente quand le VIX repasse sous sa moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const v = x.vix;
      const jump = i >= 3 && v.c[i] !== null && v.c[i - 3] && v.c[i] / v.c[i - 3] - 1 > 0.3;
      const calm = v.c[i] !== null && v.sma10[i] !== null && v.c[i] < v.sma10[i];
      return { entry: jump && x.closes[i] > x.sma200[i] ? 'long' : null, exitLong: calm, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 260,
    id: 'n_ath',
    name: 'Nasdaq : nouveau plus haut historique',
    desc: 'Suivi de tendance : achat quand le Nasdaq clôture à un nouveau plus haut de 1 an (marché en pleine forme), revente si la baisse depuis le plus haut atteint 5 % (stop suiveur sur clôture). Stop de protection 3 ATR.',
    evaluate(x, i) {
      const c = x.closes[i];
      return { entry: c >= x.c252.max[i] ? 'long' : null, exitLong: false, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
    trail(pos, x, i) {
      return pos.best * 0.95;
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 260,
    needsAux: ['sox'],
    id: 'n_soxlead',
    name: 'Nasdaq : les semi-conducteurs en tête',
    desc: 'Les puces (indice SOX) anticipent souvent la tech : si le SOX a pris au moins 3 points de plus que le Nasdaq sur 10 séances et que le Nasdaq est au-dessus de sa moyenne 50 jours, achat ; revente au bout de 10 séances environ (quand l’avance du SOX disparaît) ou si le Nasdaq passe sous sa moyenne 50. Stop 3 ATR.',
    evaluate(x, i) {
      const sx = x.sox;
      if (i < 12 || sx.c[i] === null || !sx.c[i - 10]) return { entry: null, exitLong: x.closes[i] < x.sma50[i], exitShort: true, sl: 3 * x.atr[i], tp: null };
      const lead = (sx.c[i] / sx.c[i - 10] - 1) - (x.closes[i] / x.closes[i - 10] - 1);
      return { entry: lead > 0.03 && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: lead < 0 || x.closes[i] < x.sma50[i], exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 260,
    needsDxy: true,
    id: 'n_dollarfall',
    name: 'Nasdaq : chute rapide du dollar',
    desc: 'Quand l’indice du dollar (DXY) baisse de plus de 2 % en 10 séances, les grandes entreprises tech (revenus à l’étranger) en profitent : achat du Nasdaq s’il est au-dessus de sa moyenne 50 jours, revente quand le dollar repasse au-dessus de sa moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const d = x.dxy;
      const fall = i >= 10 && d.c[i] !== null && d.c[i - 10] && d.c[i] / d.c[i - 10] - 1 < -0.02;
      const up = d.c[i] !== null && d.sma10[i] !== null && d.c[i] > d.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 260,
    id: 'n_bigup',
    name: 'Nasdaq : très forte journée de hausse',
    desc: 'Une hausse de plus de 3 % en une séance, au-dessus de la moyenne 200 jours, montre l’arrivée d’acheteurs en masse : achat à la clôture, revente au bout de 10 séances (clôture sous la moyenne 10 jours) ou au stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      return { entry: c[i] / c[i - 1] - 1 > 0.03 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] < x.sma10[i], exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 260,
    id: 'n_mompb',
    name: 'Nasdaq : repli d’un mois dans une forte tendance',
    desc: 'Le Nasdaq a pris plus de 10 % en 3 mois mais a baissé sur le dernier mois : achat de ce repli ; revente quand il retrouve son plus haut de 20 séances, ou si la hausse sur 3 mois disparaît. Stop 3 ATR.',
    evaluate(x, i) {
      const r63 = x.roc63[i];
      const r21 = x.roc21 ? x.roc21[i] : (i >= 21 ? x.closes[i] / x.closes[i - 21] - 1 : null);
      const ok = r63 !== null && r21 !== null && r63 > 0.10 && r21 < 0;
      return { entry: ok ? 'long' : null, exitLong: x.closes[i] >= x.c20.max[i] || (r63 !== null && r63 < 0), exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_rsi30',
    name: 'Nasdaq : RSI 14 sous 30 dans la tendance',
    desc: 'Le signal de « survente » le plus classique : RSI 14 sous 30 alors que le Nasdaq reste au-dessus de sa moyenne 200 jours → achat ; revente quand le RSI 14 repasse au-dessus de 50. Stop 3 ATR.',
    evaluate(x, i) {
      const r = x.rsi[i];
      return { entry: r !== null && r < 30 && x.closes[i] > x.sma200[i] ? 'long' : null, exitLong: r > 50, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    id: 'n_2down',
    name: 'Nasdaq : deux fortes baisses de suite',
    desc: 'Deux séances d’affilée à plus de −1 % chacune, au-dessus de la moyenne 200 jours → achat à la clôture ; revente à la première clôture au-dessus du plus haut de la veille. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      const k = x.candles;
      const two = i >= 2 && c[i] / c[i - 1] - 1 < -0.01 && c[i - 1] / c[i - 2] - 1 < -0.01;
      return { entry: two && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] > k[i - 1].h, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    needsAux: ['oil'],
    id: 'n_oilfall',
    name: 'Nasdaq : chute rapide du pétrole',
    desc: 'Un pétrole qui chute de plus de 10 % en 10 séances fait baisser l’inflation attendue et les coûts des entreprises : achat du Nasdaq s’il est au-dessus de sa moyenne 50 jours ; revente quand le pétrole repasse au-dessus de sa moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const o = x.oil;
      if (!o) return { entry: null, exitLong: true, exitShort: true, sl: 0, tp: null };
      const fall = i >= 10 && o.c[i] !== null && o.c[i - 10] && o.c[i] / o.c[i - 10] - 1 < -0.1;
      const up = o.c[i] !== null && o.sma10[i] !== null && o.c[i] > o.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    needsAux: ['peer'],
    id: 'n_goldfall',
    name: 'Nasdaq : chute rapide de l’or',
    desc: 'Quand l’or (valeur refuge) perd plus de 4 % en 10 séances, les investisseurs reprennent du risque : achat du Nasdaq s’il est au-dessus de sa moyenne 50 jours ; revente quand l’or repasse au-dessus de sa moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const g = x.peer;
      const fall = i >= 10 && g.c[i] !== null && g.c[i - 10] && g.c[i] / g.c[i - 10] - 1 < -0.04;
      const up = g.c[i] !== null && g.sma10[i] !== null && g.c[i] > g.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '1d', onlyTf: ['1d'], markets: ['nas100'], nas2: true, warmup: 210,
    needsAux: ['spx'],
    id: 'n_rsspx',
    name: 'Nasdaq : plus fort que le S&P 500',
    desc: 'Leadership de la tech : investi quand le Nasdaq 100 fait mieux que le S&P 500 sur 3 mois ET est au-dessus de sa moyenne 50 jours ; dehors sinon. Stop 4 ATR.',
    evaluate(x, i) {
      const sp = x.spx;
      if (!sp || i < 63 || sp.c[i] === null || !sp.c[i - 63]) return { entry: null, exitLong: true, exitShort: true, sl: 0, tp: null };
      const rs = (x.closes[i] / x.closes[i - 63]) - (sp.c[i] / sp.c[i - 63]);
      const on = rs > 0 && x.closes[i] > x.sma50[i];
      return { entry: on ? 'long' : null, exitLong: !on, exitShort: true, sl: 4 * x.atr[i], tp: null };
    },
  },
];

module.exports = { NAS2, nyseHolidays, beforeHoliday };
