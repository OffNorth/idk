#!/usr/bin/env node
/**
 * Quelle formule FTMO nos stratégies réussissent-elles le plus souvent ? Même compte (or 5 / 15 min + Nasdaq
 * journalier, levier dynamique), rejoué sous les règles de chaque formule (sources secondaires 2026, à vérifier) :
 *   2 étapes Standard : +10 % puis +5 %, perte du jour 5 %, perte max 10 % fixe, levier 1:30 (ou 1:100)
 *   2 étapes Swing    : mêmes objectifs et pertes, levier 1:10 sur l'or et les indices
 *   1 étape           : +10 %, perte du jour 3 %, perte max 10 % SUIVEUSE (depuis le plus haut), meilleur jour ≤ 50 % du gain
 * Pour chaque formule : risque de l'or 0,25 → 0,75 %, risque du Nasdaq 0,5 / 1 %, stop du jour maison 1 / 2 %.
 * Choix sept. 2020 → oct. 2024, vérification sur les 2 dernières années ; réussite en moins de 6 mois et d'un an.
 *
 *   npm run ftmo-formulas
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');
const { annotate, RULES } = require('./src/sizing');

const CACHE = path.join(__dirname, 'data', 'research');
const strip = (l) => l.map((x) => x.split(':').slice(1).join(':'));
const FORMULAS = {
  '2 étapes Standard (1:30)': { steps: 2, dailyPct: 5, leverage: 30 },
  '2 étapes Standard (1:100)': { steps: 2, dailyPct: 5, leverage: 100 },
  '2 étapes Swing (1:10)': { steps: 2, dailyPct: 5, leverage: 30, levCap: { gold: 10, nas100: 10 } },
  '1 étape': { steps: 1, dailyPct: 3, leverage: 30, trailingMax: true, bestDayPct: 50 },
  '1 étape (sans règle du meilleur jour)': { steps: 1, dailyPct: 3, leverage: 30, trailingMax: true },
};

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const vix = await y('^VIX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: await y('GC=F') };
  const nind = computeAll(nd, nd, 86400, null, vix, aux);
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const G = { '5m': g5, '15m': aggregate(g5, 900, 300) };
  const t0 = g5[0].t + 30 * 86400;
  const SPLIT = g5[g5.length - 1].t - 2 * 365 * 86400;

  const all = [];
  for (const s of selectStrategies(strip(cfg.ftmoStrategies))) {
    const tf = tfOf(s);
    all.push(...backtest(s, G[tf], { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.map((t) => ({ ...t, sid: `gold:${s.id}`, market: 'gold' })));
  }
  for (const s of selectStrategies(strip(cfg.ftmoNasStrategies)))
    all.push(...backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.map((t) => ({ ...t, sid: `nas100:${s.id}`, market: 'nas100' })));
  annotate(all);
  const T0 = all.filter((t) => t.entryT >= t0);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;

  const run = (F, gr, nr, ds, part, horizonDays) => {
    const l = T0.filter((t) => (part === 'choix' ? t.entryT < SPLIT : t.entryT >= SPLIT)).map((t) => ({ ...t, riskPct: t.market === 'gold' ? gr : nr }));
    return challengeStats(l, { riskPct: 1, dayStopPct: ds, horizonDays, sizer, ...F, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  };
  const pr = (c) => (c ? c.passRate : 0);
  console.log(`=== Formules FTMO · même compte or + Nasdaq · choix → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)}, vérification ensuite ===`);
  console.log('Réussite < 6 mois (médiane j, échecs perte du jour / perte max) | < 1 an\n');
  const best = [];
  for (const [name, F] of Object.entries(FORMULAS)) {
    console.log(name);
    const rows = [];
    for (const gr of [0.25, 0.35, 0.5, 0.75]) for (const nr of [0.5, 1]) for (const ds of [1, 2]) {
      const a = run(F, gr, nr, ds, 'choix', 180);
      const a1 = run(F, gr, nr, ds, 'choix', 365);
      const b = run(F, gr, nr, ds, 'verif', 180);
      const b1 = run(F, gr, nr, ds, 'verif', 365);
      rows.push({ gr, nr, ds, a, a1, b, b1 });
    }
    rows.sort((p, q) => pr(q.a) - pr(p.a) || pr(q.a1) - pr(p.a1));
    const f = (c) => (c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, ${c.failedDaily}/${c.failedMax})` : '—');
    for (const r of rows.slice(0, 5)) {
      console.log(`  or ${String(r.gr).padEnd(4)} % · Nasdaq ${String(r.nr).padEnd(3)} % · stop du jour ${r.ds} % : choix ${f(r.a)} | ${pr(r.a1).toFixed(0)} %   →   vérif ${f(r.b)} | ${pr(r.b1).toFixed(0)} %`);
    }
    best.push({ name, ...rows[0] });
    console.log('');
  }
  console.log('Meilleur réglage de chaque formule (choisi sur la période de choix) :');
  for (const r of best) console.log(`  ${r.name.padEnd(40)} or ${r.gr} % · Nasdaq ${r.nr} % · stop ${r.ds} % : choix ${pr(r.a).toFixed(0)} % / ${pr(r.a1).toFixed(0)} % → vérif ${pr(r.b).toFixed(0)} % / ${pr(r.b1).toFixed(0)} %`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
