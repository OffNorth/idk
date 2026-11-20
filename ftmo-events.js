#!/usr/bin/env node
/**
 * Stratégies d'événements (src/events.js : veille de la Fed, veille de férié) sur le S&P 500, le Nasdaq et l'or :
 *   1. résultat seul par période (2009–2012, 2013–2016, 2017–2019, 2020–2026), frais et financement compris ;
 *   2. ajoutées au compte FTMO (stratégies actuelles + celles qui sont positives sur les 3 périodes de choix),
 *      risque de chaque marché, formule FTMO_PROGRAM, risque qui baisse à l'approche de l'objectif : réussite du
 *      challenge en moins d'un an, choix 2009–2019, vérification 2020–2026 ; et compte Lucid (règles LucidFlex 50K).
 *
 *   npm run ftmo-events
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');
const { challengeStats, cmeDay } = require('./src/ftmo');
const { programOf, accountOf, MICRO } = require('./src/ftmoAccount');
const { RULES, annotate } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [['2009–12', Y(2009), Y(2013)], ['2013–16', Y(2013), Y(2017)], ['2017–19', Y(2017), Y(2020)], ['2020–26', Y(2020), Infinity]];
const FEE = { gold: [0.005, 4], nas100: [0.003, 6], spx: [0.003, 6], eurusd: [0.002, 3] };

(async () => {
  const { all, daily, vix } = await buildTrades(cfg, CACHE);
  const A = accountOf(cfg, 'gold');
  const base = all.filter((t) => !(t.intraday && t.market === 'nas100'));
  console.log('=== 1. Stratégies d\'événements seules (somme des gains en %, nombre de trades) ===');
  const keep = [];
  for (const m of ['spx', 'nas100', 'gold']) {
    const d = daily[m];
    for (const s of selectStrategies(['pre_fomc', 'pre_hol'])) {
      const r = backtest(s, d.c, { size: 1000, feePct: FEE[m][0], financingPct: FEE[m][1], barSec: 86400, ind: d.ind, daily: d.c, vix, aux: d.aux, market: m === 'gold' ? 'gold' : 'nas100' });
      const parts = P.map(([, a, b]) => { const l = r.list.filter((t) => t.entryT >= a && t.entryT < b); return { n: l.length, sum: l.reduce((x, t) => x + t.pnlPct, 0), win: l.filter((t) => t.pnlPct > 0).length }; });
      const ok = parts.slice(0, 3).every((x) => x.sum > 0);
      console.log(`  ${ok ? '✔' : '✘'} ${m.padEnd(6)} ${s.id.padEnd(9)} ${parts.map((x, i) => `${P[i][0]} ${x.sum >= 0 ? '+' : ''}${x.sum.toFixed(1)} % (${x.n}, ${x.n ? Math.round((x.win / x.n) * 100) : 0} % gagn.)`).join(' · ')}`);
      if (ok) {
        const mc = MICRO[m];
        keep.push(...r.list.map((t) => ({ ...t, sid: `${m}:${s.id}`, market: m, intraday: false, riskPct: A.riskOf(m, { tf: '1d' }), contractUsd: t.entry * mc.mult, contractFee: mc.fee })));
      }
    }
  }
  const added = [...new Set(keep.map((t) => t.sid))];
  console.log(`  → retenues (positives sur 2009–2019) : ${added.join(', ') || 'aucune'}`);
  if (!added.length) return;
  annotate(keep);

  const F = programOf(cfg);
  const ftmo = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, horizonDays: 365 };
  const lucid = { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: 50, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, horizonDays: 365 };
  const row = (label, list, opts) => {
    const cells = [['2009–2019', Y(2009) + 60 * 86400, Y(2020)], ['2020–2026', Y(2020), Infinity]].map(([lbl, a, b]) => {
      const c = challengeStats(list.filter((t) => t.entryT >= a && t.entryT < b), { ...opts, start: a, ...(Number.isFinite(b) ? { end: b } : {}) });
      return `${lbl} ${c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)` : '—'}`;
    });
    console.log(`  ${label.padEnd(40)} ${cells.join(' · ')}`);
  };
  console.log('\n=== 2. Réussite du challenge en moins d\'un an (médiane) ===');
  console.log(`${F.label} :`);
  row('compte actuel', base, ftmo);
  row(`+ ${added.join(', ')}`, [...base, ...keep], ftmo);
  for (const k of added) row(`+ ${k} seule`, [...base, ...keep.filter((t) => t.sid === k)], ftmo);
  console.log('LucidFlex 50K :');
  row('compte actuel', base, lucid);
  row(`+ ${added.join(', ')}`, [...base, ...keep], lucid);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
