/**
 * Stratégies d'événements du calendrier (journalières), documentées dans la littérature :
 *   pre_fomc : « dérive avant la Fed » (Lucca & Moench 2015) — les actions montent dans les 24 h avant l'annonce de la
 *              Réserve fédérale : achat à la clôture de la veille, revente à la clôture du jour de l'annonce.
 *   pre_hol  : « effet veille de jour férié » (Ariel 1990) — achat à la clôture 2 séances avant un jour férié de la
 *              Bourse de New York, revente à la clôture de la veille du férié.
 * Calendriers : annonces programmées du FOMC (federalreserve.gov, 2009–2026) et jours fériés NYSE (règles + fermetures
 * exceptionnelles), connus à l'avance — donc utilisables en direct sans regarder le futur des cours.
 */

// Jours d'annonce des réunions programmées du FOMC (dernier jour de réunion), d'après federalreserve.gov
const FOMC = new Set(`2009-01-28 2009-03-18 2009-04-29 2009-06-24 2009-08-12 2009-09-23 2009-11-04 2009-12-16
2010-01-27 2010-03-16 2010-04-28 2010-06-23 2010-08-10 2010-09-21 2010-11-03 2010-12-14
2011-01-26 2011-03-15 2011-04-27 2011-06-22 2011-08-09 2011-09-21 2011-11-02 2011-12-13
2012-01-25 2012-03-13 2012-04-25 2012-06-20 2012-08-01 2012-09-13 2012-10-24 2012-12-12
2013-01-30 2013-03-20 2013-05-01 2013-06-19 2013-07-31 2013-09-18 2013-10-30 2013-12-18
2014-01-29 2014-03-19 2014-04-30 2014-06-18 2014-07-30 2014-09-17 2014-10-29 2014-12-17
2015-01-28 2015-03-18 2015-04-29 2015-06-17 2015-07-29 2015-09-17 2015-10-28 2015-12-16
2016-01-27 2016-03-16 2016-04-27 2016-06-15 2016-07-27 2016-09-21 2016-11-02 2016-12-14
2017-02-01 2017-03-15 2017-05-03 2017-06-14 2017-07-26 2017-09-20 2017-11-01 2017-12-13
2018-01-31 2018-03-21 2018-05-02 2018-06-13 2018-08-01 2018-09-26 2018-11-08 2018-12-19
2019-01-30 2019-03-20 2019-05-01 2019-06-19 2019-07-31 2019-09-18 2019-10-30 2019-12-11
2020-01-29 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16
2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15
2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09`.split(/\s+/));

const iso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));

/** Dimanche de Pâques (algorithme de Meeus). */
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const d = Math.floor(b / 4); const e = b % 4;
  const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4); const k = c % 4; const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(y, month - 1, day);
}
/** n-ième jour de semaine `wd` (0 = dimanche) du mois ; n = -1 : le dernier. */
function nth(y, m, wd, n) {
  if (n > 0) { const d = utc(y, m, 1); const off = (wd - d.getUTCDay() + 7) % 7; return utc(y, m, 1 + off + 7 * (n - 1)); }
  const d = utc(y, m + 1, 0); const off = (d.getUTCDay() - wd + 7) % 7; return utc(y, m, d.getUTCDate() - off);
}
/** Férié tombant un week-end : samedi → vendredi, dimanche → lundi (règle NYSE). */
function observed(d) {
  const w = d.getUTCDay();
  if (w === 6) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
  if (w === 0) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return d;
}
const holCache = new Map();
/** Jours fériés de la Bourse de New York d'une année (AAAA-MM-JJ). */
function nyseHolidays(y) {
  if (holCache.has(y)) return holCache.get(y);
  const days = [
    utc(y, 0, 1).getUTCDay() === 6 ? null : observed(utc(y, 0, 1)), // 1er janvier un samedi : pas de report au 31 déc.
    nth(y, 0, 1, 3), nth(y, 1, 1, 3), // Martin Luther King, Presidents' Day
    utc(y, easter(y).getUTCMonth(), easter(y).getUTCDate() - 2), // Vendredi saint
    nth(y, 4, 1, -1), // Memorial Day
    y >= 2022 ? observed(utc(y, 5, 19)) : null, // Juneteenth
    observed(utc(y, 6, 4)), nth(y, 8, 1, 1), nth(y, 10, 4, 4), observed(utc(y, 11, 25)), // 4 juillet, Labor Day, Thanksgiving, Noël
  ].filter(Boolean).map(iso);
  // Fermetures exceptionnelles
  const extra = { 2001: ['2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14'], 2004: ['2004-06-11'], 2007: ['2007-01-02'], 2012: ['2012-10-29', '2012-10-30'], 2018: ['2018-12-05'], 2025: ['2025-01-09'] };
  const set = new Set([...days, ...(extra[y] || [])]);
  holCache.set(y, set);
  return set;
}
const isHoliday = (d) => nyseHolidays(d.getUTCFullYear()).has(iso(d));
const isTradingDay = (d) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !isHoliday(d);
/** Séance suivante (après la date d). */
function nextTradingDay(d) {
  let x = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  while (!isTradingDay(x)) x = utc(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + 1);
  return x;
}
/** La séance suivante est-elle la veille d'un jour férié (le jour d'après n'est pas une séance pour cause de férié) ? */
function isPreHoliday(d) {
  const next = utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  // Prochain jour de semaine après d
  let x = next;
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x = utc(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + 1);
  return isHoliday(x);
}

const dayOf = (t) => new Date(Math.floor(t / 86400) * 86400 * 1000); // bougie journalière : date UTC de la séance
const isFomcDay = (t) => FOMC.has(iso(dayOf(t)));
const isPreFomc = (t) => FOMC.has(iso(nextTradingDay(dayOf(t))));
/** Veille de la veille d'un férié : la séance suivante est la dernière avant le férié. */
const isPrePreHoliday = (t) => isPreHoliday(nextTradingDay(dayOf(t)));
const isPreHolidayDay = (t) => isPreHoliday(dayOf(t));

const BASE = { tf: '1d', warmup: 30, markets: ['nas100', 'gold'] };
const EVENTS = [
  {
    ...BASE,
    id: 'pre_fomc',
    name: 'Veille de la Fed',
    desc: 'Dérive avant l’annonce de la Réserve fédérale (Lucca & Moench 2015) : achat à la clôture de la veille d’une annonce programmée du FOMC, revente à la clôture du jour de l’annonce. Stop 2 ATR.',
    evaluate(ind, i) {
      const t = ind.candles[i].t;
      return { entry: isPreFomc(t) ? 'long' : null, exitLong: isFomcDay(t), exitShort: true, sl: 2 * ind.atr[i], tp: null };
    },
  },
  {
    ...BASE,
    id: 'pre_hol',
    name: 'Veille de jour férié',
    desc: 'Effet veille de férié (Ariel 1990) : achat à la clôture deux séances avant un jour férié de la Bourse de New York, revente à la clôture de la veille du férié. Stop 2 ATR.',
    evaluate(ind, i) {
      const t = ind.candles[i].t;
      return { entry: isPrePreHoliday(t) ? 'long' : null, exitLong: isPreHolidayDay(t), exitShort: true, sl: 2 * ind.atr[i], tp: null };
    },
  },
];

module.exports = { EVENTS, FOMC, nyseHolidays, isPreFomc, isFomcDay, isPreHoliday, nextTradingDay };
