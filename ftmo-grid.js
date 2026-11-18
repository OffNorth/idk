#!/usr/bin/env node
/**
 * Nouvelles stratégies pour réussir le FTMO : les ~100 variantes de scalps or du test en masse (RSI, IBS, Bollinger,
 * Williams %R, Keltner ; 5 et 15 min ; dans la tendance 1 h ; stop 1,5 ATR) sont essayées UNE PAR UNE en plus du compte
 * FTMO actuel (or + Nasdaq), puis ajoutées de façon gloutonne (3 au plus).
 * Choix sur sept. 2020 → oct. 2024, vérification sur les 2 dernières années. Réussite = les 2 étapes en moins de 6 mois.
 *
 *   npm run ftmo-grid
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, TF_SEC } = require('./src/strategies');
const { computeAll, rsi, ema } = require('./src/indicators');
const { computeScalp2, helpers } = require('./src/scalp2');
const { challengeStats } = require('./src/ftmo');

const { active, flat, trendUp, trendDown } = helpers;
const CACHE = path.join(__dirname, 'data', 'research');
const strip = (l) => l.map((x) => x.split(':').slice(1).join(':'));

/** Variantes de retour à la moyenne dans la tendance 1 h (mêmes familles que gold-scalp-grid.js). */
function variants(x) {
  const cl = x.closes;
  const R = {};
  const rs = (k) => (R[k] ||= rsi(cl, k));
  const m20 = x.bb.mid;
  const sd = cl.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += (cl[j] - m20[i]) ** 2; return Math.sqrt(s / 20); });
  const e20 = ema(cl, 20);
  const V = [];
  const add = (name, buy, sell, exitL, exitS) => V.push({ name, buy, sell, exitL, exitS });
  for (const k of [2, 3, 4]) for (const lo of [3, 5, 10, 15]) for (const ex of [50, 60, 70])
    add(`RSI ${k} < ${lo} sortie ${ex}`, (i) => rs(k)[i] < lo, (i) => rs(k)[i] > 100 - lo, (i) => rs(k)[i] > ex, (i) => rs(k)[i] < 100 - ex);
  for (const lo of [0.1, 0.15, 0.2]) for (const ex of ['ibs', 'haut'])
    add(`IBS < ${lo} sortie ${ex}`, (i) => x.ibs[i] < lo && cl[i] < e20[i], (i) => x.ibs[i] > 1 - lo && cl[i] > e20[i],
      (i) => (ex === 'ibs' ? x.ibs[i] > 0.7 : cl[i] > x.candles[i - 1].h), (i) => (ex === 'ibs' ? x.ibs[i] < 0.3 : cl[i] < x.candles[i - 1].l));
  for (const z of [1.5, 2, 2.5, 3])
    add(`Bollinger ${z} σ`, (i) => sd[i] && cl[i] < m20[i] - z * sd[i], (i) => sd[i] && cl[i] > m20[i] + z * sd[i], (i) => cl[i] >= m20[i], (i) => cl[i] <= m20[i]);
  for (const w of [-90, -95, -98]) for (const ex of [-50, -30])
    add(`Williams ${w} sortie ${ex}`, (i) => x.wr10[i] !== null && x.wr10[i] < w, (i) => x.wr10[i] !== null && x.wr10[i] > -100 - w, (i) => x.wr10[i] > ex, (i) => x.wr10[i] < -100 - ex);
  for (const k of [1.5, 2, 2.5, 3])
    add(`Keltner ${k} ATR`, (i) => cl[i] < e20[i] - k * x.atr[i], (i) => cl[i] > e20[i] + k * x.atr[i], (i) => cl[i] >= e20[i], (i) => cl[i] <= e20[i]);
  return V;
}

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const vix = await y('^VIX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: await y('GC=F') };
  const nind = computeAll(nd, nd, 86400, null, vix, aux);
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const G = { '5m': { c: g5, sec: 300 }, '15m': { c: aggregate(g5, 900, 300), sec: 900 } };
  const t0 = g5[0].t + 30 * 86400;
  const SPLIT = g5[g5.length - 1].t - 2 * 365 * 86400;
  const GR = cfg.ftmoRisk;

  const base = [];
  for (const s of selectStrategies(strip(cfg.ftmoStrategies))) {
    const tf = tfOf(s);
    base.push(...backtest(s, G[tf].c, { size: 1000, feePct: 0.005, barSec: G[tf].sec, market: 'gold' }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: GR })));
  }
  for (const s of selectStrategies(strip(cfg.ftmoNasStrategies))) {
    base.push(...backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: nind, daily: nd, vix, aux, market: 'nas100' }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: cfg.ftmoComboNasRisk })));
  }

  const T = {};
  for (const [tf, d] of Object.entries(G)) {
    const x = computeScalp2(d.c, d.sec, 'gold');
    for (const v of variants(x)) {
      const strat = {
        id: 'grid', tf, warmup: 700,
        evaluate(ind, i) {
          const out = { entry: null, exitLong: flat(x, i) || v.exitL(i), exitShort: flat(x, i) || v.exitS(i), sl: 1.5 * x.atr[i], tp: null };
          if (!active(x, i)) return out;
          if (trendUp(x, i) && v.buy(i)) return { ...out, entry: 'long' };
          if (trendDown(x, i) && v.sell(i)) return { ...out, entry: 'short' };
          return out;
        },
      };
      T[`${v.name} @${tf}`] = backtest(strat, d.c, { size: 1000, feePct: 0.005, barSec: d.sec, ind: x }).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, riskPct: GR }));
    }
  }

  const st = (list, part) => challengeStats(part === 'choix' ? list.filter((t) => t.entryT < SPLIT) : list.filter((t) => t.entryT >= SPLIT),
    { riskPct: 1, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, ...(part === 'choix' ? { end: SPLIT } : { start: SPLIT }) });
  const pr = (c) => (c ? c.passRate : 0);
  const both = (list) => { const a = st(list, 'choix'); const b = st(list, 'verif'); return { a: pr(a), b: pr(b), da: a?.medianDays, db: b?.medianDays }; };
  const f = (r) => `choix ${r.a.toFixed(0).padStart(3)} % (${r.da?.toFixed(0) ?? '—'} j) · vérif ${r.b.toFixed(0).padStart(3)} % (${r.db?.toFixed(0) ?? '—'} j)`;

  const b0 = both(base);
  console.log(`=== ${Object.keys(T).length} variantes de scalps or ajoutées au compte FTMO actuel · choix → ${new Date(SPLIT * 1000).toISOString().slice(0, 7)}, vérification ensuite ===\n`);
  console.log(`Actuel : ${f(b0)}\n`);
  const one = Object.entries(T).map(([k, l]) => ({ k, ...both([...base, ...l]) })).sort((p, q) => q.a - p.a || q.b - p.b);
  console.log('Les 20 meilleures ajoutées seules (classées sur la période de choix) :');
  for (const r of one.slice(0, 20)) console.log(`  ${r.k.padEnd(30)} ${f(r)}`);
  const better = one.filter((r) => r.a > b0.a);
  console.log(`\n${better.length} variantes améliorent la période de choix ; parmi elles, ${better.filter((r) => r.b > b0.b).length} améliorent aussi la vérification, ${better.filter((r) => r.b < b0.b).length} la dégradent.`);

  let port = [...base];
  let cur = b0.a;
  const added = [];
  for (let step = 0; step < 3; step++) {
    let pick = null;
    for (const r of one.slice(0, 30)) {
      if (added.includes(r.k)) continue;
      const v = pr(st([...port, ...T[r.k]], 'choix'));
      if (v > cur + 0.5 && (!pick || v > pick.v)) pick = { k: r.k, v };
    }
    if (!pick) break;
    added.push(pick.k);
    port = [...port, ...T[pick.k]];
    cur = pick.v;
  }
  console.log(`\nAjout glouton (choix) : ${added.join(' + ') || 'aucun'}`);
  console.log(`  → ${f(both(port))}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
