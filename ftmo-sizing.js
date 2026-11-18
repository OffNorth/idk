#!/usr/bin/env node
/**
 * Levier dynamique pour le compte FTMO unique or + Nasdaq : chaque règle de src/sizing.js ajuste le risque (donc le levier)
 * de chaque trade selon la volatilité, la forme récente de la stratégie ou l'état du compte. Comparaison avec le risque
 * fixe actuel. Choix sept. 2020 → oct. 2024, vérification sur les 2 dernières années ; réussite des 2 étapes < 6 mois.
 *
 *   npm run ftmo-sizing
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
    all.push(...backtest(s, G[tf], { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.map((t) => ({ ...t, sid: `gold:${s.id}`, riskPct: cfg.ftmoRisk })));
  }
  for (const s of selectStrategies(strip(cfg.ftmoNasStrategies)))
    all.push(...backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.map((t) => ({ ...t, sid: `nas100:${s.id}`, riskPct: cfg.ftmoComboNasRisk })));
  annotate(all);
  const T = all.filter((t) => t.entryT >= t0);

  const st = (part, opts) => challengeStats(part === 'choix' ? T.filter((t) => t.entryT < SPLIT) : T.filter((t) => t.entryT >= SPLIT),
    { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, ...opts, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  const f = (c) => (c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, échecs jour ${c.failedDaily} · max ${c.failedMax})` : '—');
  console.log(`=== Levier dynamique, compte FTMO unique · choix → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)} | vérification ensuite ===\n`);
  for (const [name, rule] of Object.entries(RULES)) {
    for (const base of [1, 1.25]) {
      const opts = { sizer: rule, riskMul: base };
      console.log(`  ${`${name}${base !== 1 ? ` (risque de base × ${base})` : ''}`.padEnd(52)} choix ${f(st('choix', opts))} | vérif ${f(st('verif', opts))}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
