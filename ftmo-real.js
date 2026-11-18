#!/usr/bin/env node
/**
 * Recherche FTMO sur l'or RÉEL (au comptant, HistData XAU/USD 2009–2026 — un compte FTMO trade XAU/USD, pas PAXG),
 * avec le Nasdaq et l'EUR/USD journaliers. Formule FTMO_PROGRAM (1 étape par défaut).
 *   1. Candidates : scalps or 5 / 15 min (stratégies nommées + 112 variantes), or journalier (GC=F), Nasdaq journalier
 *      (^NDX), EUR/USD journalier ; une candidate doit être positive sur CHACUNE des périodes 2009–2012, 2013–2016,
 *      2017–2019 (frais compris).
 *   2. Ajout glouton au compte FTMO (réussite du challenge en moins d'un an, départs chaque semaine) sur 2009–2019,
 *      vérification sur 2020–2026 (jamais utilisée pour choisir).
 *
 *   npm run ftmo-real
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, withTf } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { computeScalp2 } = require('./src/scalp2');
const { variants, toStrategy } = require('./src/scalpgrid');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { annotate, RULES } = require('./src/sizing');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [['2009–2012', Y(2009), Y(2013)], ['2013–2016', Y(2013), Y(2017)], ['2017–2019', Y(2017), Y(2020)], ['2020–2026', Y(2020), Infinity]];
const SPLIT = Y(2020);
const RISK = { scalp: 0.35, gold: 0.5, nas100: 0.5, eurusd: 0.5 };
const GOLD_SCALPS = ['x_rsi2', 'm_bb@5m', 'm_ibs', 'm_rsi2x', 'm_keltner@5m', 'm_wr@5m', 'g_ibsh@5m', 'g_asia', 'm_down3', 'm_vwap', 'x_lasthalf', 'x_orb5', 'n_orb5s'];
const DAILY = ['rsi2', 'ibs', 'double7', 'down3', 'cumrsi', 'dip5', 'pctb', 'tom', 'n_rsi4', 'n_low10', 'n_weekrev', 'n_drop', 'n_2down', 'n_dollarfall', 'n_goldfall', 'n_rsspx', 'vixspike', 'golden', 'sma200', 'trendmix', 'mom12_1', 'mom12', 'ema_long', 'dualmom', 'lowvol', 'rates',
  'g_low10', 'g_weekrev', 'g_oilfall', 'g_yieldfall', 'g_dollarfall', 'season', 'high52'];

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const gc = (await y('GC=F')).filter((k) => k.c > 0);
  const eu = (await y('EURUSD=X')).filter((k) => k.c > 0);
  const vix = await y('^VIX');
  const nasAux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: nasAux.tnx, dxy: nasAux.dxy, silver: await y('SI=F'), oil: nasAux.oil, peer: nd };
  const D = {
    nas100: { c: nd, ind: computeAll(nd, nd, 86400, null, vix, nasAux), aux: nasAux, fee: 0.003, fin: 6 },
    gold: { c: gc, ind: computeAll(gc, gc, 86400, null, vix, goldAux), aux: goldAux, fee: 0.005, fin: 4 },
    eurusd: { c: eu, ind: computeAll(eu, eu, 86400, null, vix, nasAux), aux: nasAux, fee: 0.002, fin: 3 },
  };
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const G = { '5m': { c: g5, sec: 300 }, '15m': { c: aggregate(g5, 900, 300), sec: 900 } };
  const X = { '5m': computeScalp2(G['5m'].c, 300, 'gold'), '15m': computeScalp2(G['15m'].c, 900, 'gold') };
  const t0 = Y(2009) + 60 * 86400;
  const parts = (l) => P.map(([, a, b]) => { const k = l.filter((t) => t.entryT >= a && t.entryT < b); return { n: k.length, sum: k.reduce((s, t) => s + t.pnlPct, 0) }; });
  const okChoice = (p, minN) => p.slice(0, 3).every((x) => x.sum > 0 && x.n >= minN);

  const C = {};
  const add = (key, list, market, risk) => { C[key] = list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, sid: key, market, riskPct: risk })); };
  console.log(`=== 1. Candidates positives sur chacune des 3 périodes de choix (${P.slice(0, 3).map((p) => p[0]).join(' · ')}), puis 2020–2026 ===`);
  // Scalps or nommés (or au comptant)
  for (const id of GOLD_SCALPS) {
    const s0 = selectStrategies([id])[0];
    if (!s0) continue;
    const tf = tfOf(s0);
    if (!G[tf]) continue;
    const s = withTf(s0, tf);
    const r = backtest(s, G[tf].c, { size: 1000, feePct: 0.005, barSec: G[tf].sec, ind: s.compute ? s.compute(G[tf].c, G[tf].sec, 'gold') : X[tf], market: 'gold' });
    const p = parts(r.list);
    if (okChoice(p, 100)) { add(`or:${id}`, r.list, 'gold', RISK.scalp); console.log(`  ✔ or ${id.padEnd(14)} ${p.map((x) => `${x.sum.toFixed(0)} %`).join(' · ')}`); }
  }
  // Variantes de scalps
  let nv = 0;
  for (const tf of ['5m', '15m']) for (const v of variants(X[tf])) {
    const r = backtest(toStrategy(X[tf], v, tf), G[tf].c, { size: 1000, feePct: 0.005, barSec: G[tf].sec, ind: X[tf] });
    const p = parts(r.list);
    if (okChoice(p, 100)) { nv++; add(`or:${v.name} @${tf}`, r.list, 'gold', RISK.scalp); console.log(`  ✔ or ${`${v.name} @${tf}`.padEnd(30)} ${p.map((x) => `${x.sum.toFixed(0)} %`).join(' · ')}`); }
  }
  // Journalières
  for (const [m, d] of Object.entries(D)) for (const s of selectStrategies(DAILY)) {
    if (tfOf(s) !== '1d') continue;
    let r;
    try { r = backtest(s, d.c, { size: 1000, feePct: d.fee, financingPct: d.fin, barSec: 86400, ind: d.ind, daily: d.c, vix, aux: d.aux, market: m === 'eurusd' ? 'nas100' : m }); } catch { continue; }
    const p = parts(r.list);
    if (okChoice(p, 3)) { add(`${m}:${s.id}`, r.list, m, RISK[m]); console.log(`  ✔ ${m.padEnd(6)} ${s.id.padEnd(12)} ${p.map((x) => `${x.sum.toFixed(0)} % (${x.n})`).join(' · ')}`); }
  }
  console.log(`  → ${Object.keys(C).length} candidates (dont ${nv} variantes de scalps)`);

  // 2. Glouton sur le challenge
  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay };
  for (const l of Object.values(C)) annotate(l);
  const st = (list, part, h) => challengeStats(part === 'choix' ? list.filter((t) => t.entryT < SPLIT) : list.filter((t) => t.entryT >= SPLIT),
    { ...opts, horizonDays: h, ...(part === 'choix' ? { start: t0, end: SPLIT } : { start: SPLIT }) });
  const pr = (c) => (c ? c.passRate : 0);
  const fmt = (list) => ['choix', 'verif'].map((part) => { const a = st(list, part, 180); const b = st(list, part, 365); return `${part === 'choix' ? 'choix' : 'vérif'} ${pr(a).toFixed(0)} % / ${pr(b).toFixed(0)} % (${b?.medianDays?.toFixed(0) ?? '—'} j)`; }).join(' | ');
  // Doublons (même logique sur le même marché, ex. g_low10 = n_low10 sur le Nasdaq) : on garde la première
  const seen = new Set();
  for (const [k, l] of Object.entries(C)) {
    const sig = `${l[0]?.market}:${l.map((t) => t.entryT).join(',')}`;
    if (seen.has(sig)) delete C[k];
    else seen.add(sig);
  }
  const scaled = (keys, mul) => keys.flatMap((k) => C[k].map((t) => ({ ...t, riskPct: t.riskPct * mul })));
  console.log(`\n=== 2. ${F.label} : toutes les candidates ensemble (${Object.keys(C).length}), risque × 1 à 6 ; « < 6 mois / < 1 an (médiane) » ===`);
  let all = Object.keys(C);
  let best = null;
  for (const mul of [1, 2, 3, 4, 6]) {
    const l = scaled(all, mul);
    const v = pr(st(l, 'choix', 365));
    console.log(`  risque × ${mul} : ${fmt(l)}`);
    if (!best || v > best.v + 0.5) best = { mul, v };
  }
  console.log(`\n  → risque × ${best.mul} retenu (meilleur sur 2009–2019). Retrait glouton des candidates qui gênent :`);
  let cur = best.v;
  for (;;) {
    let pick = null;
    for (const k of all) {
      const v = pr(st(scaled(all.filter((x) => x !== k), best.mul), 'choix', 365));
      if (v > cur + 0.5 && (!pick || v > pick.v)) pick = { k, v };
    }
    if (!pick) break;
    all = all.filter((x) => x !== pick.k);
    cur = pick.v;
    console.log(`  − ${pick.k.padEnd(34)} ${fmt(scaled(all, best.mul))}`);
  }
  console.log(`\nPortefeuille retenu (risque × ${best.mul}) : ${all.join(', ')}`);
  console.log(`  → ${fmt(scaled(all, best.mul))}`);
  console.log(`  risques : ${[...new Set(all.map((k) => `${C[k][0]?.market} ${(C[k][0]?.riskPct * best.mul).toFixed(2)} %`))].join(' · ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function strip(l) {
  return l.map((x) => x.split(':').slice(1).join(':'));
}
