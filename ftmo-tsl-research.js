#!/usr/bin/env node
/**
 * Stop suiveur (TSL) sur le compte FTMO (npm run ftmo-tsl) : aide-t-il le challenge ?
 * Variantes appliquées aux stratégies du compte FTMO (journalières, intraday, ou toutes), sur l'historique complet :
 *   BE 1R : stop au prix d'entrée dès +1 R · TSL 1R/1R : dès +1 R, stop à 1 R du meilleur cours · TSL 1,5R/1R ·
 *   TSL 1R/0,5R · Chandelier 3 ATR : stop à 3 ATR du meilleur cours (dès l'entrée, ne recule jamais).
 * Le stop suiveur se règle sur les clôtures de bougie (5 min en intraday, jour en journalier) et ne fait que se resserrer.
 * Mesure : réussite du challenge FTMO 1 étape en moins d'un an (délai médian) sur 2009–19 | 2020–26 | nov. 24–26.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const DAY = 86400;

/** Stop suiveur : après +act R, stop à dist R du meilleur cours (dist 0 = prix d'entrée) ; atr : k ATR du meilleur cours. */
function withTrail(s, { act = 1, dist = 1, atr = 0 }) {
  return {
    ...s,
    trail(pos, ind, i) {
      const prev = s.trail ? s.trail(pos, ind, i) : NaN;
      const long = pos.side === 'long';
      const r = Math.abs(pos.entry - pos.initSl);
      let next = NaN;
      if (atr) {
        const a = ind.atr?.[i];
        if (a > 0) next = long ? pos.best - atr * a : pos.best + atr * a;
      } else {
        const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
        if (fav >= act * r) next = dist === 0 ? pos.entry : long ? pos.best - dist * r : pos.best + dist * r;
      }
      if (!Number.isFinite(next)) return prev;
      if (!Number.isFinite(prev)) return next;
      return long ? Math.max(prev, next) : Math.min(prev, next);
    },
  };
}
const VARIANTS = {
  'aucun (actuel)': null,
  'BE 1R': { act: 1, dist: 0 },
  'TSL 1R / 1R': { act: 1, dist: 1 },
  'TSL 1,5R / 1R': { act: 1.5, dist: 1 },
  'TSL 2R / 1R': { act: 2, dist: 1 },
  'TSL 1R / 0,5R': { act: 1, dist: 0.5 },
  'Chandelier 3 ATR': { atr: 3 },
  'Chandelier 4 ATR': { atr: 4 },
};

(async () => {
  const A = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const sizer = RULES[cfg.ftmoSizing];
  const RF = { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer };
  const isIntra = (s) => s.tf && s.tf !== '1d';
  const cache = {};
  const listFor = async (v, scope) => {
    const key = `${JSON.stringify(v)}|${scope}`;
    if (cache[key]) return cache[key];
    const apply = (s) => v && (scope === 'tous' || (scope === 'intraday') === isIntra(s));
    const wrap = (s) => (apply(s) ? withTrail(s, v) : s);
    const { all, q5 } = await buildTrades(cfg, CACHE, { wrap });
    const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100'));
    const nas = sids.filter((k) => k.startsWith('nas100:') && isIntra(strat(k)[1])).flatMap((k) => {
      const s = wrap(strat(k)[1]);
      return backtest(s, qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list.map((t) => ({ ...t, sid: k, market: 'nas100', intraday: true }));
    });
    const list = [...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
    return (cache[key] = { list, A0: q5[0].t + 30 * DAY });
  };
  const evalL = ({ list, A0 }) => Object.entries({ B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] }).map(([k, [a, b]]) => {
    const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
    const c = challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...RF });
    return `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`;
  }).join(' | ');
  console.log('FTMO 1 étape · réussite < 1 an (délai médian) : 2009–19 | 2020–26 | nov. 24–26');
  for (const scope of ['intraday', 'journalier', 'tous']) {
    console.log(`\n=== Stop suiveur sur : ${scope} ===`);
    for (const [name, v] of Object.entries(VARIANTS)) {
      if (!v && scope !== 'intraday') continue;
      console.log(`${name.padEnd(20)} ${evalL(await listFor(v, scope))}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
