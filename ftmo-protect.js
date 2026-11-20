#!/usr/bin/env node
/**
 * Risque qui baisse à l'approche de l'objectif (src/sizing.js, règles « objectif : … ») contre le réglage actuel,
 * sur le compte FTMO (formule FTMO_PROGRAM), avec le risque de base × 1 / 0,75 / 0,5. Réglage choisi sur 2009–2019
 * (réussite en moins d'un an), vérifié sur 2020–2026 et nov. 2024 → nov. 2026 (Nasdaq intraday compris).
 *
 *   npm run ftmo-protect
 */
const path = require('path');
const cfg = require('./src/config');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const SIZINGS = ['plusieurs positions → moins', ...Object.keys(RULES).filter((k) => k.startsWith('objectif'))];
const MULS = (process.env.RISKS || '1,0.75,0.5').split(',').map(Number);

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE);
  const F = programOf(cfg);
  const noNasIntra = (t) => !(t.intraday && t.market === 'nas100');
  const P = { B: ['2009–2019', Y(2009) + 60 * 86400, Y(2020), noNasIntra], C: ['2020–2026', Y(2020), Infinity, noNasIntra] };
  if (q5) P.A = ['nov. 24–26', q5[0].t + 30 * 86400, Infinity, () => true];
  const L = Object.fromEntries(Object.entries(P).map(([k, [, a, b, f]]) => [k, all.filter((t) => t.entryT >= a && t.entryT < b && f(t))]));
  const run = (k, sizing, mul) => {
    const c = challengeStats(L[k].map((t) => ({ ...t, riskPct: t.riskPct * mul })), {
      riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[sizing], steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, horizonDays: 365, start: P[k][1],
    });
    c.pass6 = (c.durations.filter((d) => d <= 180).length / c.tries) * 100;
    return c;
  };
  const f = (c) => `${c.pass6.toFixed(0).padStart(3)} % / ${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, ${c.failedDaily}/${c.failedMax})`;
  console.log(`=== ${F.label} · risque qui baisse à l'approche de l'objectif · « < 6 mois / < 1 an (médiane, échecs jour/max) » ===`);
  console.log(`${''.padEnd(46)}${Object.values(P).map((p) => p[0].padEnd(30)).join('')}`);
  const rows = [];
  for (const mul of MULS) for (const sz of SIZINGS) {
    const r = Object.fromEntries(Object.keys(P).map((k) => [k, run(k, sz, mul)]));
    rows.push({ mul, sz, r });
    console.log(`  × ${String(mul).padEnd(5)} ${sz.padEnd(38)}${Object.keys(P).map((k) => f(r[k]).padEnd(30)).join('')}`);
  }
  rows.sort((a, b) => b.r.B.passRate - a.r.B.passRate || b.r.B.pass6 - a.r.B.pass6);
  const b = rows[0];
  console.log(`\n→ meilleur sur 2009–2019 : risque × ${b.mul}, « ${b.sz} » : ${Object.keys(P).map((k) => `${P[k][0]} ${f(b.r[k])}`).join(' · ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
