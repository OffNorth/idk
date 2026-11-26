#!/usr/bin/env node
/**
 * 4e recherche Lucid (npm run lucid-research4) : améliorer ce que Lucid trade déjà plutôt qu'empiler de nouvelles
 * familles (cassures, Crabel, Williams, VWAP, profil de volume, Gao, journée de tendance, écart comblé : déjà testés).
 *   1. Gestion de la sortie des stratégies intraday Lucid actuelles (Nasdaq QQQ, argent SLV, Dow DIA ; séance seule) :
 *      stop remonté au prix d'entrée (« break-even ») après +0,3 / +0,5 R, avec l'objectif actuel ou un objectif à 1 R.
 *   2. Filtres simples appliqués à TOUTES les stratégies intraday Lucid : pas le lundi, pas le vendredi, veille plus
 *      large / plus étroite que la médiane des 20 séances, écart d'ouverture < 0,5 %.
 *   3. Stratégies journalières de plus sur des micro-futures CME (argent SIL, Dow MYM, Russell M2K, S&P MES,
 *      Nasdaq MNQ, or MGC), une par une (journalier depuis 2009).
 * Sélection : avantage > +0,02 R les deux années (intraday), puis évaluation Lucid 50K : réussite < 1 an et délai médian
 * sur 2009–19 | 2020–26 | nov. 24–26 ; gardée seulement si la réussite ne baisse sur aucune période.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { cachedYahoo } = require('./src/yahoo');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { withTz } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

// Break-even : stop au prix d'entrée dès que le cours (clôture) a fait +k R ; objectif tp (× risque) si donné
function withBE(s, k, tp = null, id = `${s.id}_be${String(k).replace('.', '')}${tp ? `_t${String(tp).replace('.', '')}` : ''}`) {
  return {
    ...s, id,
    evaluate: (x, i) => { const r = s.evaluate(x, i); return tp && r.entry && r.sl > 0 ? { ...r, tp: tp * r.sl } : r; },
    trail(pos, ind, i) {
      const prev = s.trail ? s.trail(pos, ind, i) : NaN;
      const r0 = Math.abs(pos.entry - pos.initSl);
      const fav = pos.side === 'long' ? pos.best - pos.entry : pos.entry - pos.best;
      const be = fav >= k * r0 ? pos.entry : NaN;
      if (!Number.isFinite(be)) return prev;
      if (!Number.isFinite(prev)) return be;
      return pos.side === 'long' ? Math.max(prev, be) : Math.min(prev, be);
    },
  };
}

// Filtres de jour (sur les bougies de la séance seule, heure de New York)
function dayInfo(c) {
  const x = withTz({ candles: c, closes: c.map((k) => k.c) });
  const days = new Map(); // jour NY → { o, h, l, c, wd }
  for (let i = 0; i < c.length; i++) {
    const d = x.tz.ny.day[i];
    const e = days.get(d);
    if (!e) days.set(d, { o: c[i].o, h: c[i].h, l: c[i].l, c: c[i].c, wd: new Date(d * 86400 * 1000).getUTCDay() });
    else { e.h = Math.max(e.h, c[i].h); e.l = Math.min(e.l, c[i].l); e.c = c[i].c; }
  }
  const keys = [...days.keys()].sort((a, b) => a - b);
  const info = new Map();
  keys.forEach((d, k) => {
    const prev = days.get(keys[k - 1]);
    const ranges = keys.slice(Math.max(0, k - 21), k - 1).map((q) => days.get(q).h - days.get(q).l).sort((a, b) => a - b);
    const med = ranges.length ? ranges[Math.floor(ranges.length / 2)] : null;
    info.set(d, { wd: days.get(d).wd, wide: prev && med !== null ? prev.h - prev.l > med : null, gap: prev ? Math.abs(days.get(d).o / prev.c - 1) * 100 : null });
  });
  return { info };
}
const nyOff = (t) => require('./src/scalp2').nyOffset(t);
const FILTERS = {
  'pas le lundi': (d) => d.wd !== 1,
  'pas le vendredi': (d) => d.wd !== 5,
  'veille large': (d) => d.wide === true,
  'veille étroite': (d) => d.wide === false,
  'écart < 0,5 %': (d) => d.gap !== null && d.gap < 0.5,
};

(async () => {
  // Données intraday (séance seule) : Nasdaq (QQQ 1 min → 5 min, comme le reste du bot), argent, Dow
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const slv = nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity }));
  const dia = nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity }));
  const BARS = { nas100: { c: qs, mult: 82, fee: 2.5 }, silver: { c: slv, mult: 1075, fee: 3.5 }, dow: { c: dia, mult: 50, fee: 2.5 } };
  const DI = Object.fromEntries(Object.entries(BARS).map(([m, b]) => [m, dayInfo(b.c)]));
  const t0 = qs[0].t + 30 * 86400; const t1 = qs[qs.length - 1].t; const mid = (t0 + t1) / 2;

  const run = (sid, s) => {
    const m = sid.split(':')[0]; const B = BARS[m];
    const st = { ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') };
    return backtest(st, B.c, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * B.mult, contractFee: B.fee }));
  };
  const halves = (l) => [rStats(l.filter((t) => t.entryT >= t0 && t.entryT < mid)), rStats(l.filter((t) => t.entryT >= mid))];
  const LIS = cfg.lucidIntradayStrategies;
  const cur = Object.fromEntries(LIS.map((sid) => [sid, run(sid, selectStrategies([sid.split(':')[1]])[0])]));

  // Comptes
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const sizer = RULES[cfg.ftmoSizing];
  const A0 = q5[0].t + 30 * 86400;
  const P = { B: [Y(2009) + 60 * 86400, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const RL = { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop };
  const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true, lucidSplit: false }, 'lucid');
  const dailyBase = all.filter((t) => !t.intraday && A.strategies.includes(t.sid) && A.riskOf(...strat(t.sid)) > 0).map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  const goldIntra = all.filter((t) => t.intraday && t.market === 'gold' && A.strategies.includes(t.sid) && A.riskOf(...strat(t.sid)) > 0).map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  const ir = cfg.lucidIntradayRisk; const dr = cfg.ftmoRisk * cfg.lucidRiskMul;
  const evalL = (intra, extraDaily = []) => {
    const list = [...dailyBase, ...goldIntra, ...Object.values(intra).flat().map((t) => ({ ...t, riskPct: ir })), ...extraDaily.map((t) => ({ ...t, riskPct: dr }))];
    return Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      const c = challengeStats(l, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...RL });
      return { pass: c.passRate, days: c.medianDays };
    });
  };
  const fmt = (r) => r.map((p) => `${p.pass.toFixed(0).padStart(3)} % (${p.days ? p.days.toFixed(0) : '—'} j)`).join(' | ');
  const notWorse = (r, ref) => r.every((p, i) => p.pass >= ref[i].pass - 0.5);
  const better = (r, ref) => notWorse(r, ref) && (r.some((p, i) => p.pass > ref[i].pass + 0.5) || r[2].days < ref[2].days - 1);
  const ref = evalL(cur);
  console.log('Lucid, réussite < 1 an (délai médian) · 2009–19 | 2020–26 | nov. 24–26');
  console.log(`${'actuel'.padEnd(46)} ${fmt(ref)}`);

  // 1. Gestion de la sortie
  console.log('\n=== 1. Break-even (stop au prix d\'entrée après +k R) ===');
  const keep = {};
  for (const sid of LIS) {
    const s = selectStrategies([sid.split(':')[1]])[0];
    const [a0, b0] = halves(cur[sid]);
    let best = null;
    for (const [k, tp] of [[0.3, null], [0.5, null], [0.5, 1], [0.3, 1]]) {
      const l = run(sid, withBE(s, k, tp));
      const [a, b] = halves(l); const st = rStats(l.filter((t) => t.entryT >= t0));
      if (!(a.expR > 0.02 && b.expR > 0.02 && st.worstRun <= 8)) continue;
      if (!(a.expR + b.expR > a0.expR + b0.expR)) continue; // meilleure que l'actuelle sur les deux ans réunis
      const res = evalL({ ...cur, [sid]: l });
      const tag = `${sid} BE ${k} R${tp ? `, objectif ${tp} R` : ''}`;
      console.log(`${better(res, ref) ? '✅' : '  '} ${tag.padEnd(44)} ${sgn(a0.expR)} / ${sgn(b0.expR)} → ${sgn(a.expR)} / ${sgn(b.expR)} R · série ${st.worstRun} · ${fmt(res)}`);
      if (better(res, ref) && (!best || res[2].pass + res[0].pass + res[1].pass > best.score)) best = { l, tag, score: res[2].pass + res[0].pass + res[1].pass };
    }
    if (best) keep[sid] = best;
  }
  if (Object.keys(keep).length) {
    const mix = { ...cur }; for (const [sid, b] of Object.entries(keep)) mix[sid] = b.l;
    console.log(`→ toutes les ✅ retenues ensemble${''.padEnd(13)} ${fmt(evalL(mix))}`);
  }

  // 2. Filtres sur toutes les stratégies intraday Lucid
  console.log('\n=== 2. Filtres (toutes les stratégies intraday Lucid) ===');
  for (const [name, f] of Object.entries(FILTERS)) {
    const filt = Object.fromEntries(Object.entries(cur).map(([sid, l]) => {
      const m = sid.split(':')[0]; const { info } = DI[m];
      return [sid, l.filter((t) => { const d = info.get(Math.floor((t.entryT - nyOff(t.entryT) * 60) / 86400)); return d && f(d); })];
    }));
    const allL = Object.values(filt).flat(); const allC = Object.values(cur).flat();
    const [a, b] = halves(allL); const [a0, b0] = halves(allC);
    const res = evalL(filt);
    console.log(`${better(res, ref) ? '✅' : '  '} ${name.padEnd(44)} ${sgn(a0.expR)} / ${sgn(b0.expR)} → ${sgn(a.expR)} / ${sgn(b.expR)} R · ${allL.length}/${allC.length} trades · ${fmt(res)}`);
  }

  // 3. Journalières sur micro-futures
  console.log('\n=== 3. Journalières de plus (micro-futures CME) ===');
  const vix = (await cachedYahoo(CACHE, '^VIX', '1d', {}, 72)).filter((k) => k.c > 0);
  // (+ petits contrats de la liste Lucid : pétrole MCL, maïs ZC 5 000 boisseaux — prix Yahoo en cents —, porcs HE 40 000 livres)
  const MK = { silver: ['SI=F', 1000, 3.5], dow: ['^DJI', 0.5, 2.5], russell: ['^RUT', 5, 2.5], spx: ['^GSPC', 5, 4], nas100: ['^NDX', 2, 2.5], gold: ['GC=F', 10, 3.5],
    oil: ['CL=F', 100, 3], corn: ['ZC=F', 50, 31], hogs: ['HE=F', 400, 26] };
  const have = new Set(dailyBase.map((t) => t.sid));
  const dailyOk = [];
  for (const [m, [sym, mult, fee]] of Object.entries(MK)) {
    const d = (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0);
    const ind = computeAll(d, d, 86400, null, vix, {});
    for (const id of ['rsi2', 'ibs', 'down3', 'double7', 'cumrsi', 'n_low10', 'dip5']) {
      if (have.has(`${m}:${id}`)) continue;
      const s = selectStrategies([id])[0]; if (!s) continue;
      const l = backtest(s, d, { size: 1000, feePct: 0.01, financingPct: 5, barSec: 86400, ind, daily: d, vix }).list
        .map((t) => ({ ...t, sid: `${m}:${id}`, market: m, intraday: false, contractUsd: t.entry * mult, contractFee: fee }));
      const per = [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]].map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
      if (!per.every((p) => p.expR > 0.02 && p.n >= 15)) continue;
      const res = evalL(cur, l);
      console.log(`${better(res, ref) ? '✅' : '  '} ${`${m}:${id}`.padEnd(44)} ${per.map((p) => sgn(p.expR)).join(' / ')} R · ${fmt(res)}`);
      if (better(res, ref)) dailyOk.push({ sid: `${m}:${id}`, l, score: res.reduce((a, p) => a + p.pass, 0) });
    }
  }

  // 4. Ensemble : break-even retenus + journalières ✅ ajoutées une à une (meilleure d'abord), gardées si mieux
  console.log('\n=== 4. Ensemble (ajout une à une, gardée si la réussite ne baisse nulle part et monte ou va plus vite) ===');
  const base4 = { ...cur }; for (const [sid, b] of Object.entries(keep)) base4[sid] = b.l;
  let acc = []; let accRes = evalL(base4);
  console.log(`${'break-even retenus'.padEnd(46)} ${fmt(accRes)}`);
  for (const c of dailyOk.sort((a, b) => b.score - a.score)) {
    const res = evalL(base4, [...acc, ...c.l]);
    const ok = better(res, accRes);
    console.log(`${ok ? '✅' : '  '} + ${c.sid.padEnd(42)} ${fmt(res)}`);
    if (ok) { acc = [...acc, ...c.l]; accRes = res; }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
