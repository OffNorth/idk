#!/usr/bin/env node
/**
 * Audit de toutes les stratégies actives (or et Nasdaq) avec la règle stricte des 3 périodes :
 * une stratégie doit être positive (somme des trades, frais inclus) sur CHACUNE des 3 périodes où elle a au moins 5 trades,
 * et en avoir au moins 2 avec 5 trades ou plus ; sinon « données insuffisantes ».
 *
 *   Nasdaq journalier : ^NDX 1985–1999 · 2000–2009 · 2010–2026 (frais 0,003 % + financement 6 %/an)
 *   Or journalier     : GC=F 2000–2008 · 2009–2016 · 2017–2026 (frais 0,05 %)
 *   Or 5 / 15 min     : PAXG 2020–2026 en 3 tranches de 2 ans (frais 0,005 %, CFD)
 *   Nasdaq 5 / 15 min : QQQ 2024–2026 (Polygon) en 3 tranches de 8 mois (frais 0,003 % + financement la nuit)
 *
 *   npm run audit
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { computeIntraday } = require('./src/intraday');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const thirds = (c) => { const a = c[0].t; const b = c[c.length - 1].t; return [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity]; };
const lab = (t) => new Date(t * 1000).toISOString().slice(0, 7);

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const vix = await y('^VIX');
  const nd = await y('^NDX');
  const gc = await y('GC=F');
  const nasAux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: nasAux.tnx, dxy: nasAux.dxy, silver: await y('SI=F'), peer: nd };
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  let q5 = null;
  try { q5 = aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18'), 300, 60); } catch { /* sans clé */ }

  const DATA = {
    'nas100:1d': { c: nd, cuts: [0, Y(2000), Y(2010), Infinity], fee: 0.003, fin: 6, ind: computeAll(nd, nd, 86400, null, vix, nasAux), aux: nasAux },
    'gold:1d': { c: gc, cuts: [0, Y(2009), Y(2017), Infinity], fee: 0.05, fin: 0, ind: computeAll(gc, gc, 86400, null, vix, goldAux), aux: goldAux },
    'gold:5m': { c: g5, cuts: thirds(g5), fee: 0.005, fin: 0 },
    'gold:15m': { c: aggregate(g5, 900, 300), fee: 0.005, fin: 0 },
    ...(q5 ? { 'nas100:5m': { c: q5, cuts: thirds(q5), fee: 0.003, fin: 6 }, 'nas100:15m': { c: aggregate(q5, 900, 300), fee: 0.003, fin: 6 } } : {}),
  };
  DATA['gold:15m'].cuts = thirds(DATA['gold:15m'].c);
  if (DATA['nas100:15m']) DATA['nas100:15m'].cuts = thirds(DATA['nas100:15m'].c);

  const verdicts = { gold: {}, nas100: {} };
  for (const [market, ids] of [['nas100', cfg.nasStrategies], ['gold', cfg.goldStrategies]]) {
    console.log(`\n=== ${market === 'gold' ? 'Or' : 'Nasdaq 100'} : ${ids.length - 1} stratégies actives ===`);
    for (const s of selectStrategies(ids)) {
      if (s.id === 'hold') continue;
      const tf = tfOf(s);
      const d = DATA[`${market}:${tf}`];
      if (!d) { console.log(`  ?  ${s.id.padEnd(16)} pas de données ${tf}`); verdicts[market][s.id] = 'données'; continue; }
      const ind = s.compute ? s.compute(d.c, TF_SEC[tf], market) : s.intraday ? computeIntraday(d.c, TF_SEC[tf]) : d.ind;
      const r = backtest(s, d.c, { size: 1000, feePct: d.fee, financingPct: d.fin, barSec: TF_SEC[tf], ind, daily: tf === '1d' ? d.c : null, vix, aux: d.aux || {}, market });
      const parts = [0, 1, 2].map((k) => {
        const l = r.list.filter((t) => t.entryT >= d.cuts[k] && t.entryT < d.cuts[k + 1]);
        return { n: l.length, sum: l.reduce((a, t) => a + t.pnlPct, 0) };
      });
      const enough = parts.filter((p) => p.n >= 5).length >= 2;
      const pass = enough && parts.every((p) => p.n < 5 || p.sum > 0);
      const v = !enough ? 'données' : pass ? 'ok' : 'échec';
      verdicts[market][s.id] = v;
      const per = parts.map((p, k) => `${k === 0 ? (tf === '1d' ? '' : `${lab(d.c[0].t)}→`) : ''}${p.n ? `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(0)} % (${p.n})` : '—'}`).join(' · ');
      console.log(`  ${v === 'ok' ? '✔ ' : v === 'échec' ? '✘ ' : '? '} ${s.id.padEnd(16)} ${tf.padEnd(4)} ${per}`);
    }
  }
  const fails = Object.entries(verdicts).flatMap(([m, v]) => Object.entries(v).filter(([, x]) => x === 'échec').map(([id]) => `${m}:${id}`));
  const thin = Object.entries(verdicts).flatMap(([m, v]) => Object.entries(v).filter(([, x]) => x === 'données').map(([id]) => `${m}:${id}`));
  console.log(`\nÉchecs (perdantes sur au moins une période) : ${fails.join(', ') || 'aucun'}`);
  console.log(`Données insuffisantes : ${thin.join(', ') || 'aucune'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
