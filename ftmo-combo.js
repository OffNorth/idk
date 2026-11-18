#!/usr/bin/env node
/**
 * Objectif : RÉUSSIR une évaluation FTMO. Un seul compte qui trade l'or ET le Nasdaq (FTMO l'autorise) passe-t-il plus
 * souvent / plus vite que les deux comptes séparés ?
 *   Or     : scalps PAXG 5 / 15 min (sept. 2020 → aujourd'hui), frais 0,005 %
 *   Nasdaq : stratégies journalières ^NDX du compte FTMO Nasdaq, frais 0,003 % + swap 6 %/an
 * Chaque marché a son propre risque par trade. Challenges lancés chaque semaine ; réussite = les 2 étapes en moins de
 * 6 mois et en moins d'un an. « Récent » = départs des 2 dernières années.
 *
 *   npm run ftmo-combo
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');

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
  const recent = g5[g5.length - 1].t - 2 * 365 * 86400;

  const goldTrades = (ids) => selectStrategies(ids).flatMap((s) => {
    const tf = tfOf(s);
    return backtest(s, G[tf], { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.filter((t) => t.entryT >= t0);
  });
  const nasTrades = (ids) => selectStrategies(ids).flatMap((s) => backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.filter((t) => t.entryT >= t0));

  const GOLD = process.env.ONLY_CURRENT ? { actuel: strip(cfg.ftmoStrategies) } : { actuel: strip(cfg.ftmoStrategies), élargi: [...strip(cfg.ftmoStrategies), 'm_wr@5m', 'g_ibsh@5m'] };
  const nas = nasTrades(strip(cfg.ftmoNasStrategies));
  const run = (gold, gr, nr, horizonDays, from = null) => {
    const list = [...gold.map((t) => ({ ...t, riskPct: gr })), ...(nr ? nas.map((t) => ({ ...t, riskPct: nr })) : [])].filter((t) => gr || t.riskPct === nr);
    const c = challengeStats(from ? list.filter((t) => t.entryT >= from) : list, { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays });
    return c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)` : '—';
  };
  console.log('=== Réussite du challenge FTMO (2 étapes), compte unique or + Nasdaq, sept. 2020 → aujourd’hui ===');
  console.log('Réussite : en moins de 6 mois · en moins d’un an · récent < 6 mois (médiane des jours pour réussir)\n');
  for (const [gname, gids] of Object.entries(GOLD)) {
    const gold = goldTrades(gids);
    console.log(`Or ${gname} : ${gids.join(', ')}`);
    for (const gr of (process.env.GR || '0,0.5,0.75,1').split(',').map(Number)) for (const nr of (process.env.NR || '0,1,2,3').split(',').map(Number)) {
      if (!gr && !nr) continue;
      console.log(`  or ${String(gr).padEnd(4)} % · Nasdaq ${nr} % : ${run(gold, gr, nr, 180)} · ${run(gold, gr, nr, 365)} · récent ${run(gold, gr, nr, 180, recent)} · récent < 1 an ${run(gold, gr, nr, 365, recent)}`);
    }
    console.log('');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
