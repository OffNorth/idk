#!/usr/bin/env node
/**
 * Banc d'essai des stratégies tirées de la littérature (src/research2.js) :
 *   A. variantes, règle des 3 tranches (or : PAXG 5 min sept. 2020 → aujourd'hui ; Nasdaq : QQQ 1 min Polygon 2 ans)
 *   B. effet sur le compte FTMO unique or + Nasdaq (réussite des 2 étapes en moins de 6 mois) :
 *      or → choix sept. 2020 → oct. 2024, vérification sur les 2 dernières années ;
 *      Nasdaq intraday (2 ans de données seulement) → vérification uniquement.
 * Frais : or 0,005 % par côté + swap 4 %/an pour les nuits (CFD) ; Nasdaq 0,003 % + 6 %/an.
 *
 *   npm run ftmo-papers
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');
const { night, noise, orbDir } = require('./src/research2');

const CACHE = path.join(__dirname, 'data', 'research');
const strip = (l) => l.map((x) => x.split(':').slice(1).join(':'));
const hm = (m) => `${Math.floor(m / 60)} h${m % 60 ? m % 60 : ''}`;

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const vix = await y('^VIX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: await y('GC=F') };
  const nind = computeAll(nd, nd, 86400, null, vix, aux);
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const q5 = aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18'), 300, 60);
  const D = { gold: { c: g5, fee: 0.005, fin: 4 }, nas100: { c: q5, fee: 0.003, fin: 6 } };
  const t0 = g5[0].t + 30 * 86400;
  const SPLIT = g5[g5.length - 1].t - 2 * 365 * 86400;

  // A. Variantes
  const V = [];
  for (const entry of [20 * 60, 21 * 60, 22 * 60]) for (const exit of [6 * 60, 7 * 60, 8 * 60, 13 * 60 + 30]) for (const trend of [false, true])
    V.push({ m: 'gold', label: `nuit ${hm(entry)} → ${hm(exit)}${trend ? ', tendance 1 h' : ''}`, s: night({ id: 'v', entry, exit, trend }) });
  for (const every of [30, 60]) for (const look of [10, 14]) {
    V.push({ m: 'nas100', label: `zone de bruit ${look} j, contrôle ${every} min`, s: noise({ id: 'v', market: 'nas100', look, every }) });
    V.push({ m: 'gold', label: `zone de bruit ${look} j, contrôle ${every} min (7 h–20 h UTC)`, s: noise({ id: 'v', market: 'gold', look, every }) });
  }
  for (const rr of [2, 5, 10]) for (const m of ['nas100', 'gold']) V.push({ m, label: `1re bougie 5 min, objectif ${rr} R`, s: orbDir({ id: 'v', market: m, rr }) });

  const thirds = (c) => { const a = c[0].t; const b = c[c.length - 1].t; return [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity]; };
  console.log('=== A. Variantes (gain net cumulé % par tranche, trades, trades / jour) ===\n');
  const rows = [];
  for (const v of V) {
    const d = D[v.m];
    const ind = v.s.compute(d.c, 300, v.m);
    const r = backtest(v.s, d.c, { size: 1000, feePct: d.fee, financingPct: d.fin, barSec: 300, ind, market: v.m });
    const cuts = thirds(d.c);
    const parts = [0, 1, 2].map((k) => { const l = r.list.filter((t) => t.entryT >= cuts[k] && t.entryT < cuts[k + 1]); return { n: l.length, sum: l.reduce((s, t) => s + t.pnlPct, 0) }; });
    const ok = parts.every((p) => p.n < 5 || p.sum > 0) && parts.filter((p) => p.n >= 5).length >= 2;
    const days = ((d.c[d.c.length - 1].t - d.c[0].t) / 86400) * (252 / 365);
    rows.push({ ...v, parts, ok, list: r.list });
    console.log(`  ${ok ? '✔' : '✘'} [${v.m === 'gold' ? 'or' : 'NAS'}] ${v.label.padEnd(46)} ${parts.map((p) => `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(1)} %`).join(' · ')} · ${r.list.length} · ${(r.list.length / days).toFixed(2)}/j`);
  }

  // B. Effet sur le compte FTMO unique
  const base = [];
  for (const s of selectStrategies(strip(cfg.ftmoStrategies))) {
    const tf = tfOf(s);
    const c = tf === '15m' ? aggregate(g5, 900, 300) : g5;
    base.push(...backtest(s, c, { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.map((t) => ({ ...t, riskPct: cfg.ftmoRisk })));
  }
  for (const s of selectStrategies(strip(cfg.ftmoNasStrategies)))
    base.push(...backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.map((t) => ({ ...t, riskPct: cfg.ftmoComboNasRisk })));
  const B = base.filter((t) => t.entryT >= t0);
  const st = (list, part) => challengeStats(part === 'choix' ? list.filter((t) => t.entryT < SPLIT) : list.filter((t) => t.entryT >= SPLIT),
    { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  const f = (list) => { const a = st(list, 'choix'); const b = st(list, 'verif'); return `choix ${a ? a.passRate.toFixed(0) : '—'} % (${a?.medianDays?.toFixed(0) ?? '—'} j) · vérif ${b ? b.passRate.toFixed(0) : '—'} % (${b?.medianDays?.toFixed(0) ?? '—'} j)`; };
  console.log(`\n=== B. Compte FTMO unique, réussite < 6 mois (choix → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)}, vérification ensuite) ===\n`);
  console.log(`  Actuel ${''.padEnd(52)} ${f(B)}`);
  for (const r of rows.filter((x) => x.ok)) for (const risk of [0.25, 0.5]) {
    const add = r.list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: risk }));
    console.log(`  + [${r.m === 'gold' ? 'or' : 'NAS'}] ${r.label.padEnd(44)} ${risk} % : ${f([...B, ...add])}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
