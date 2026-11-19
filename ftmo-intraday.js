#!/usr/bin/env node
/**
 * Compte FTMO avec stratégies intraday (≈ 5 trades par jour demandés) : trades par jour et réussite du challenge
 * (formule FTMO_PROGRAM), compte journalier seul contre compte journalier + intraday (risque FTMO_INTRADAY_RISK_PCT).
 *   A. nov. 2024 → nov. 2026 : tout (Nasdaq intraday QQQ Polygon, or intraday HistData, journalières Yahoo)
 *   B. 2009 → 2026 : sans le Nasdaq intraday (pas de données 1 min avant nov. 2024)
 *
 *   npm run ftmo-intraday
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');
const { programOf, accountOf } = require('./src/ftmoAccount');
const { annotate, RULES } = require('./src/sizing');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const vix = await y('^VIX');
  const gc = (await y('GC=F')).filter((k) => k.c > 0);
  const nd = await y('^NDX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: aux.tnx, dxy: aux.dxy, silver: await y('SI=F'), oil: aux.oil, peer: nd };
  const daily = {
    nas100: { c: nd, aux }, gold: { c: gc, aux: goldAux },
    eurusd: { c: (await y('EURUSD=X')).filter((k) => k.c > 0), aux }, spx: { c: (await y('^GSPC')).filter((k) => k.c > 0), aux },
  };
  for (const d of Object.values(daily)) d.ind = computeAll(d.c, d.c, 86400, null, vix, d.aux);
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  let q5 = null;
  try { q5 = aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18'), 300, 60); } catch { /* sans clé Polygon */ }
  const intra = { gold: { '5m': g5, '15m': aggregate(g5, 900, 300) }, nas100: q5 ? { '5m': q5, '15m': aggregate(q5, 900, 300) } : null };
  const FEE = { gold: [0.005, 4], nas100: [0.003, 6], eurusd: [0.002, 3], spx: [0.003, 6] };
  const A = accountOf(cfg, 'gold');

  const all = [];
  for (const k of A.strategies) {
    const [m, id] = k.split(':');
    const s = selectStrategies([id])[0];
    if (!s) continue;
    const tf = tfOf(s);
    const [fee, fin] = FEE[m];
    let r = null;
    if (tf === '1d') {
      const d = daily[m];
      r = backtest(s, d.c, { size: 1000, feePct: fee, financingPct: fin, barSec: 86400, ind: d.ind, daily: d.c, vix, aux: d.aux, market: m === 'gold' ? 'gold' : 'nas100' });
    } else if (intra[m]?.[tf]) {
      const c = intra[m][tf];
      r = backtest(s, c, { size: 1000, feePct: fee, financingPct: fin, barSec: TF_SEC[tf], ind: s.compute(c, TF_SEC[tf], m), market: m });
    }
    if (!r) { console.log(`  (pas de données pour ${k})`); continue; }
    all.push(...r.list.map((t) => ({ ...t, sid: k, market: m, intraday: tf !== '1d', riskPct: A.riskOf(m, s) })));
  }
  annotate(all);
  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay };
  const show = (label, a, b, filter = () => true) => {
    const l = all.filter((t) => t.entryT >= a && t.entryT < b && filter(t));
    const days = ((Math.min(b, Date.now() / 1000) - a) / 86400) * (252 / 365);
    const f = (list) => { const c6 = challengeStats(list, { ...opts, horizonDays: 180, start: a }); const c1 = challengeStats(list, { ...opts, horizonDays: 365, start: a }); return `${(list.length / days).toFixed(1)} trades / jour · réussite < 6 mois ${c6 ? c6.passRate.toFixed(0) : '—'} % · < 1 an ${c1 ? c1.passRate.toFixed(0) : '—'} % (${c1?.medianDays?.toFixed(0) ?? '—'} j)`; };
    console.log(`\n${label}`);
    console.log(`  journalières seules       ${f(l.filter((t) => !t.intraday))}`);
    console.log(`  journalières + intraday   ${f(l)}`);
  };
  console.log(`=== ${F.label} · intraday à ${cfg.ftmoIntradayRisk} %, journalières à ${cfg.ftmoRisk} % ===`);
  if (q5) show('A. nov. 2024 → nov. 2026 (toutes les stratégies)', q5[0].t + 30 * 86400, Infinity);
  show('B. 2009 → 2019 (sans Nasdaq intraday)', Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100'));
  show('B. 2020 → 2026 (sans Nasdaq intraday)', Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
