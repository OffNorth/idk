#!/usr/bin/env node
/**
 * Recherche de stratégies et de règles de gestion qui augmentent la réussite du compte FTMO unique or + Nasdaq.
 *   1. Ajout glouton de stratégies au portefeuille actuel : choix sur sept. 2020 → nov. 2024, vérification sur les
 *      2 dernières années (jamais utilisées pour choisir).
 *        candidates or 5 / 15 min (risque or), or journalier (GC=F, risque 1 %), Nasdaq journalier (risque Nasdaq)
 *   2. Gestion du risque : risque réduit à l'étape 2 (objectif +5 % seulement), stop du jour maison.
 * Réussite = les 2 étapes en moins de 6 mois ; challenges lancés chaque semaine.
 *
 *   npm run ftmo-more
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
const GR = cfg.ftmoRisk;
const NR = cfg.ftmoComboNasRisk;
const CAND = {
  gold: ['m_wr@5m', 'g_ibsh@5m', 'g_asia', 'm_vwap', 'm_down3', 'x_lasthalf', 'x_rsi2@15m', 'm_bb@15m', 'm_keltner@15m', 'm_wr@15m', 'm_ibs@5m', 'm_rsi2x@5m'],
  goldDaily: ['g_low10', 'g_weekrev', 'g_oilfall', 'g_yieldfall', 'g_dollarfall', 'season', 'golden', 'trendmix', 'sma200', 'mom12', 'high52', 'rsi2', 'ibs', 'double7'],
  nas: ['n_weekrev', 'n_drop', 'n_2down', 'n_goldfall', 'n_rsspx', 'golden', 'mom12_1', 'trendmix', 'sma200', 'lowvol', 'rates', 'down3', 'dip5', 'double7', 'dualmom'],
};

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const gc = await y('GC=F');
  const vix = await y('^VIX');
  const nasAux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: nasAux.tnx, dxy: nasAux.dxy, silver: await y('SI=F'), oil: nasAux.oil, peer: nd };
  const nind = computeAll(nd, nd, 86400, null, vix, nasAux);
  const gind = computeAll(gc, gc, 86400, null, vix, goldAux);
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const G = { '5m': g5, '15m': aggregate(g5, 900, 300) };
  const t0 = g5[0].t + 30 * 86400;
  const SPLIT = g5[g5.length - 1].t - 2 * 365 * 86400;

  const T = {};
  const gold = (id, risk) => { const s = selectStrategies([id])[0]; if (!s) return; const tf = tfOf(s); if (!G[tf]) return; T[`or:${id}`] = backtest(s, G[tf], { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], market: 'gold' }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: risk })); };
  const goldD = (id, risk) => { const s = selectStrategies([id])[0]; if (!s || tfOf(s) !== '1d') return; T[`or1d:${id}`] = backtest(s, gc, { size: 1000, feePct: 0.005, barSec: 86400, ind: gind, daily: gc, vix, aux: goldAux, market: 'gold' }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: risk })); };
  const nas = (id, risk) => { const s = selectStrategies([id])[0]; if (!s || tfOf(s) !== '1d') return; T[`nas:${id}`] = backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux: nasAux, market: 'nas100' }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: risk })); };
  const base = [];
  for (const id of strip(cfg.ftmoStrategies)) { gold(id, GR); base.push(`or:${id}`); }
  for (const id of strip(cfg.ftmoNasStrategies)) { nas(id, NR); base.push(`nas:${id}`); }
  for (const id of CAND.gold) gold(id, GR);
  for (const id of CAND.goldDaily) goldD(id, 1);
  for (const id of CAND.nas) nas(id, NR);
  const cands = Object.keys(T).filter((k) => !base.includes(k) && T[k].length >= 5);

  const stats = (keys, part, opts = {}) => {
    const l = keys.flatMap((k) => T[k]);
    return challengeStats(part === 'choix' ? l.filter((t) => t.entryT < SPLIT) : l.filter((t) => t.entryT >= SPLIT), { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, ...opts, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  };
  const pr = (c) => (c ? c.passRate : 0);
  const fmt = (keys, opts) => { const a = stats(keys, 'choix', opts); const b = stats(keys, 'verif', opts); return `choix ${pr(a).toFixed(0)} % (${a?.medianDays?.toFixed(0) ?? '—'} j) · vérif ${pr(b).toFixed(0)} % (${b?.medianDays?.toFixed(0) ?? '—'} j)`; };

  console.log(`=== Compte FTMO unique, réussite < 6 mois · choix sept. 2020 → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)} · vérification ensuite ===\n`);
  console.log(`Actuel (${base.length} stratégies) : ${fmt(base)}\n`);
  console.log('Effet de chaque candidate ajoutée seule :');
  const one = cands.map((k) => ({ k, a: pr(stats([...base, k], 'choix')), b: pr(stats([...base, k], 'verif')) })).sort((p, q) => q.a - p.a);
  for (const r of one) console.log(`  ${r.k.padEnd(20)} choix ${r.a.toFixed(0).padStart(3)} % · vérif ${r.b.toFixed(0).padStart(3)} %`);

  // Glouton sur la période de choix
  let port = [...base];
  let cur = pr(stats(port, 'choix'));
  for (;;) {
    let pick = null;
    for (const k of cands) {
      if (port.includes(k)) continue;
      const v = pr(stats([...port, k], 'choix'));
      if (v > cur + 1 && (!pick || v > pick.v)) pick = { k, v };
    }
    if (!pick) break;
    port.push(pick.k);
    cur = pick.v;
  }
  const added = port.filter((k) => !base.includes(k));
  console.log(`\nAjout glouton (choix) : ${added.join(', ') || 'aucun'}`);
  console.log(`  → ${fmt(port)}`);

  console.log('\nGestion du risque (portefeuille actuel, puis portefeuille glouton) :');
  for (const ds of [1, 2, 3]) for (const p2 of [1, 0.75, 0.5]) {
    console.log(`  stop du jour −${ds} %, risque étape 2 × ${p2} : actuel ${fmt(base, { dayStopPct: ds, phase2Mul: p2 })} | glouton ${fmt(port, { dayStopPct: ds, phase2Mul: p2 })}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
