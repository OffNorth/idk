#!/usr/bin/env node
/**
 * De nouveaux marchés pour le compte FTMO : les stratégies journalières déjà codées (retours à la moyenne « à la
 * Connors », tendance) appliquées au S&P 500, au Dow, au DAX, à l'argent, au pétrole et à l'EUR/USD (tous tradables
 * en CFD sur le même compte FTMO).
 *   1. Règle stricte des 3 périodes (achat seul, frais CFD par marché), depuis 1990 (ou le début des données).
 *   2. Pour celles qui passent : effet sur le compte FTMO unique actuel (or + Nasdaq, levier dynamique compris),
 *      choix sept. 2020 → oct. 2024, vérification sur les 2 dernières années ; ajout glouton.
 *
 *   npm run ftmo-markets
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');
const { RULES } = require('./src/sizing');

const CACHE = path.join(__dirname, 'data', 'research');
const strip = (l) => l.map((x) => x.split(':').slice(1).join(':'));
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const MARKETS = [
  { id: 'spx', name: 'S&P 500', sym: '^GSPC', fee: 0.003, fin: 6 },
  { id: 'dow', name: 'Dow Jones', sym: '^DJI', fee: 0.003, fin: 6 },
  { id: 'dax', name: 'DAX', sym: '^GDAXI', fee: 0.005, fin: 5 },
  { id: 'silver', name: 'Argent', sym: 'SI=F', fee: 0.01, fin: 4 },
  { id: 'oil', name: 'Pétrole', sym: 'CL=F', fee: 0.01, fin: 4 },
  { id: 'eurusd', name: 'EUR/USD', sym: 'EURUSD=X', fee: 0.002, fin: 3 },
];
const IDS = ['rsi2', 'ibs', 'double7', 'down3', 'cumrsi', 'dip5', 'pctb', 'vixspike', 'tom', 'n_rsi4', 'n_low10', 'n_weekrev', 'n_drop', 'n_2down', 'golden', 'sma200', 'trendmix', 'mom12_1', 'ema_long'];

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

  // 1. Règle des 3 périodes
  console.log('=== 1. Stratégies journalières sur de nouveaux marchés (gain net cumulé % par période, trades) ===');
  const ok = [];
  for (const M of MARKETS) {
    const all = await y(M.sym);
    if (!all) { console.log(`\n${M.name} : pas de données`); continue; }
    const c = all.filter((k) => k.t >= Y(1990) && k.c > 0);
    const ind = computeAll(c, c, 86400, null, vix, aux);
    const a = c[0].t; const b = c[c.length - 1].t;
    const cuts = [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity];
    const lab = cuts.slice(0, 3).map((t) => new Date(t * 1000).getUTCFullYear());
    console.log(`\n${M.name} (${M.sym}, périodes ${lab.join(' · ')}) :`);
    for (const s of selectStrategies(IDS)) {
      if (tfOf(s) !== '1d') continue;
      let r;
      try { r = backtest(s, c, { size: 1000, feePct: M.fee, financingPct: M.fin, barSec: 86400, ind, daily: c, vix, aux, market: 'nas100' }); } catch { continue; }
      const parts = [0, 1, 2].map((k) => { const l = r.list.filter((t) => t.entryT >= cuts[k] && t.entryT < cuts[k + 1]); return { n: l.length, sum: l.reduce((x, t) => x + t.pnlPct, 0) }; });
      const pass = parts.filter((p) => p.n >= 5).length >= 2 && parts.every((p) => p.n < 5 || p.sum > 0);
      console.log(`  ${pass ? '✔' : '✘'} ${s.id.padEnd(10)} ${parts.map((p) => `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(0)} % (${p.n})`).join(' · ')}`);
      if (pass) ok.push({ key: `${M.id}:${s.id}`, list: r.list.filter((t) => t.entryT >= t0) });
    }
  }

  // 2. Effet sur le compte FTMO unique
  const base = [];
  for (const s of selectStrategies(strip(cfg.ftmoStrategies))) {
    const tf = tfOf(s);
    base.push(...backtest(s, G[tf], { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.map((t) => ({ ...t, riskPct: cfg.ftmoRisk })));
  }
  for (const s of selectStrategies(strip(cfg.ftmoNasStrategies)))
    base.push(...backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.map((t) => ({ ...t, riskPct: cfg.ftmoComboNasRisk })));
  const B = base.filter((t) => t.entryT >= t0);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const st = (list, part) => challengeStats(part === 'choix' ? list.filter((t) => t.entryT < SPLIT) : list.filter((t) => t.entryT >= SPLIT),
    { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, sizer, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  const pr = (c) => (c ? c.passRate : 0);
  const f = (list) => { const a = st(list, 'choix'); const b = st(list, 'verif'); return `choix ${pr(a).toFixed(0).padStart(3)} % (${a?.medianDays?.toFixed(0) ?? '—'} j, max ${a?.failedMax ?? '—'}) · vérif ${pr(b).toFixed(0).padStart(3)} % (${b?.medianDays?.toFixed(0) ?? '—'} j, max ${b?.failedMax ?? '—'})`; };

  console.log(`\n=== 2. Compte FTMO unique, réussite < 6 mois (choix → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)}, vérification ensuite) ===\n`);
  console.log(`  Actuel ${''.padEnd(26)} ${f(B)}`);
  const C = {};
  for (const o of ok) for (const risk of [0.5, 1]) C[`${o.key} @${risk} %`] = o.list.map((t) => ({ ...t, riskPct: risk }));
  for (const [k, l] of Object.entries(C)) console.log(`  + ${k.padEnd(30)} ${f([...B, ...l])}`);

  let port = [...B];
  let cur = pr(st(port, 'choix'));
  const added = [];
  for (let step = 0; step < 6; step++) {
    let pick = null;
    for (const [k, l] of Object.entries(C)) {
      if (added.some((a) => a.split(' @')[0] === k.split(' @')[0])) continue;
      const v = pr(st([...port, ...l], 'choix'));
      if (v > cur + 0.5 && (!pick || v > pick.v)) pick = { k, v };
    }
    if (!pick) break;
    added.push(pick.k);
    port = [...port, ...C[pick.k]];
    cur = pick.v;
  }
  console.log(`\nAjout glouton (choix) : ${added.join(', ') || 'aucun'}`);
  console.log(`  → ${f(port)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
