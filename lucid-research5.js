#!/usr/bin/env node
/**
 * 5e recherche Lucid (npm run lucid-research5) — objectif : réussir l'évaluation en 2 semaines sans multiplier les échecs.
 *   A. Gestion de la journée (règles de compte) : limite de perte du jour, plafond de gain du jour (règle du meilleur
 *      jour ≤ 40 %), arrêt après N trades perdants, positions intraday simultanées.
 *   B. Signaux jamais testés sur les micros (séance de New York) : filtre de tendance (moyenne 20 jours) sur l'intraday
 *      Lucid, fin / début de mois (journalier, MES / MNQ / MYM / M2K), sortie partielle (½ à 0,5 R, ½ à 1,5 R avec
 *      stop au prix d'entrée), « gap and go » (écart d'ouverture > 0,3 % confirmé par la 1re bougie).
 * Mesures (compte Lucid actuel, risque intraday de l'évaluation) : réussite < 1 an 2009–19 | 2020–26 | nov. 24–26 ;
 * nov. 24–26 départ chaque jour ouvré : réussie ≤ 14 j / ≤ 30 j, échouée ≤ 14 j, évaluations achetées par compte financé.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, runPhase, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { cachedYahoo } = require('./src/yahoo');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { withTz, computeFor, withTp } = require('./src/sessions');
const { nyOffset } = require('./src/scalp2');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const nyDay = (t) => Math.floor((t - nyOffset(t) * 60) / DAY);

// Break-even + objectif (comme withBE de src/strategies.js)
const withBE = (s, k, tp, id) => ({
  ...s, id,
  evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 ? { ...r, tp: tp * r.sl } : r; },
  trail(pos) {
    const fav = pos.side === 'long' ? pos.best - pos.entry : pos.entry - pos.best;
    return fav >= k * Math.abs(pos.entry - pos.initSl) ? pos.entry : NaN;
  },
});
// « Gap and go » : 1re bougie 5 min (9 h 30) ; ouverture à plus de th % de la clôture de la veille et bougie dans le même
// sens → on suit à sa clôture ; stop à l'ouverture du jour (au moins 0,2 ATR) ; sortie 15 h 55
const gapGo = (th, tp, id) => ({
  id, name: id, tf: '5m', onlyTf: ['5m'], scalp: true, warmup: 300, markets: ['nas100'],
  compute: (c) => computeFor(c, 'nas100'),
  evaluate(x, i) {
    withTz(x);
    const m = x.tz.ny.min[i];
    const out = { entry: null, exitLong: m >= 955, exitShort: m >= 955, sl: 0, tp: null };
    if (m !== 570 || i < 1 || x.tz.ny.day[i - 1] === x.tz.ny.day[i]) return out;
    const c = x.candles; const prevC = c[i - 1].c; const o = c[i].o; const gap = (o / prevC - 1) * 100;
    const sl = Math.max(0.2 * x.atr[i], Math.abs(c[i].c - o));
    if (gap > th && c[i].c > o) return { ...out, entry: 'long', sl, tp: tp ? tp * sl : null };
    if (gap < -th && c[i].c < o) return { ...out, entry: 'short', sl, tp: tp ? tp * sl : null };
    return out;
  },
});

(async () => {
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const spy = nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const BARS = {
    nas100: { c: qs, mult: 82, fee: 2.5 }, spx: { c: spy, mult: 50, fee: 4 },
    silver: { c: nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity })), mult: 1075, fee: 3.5 },
    dow: { c: nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity })), mult: 50, fee: 2.5 },
    russell: { c: nySession(await polygonBars(CACHE, 'IWM', 5, '2024-11-18', { maxAgeH: Infinity })), mult: 50, fee: 2.5 },
  };
  const t0 = qs[0].t + 30 * DAY; const t1 = qs[qs.length - 1].t; const mid = (t0 + t1) / 2;
  const run = (m, s, sid) => {
    const B = BARS[m];
    return backtest({ ...s, compute: s.compute ? (c, sec) => s.compute(c, sec, 'nas100') : undefined }, B.c, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * B.mult, contractFee: B.fee }));
  };
  const halves = (l) => [rStats(l.filter((t) => t.entryT >= t0 && t.entryT < mid)), rStats(l.filter((t) => t.entryT >= mid))];

  // Compte Lucid actuel
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const LIS = cfg.lucidIntradayStrategies;
  const cur = Object.fromEntries(LIS.filter((k) => BARS[k.split(':')[0]]).map((k) => [k, run(k.split(':')[0], strat(k)[1], k)]));
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const daily = all.filter((t) => sids.includes(t.sid) && !t.intraday).map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  const ir = A.riskOf('nas100', selectStrategies(['n_mom10_t05'])[0]); const dr = cfg.ftmoRisk * cfg.lucidRiskMul;
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer: RULES[cfg.ftmoSizing] };
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const evalL = (intra, extraDaily = [], rules = {}) => {
    const list = [...daily, ...extraDaily.map((t) => ({ ...t, riskPct: t.riskPct ?? dr })), ...Object.values(intra).flat().map((t) => ({ ...t, riskPct: (t.riskPct ?? 1) * ir }))];
    const o = { ...RL, ...rules };
    const per = Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !t.intraday));
      const c = challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...o });
      return { pass: c.passRate, days: c.medianDays };
    });
    const l = list.filter((t) => t.entryT >= A0).sort((x, y) => x.entryT - y.entryT);
    const idx = (t) => { let lo = 0; let hi = l.length; while (lo < hi) { const m = (lo + hi) >> 1; if (l[m].entryT < t) lo = m + 1; else hi = m; } return lo; };
    const win = (t) => l.slice(idx(t), idx(t + 200 * DAY));
    const end = l[l.length - 1].entryT - 60 * DAY;
    let n = 0; let p14 = 0; let p30 = 0; let f14 = 0; let buys = 0; let fundedN = 0;
    for (let s = A0; s < end; s += DAY) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      n++;
      const r = runPhase(win(s), { ...o, from: s });
      const d = (r.at - s) / DAY;
      if (r.outcome === 'target' && d <= 14) p14++;
      if (r.outcome === 'target' && d <= 30) p30++;
      if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) f14++;
      let t = s; let k = 0;
      while (k < 30) {
        k++;
        const q = runPhase(win(t), { ...o, from: t });
        if (q.outcome === 'target') { buys += k; fundedN++; break; }
        if (q.outcome === 'open') break;
        t = Math.floor(q.at / DAY) * DAY + DAY;
      }
    }
    return { per, p14: (p14 / n) * 100, p30: (p30 / n) * 100, f14: (f14 / n) * 100, buys: fundedN ? buys / fundedN : null };
  };
  const fmt = (r) => `${r.per.map((p) => `${p.pass.toFixed(0).padStart(3)} %`).join(' |')} || ≤14 j ${r.p14.toFixed(0).padStart(2)} % · ≤30 j ${r.p30.toFixed(0).padStart(2)} % · échec ≤14 j ${r.f14.toFixed(0).padStart(2)} % · ${r.buys ? r.buys.toFixed(1) : '—'} éval.`;
  const notWorse = (r, ref) => r.per.every((p, i) => p.pass >= ref.per[i].pass - 0.5) && r.p14 >= ref.p14 - 0.5;
  const better = (r, ref) => notWorse(r, ref) && (r.p14 > ref.p14 + 0.5 || r.f14 < ref.f14 - 0.5 || r.per.some((p, i) => p.pass > ref.per[i].pass + 0.5));
  const ref = evalL(cur);
  console.log('Lucid · réussite < 1 an 2009–19 | 2020–26 | nov. 24–26 || nov. 24–26 départ chaque jour ouvré');
  console.log(`${'actuel'.padEnd(44)} ${fmt(ref)}`);

  // COMBOS='{"dayProfitCapUsd":900}|{"dayProfitCapUsd":900,"maxLossesPerDay":1}' : seulement ces règles de journée
  if (process.env.COMBOS) {
    for (const j of process.env.COMBOS.split('|')) console.log(`${j.padEnd(44)} ${fmt(evalL(cur, [], JSON.parse(j)))}`);
    return;
  }

  // A. Gestion de la journée
  console.log('\n=== A. Gestion de la journée ===');
  const ruleSets = [
    ...[0.5, 1.5, 2, 0].map((x) => [`limite de perte du jour ${x ? `−${x} %` : 'aucune'} (actuel −${cfg.ftmoDayStop} %)`, { dayStopPct: x }]),
    ...[0.3, 0.35, 0.4].map((x) => [`plafond de gain du jour ${Math.round(x * 100)} % de l'objectif`, { dayProfitCapUsd: 3000 * x }]),
    ...[1, 2, 3].map((x) => [`arrêt après ${x} trade(s) perdant(s) dans la journée`, { maxLossesPerDay: x }]),
    ...[1, 2, 3].map((x) => [`${x} position(s) au plus en même temps`, { maxOpen: x }]),
  ];
  const goodRules = [];
  for (const [name, rules] of ruleSets) {
    const res = evalL(cur, [], rules);
    const ok = better(res, ref);
    console.log(`${ok ? '✅' : '  '} ${name.padEnd(42)} ${fmt(res)}`);
    if (ok) goodRules.push({ name, rules, res });
  }

  // B. Signaux
  console.log('\n=== B. Nouveaux signaux ===');
  const cands = [];
  // B1. Filtre de tendance (moyenne 20 séances) sur l'intraday Lucid actuel
  const trendOk = (m) => {
    const c = BARS[m].c; const closes = new Map();
    for (const k of c) closes.set(nyDay(k.t), k.c);
    const days = [...closes.keys()].sort((a, b) => a - b); const up = new Map();
    days.forEach((d, j) => { if (j >= 21) { const prev = days.slice(j - 21, j - 1).map((q) => closes.get(q)); const sma = prev.reduce((a, b) => a + b, 0) / prev.length; up.set(d, closes.get(days[j - 1]) > sma); } });
    return (t) => { const u = up.get(nyDay(t.entryT)); return u === undefined ? false : (t.side === 'long' ? u : !u); };
  };
  const tf = Object.fromEntries(Object.entries(cur).map(([k, l]) => { const f = trendOk(k.split(':')[0]); return [k, l.filter(f)]; }));
  {
    const [a, b] = halves(Object.values(tf).flat()); const [a0, b0] = halves(Object.values(cur).flat());
    const res = evalL(tf);
    console.log(`${better(res, ref) ? '✅' : '  '} ${'filtre de tendance 20 j (intraday Lucid)'.padEnd(42)} ${sgn(a0.expR)} / ${sgn(b0.expR)} → ${sgn(a.expR)} / ${sgn(b.expR)} R · ${fmt(res)}`);
    if (better(res, ref)) cands.push({ tag: 'filtre de tendance', intra: tf, res });
  }
  // B2. Sortie partielle : ½ à 0,5 R + ½ à 1,5 R avec break-even à 0,5 R
  {
    const part = {};
    for (const k of Object.keys(cur)) {
      const [m, s] = strat(k);
      const base = { ...s, evaluate: s.evaluate };
      const h1 = run(m, withTp(base, 0.5, `${s.id}_p1`), k).map((t) => ({ ...t, riskPct: 0.5 }));
      const h2 = run(m, withBE(base, 0.5, 1.5, `${s.id}_p2`), k).map((t) => ({ ...t, riskPct: 0.5 }));
      part[k] = [...h1, ...h2];
    }
    const all2 = Object.values(part).flat();
    const rs = (l) => rStats(l); // R moyen par demi-position
    const [a, b] = [rs(all2.filter((t) => t.entryT >= t0 && t.entryT < mid)), rs(all2.filter((t) => t.entryT >= mid))];
    const res = evalL(part);
    console.log(`${better(res, ref) ? '✅' : '  '} ${'sortie partielle ½ 0,5 R + ½ 1,5 R (BE)'.padEnd(42)} ${sgn(a.expR)} / ${sgn(b.expR)} R par moitié · ${fmt(res)}`);
    if (better(res, ref)) cands.push({ tag: 'sortie partielle', intra: part, res });
  }
  // B3. Gap and go (Nasdaq, S&P, Dow, Russell)
  for (const m of ['nas100', 'spx', 'dow', 'russell']) {
    for (const [th, tp] of [[0.3, 0.5], [0.3, 0.75], [0.5, 0.75], [0.3, null]]) {
      const id = `gapgo_${th}_${tp ?? 'x'}`;
      const l = run(m, gapGo(th, tp, id), `${m}:${id}`).filter((t) => t.entryT >= t0);
      const [a, b] = halves(l); const st = rStats(l);
      const stable = a.expR > 0.02 && b.expR > 0.02 && a.n >= 25 && b.n >= 25 && st.worstRun <= 8;
      if (!stable) { console.log(`   ${`${m} ${id}`.padEnd(42)} ${sgn(a.expR)} (${a.n}) / ${sgn(b.expR)} (${b.n}) R · série ${st.worstRun} — pas stable`); continue; }
      const res = evalL({ ...cur, [`${m}:${id}`]: l });
      console.log(`${better(res, ref) ? '✅' : '  '} ${`${m} ${id}`.padEnd(42)} ${sgn(a.expR)} / ${sgn(b.expR)} R · ${fmt(res)}`);
      if (better(res, ref)) cands.push({ tag: `${m} ${id}`, add: { [`${m}:${id}`]: l }, res });
    }
  }
  // B4. Fin / début de mois (journalier) sur MES, MNQ, MYM, M2K
  const vix = (await cachedYahoo(CACHE, '^VIX', '1d', {}, 72)).filter((k) => k.c > 0);
  for (const [m, sym, mult, fee] of [['spx', '^GSPC', 5, 4], ['nas100', '^NDX', 2, 2.5], ['dow', '^DJI', 0.5, 2.5], ['russell', '^RUT', 5, 2.5]]) {
    if (sids.includes(`${m}:tom`)) continue;
    const d = (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0);
    const ind = computeAll(d, d, 86400, null, vix, {});
    const l = backtest(selectStrategies(['tom'])[0], d, { size: 1000, feePct: 0.01, financingPct: 5, barSec: 86400, ind, daily: d, vix }).list
      .map((t) => ({ ...t, sid: `${m}:tom`, market: m, intraday: false, contractUsd: t.entry * mult, contractFee: fee }));
    const per = [[Y(2000), Y(2010)], [Y(2010), Y(2018)], [Y(2018), Infinity]].map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
    const stable = per.every((p) => p.expR > 0.02 && p.n >= 15);
    const res = evalL(cur, l);
    console.log(`${stable && better(res, ref) ? '✅' : '  '} ${`${m} fin / début de mois`.padEnd(42)} ${per.map((p) => sgn(p.expR)).join(' / ')} R${stable ? '' : ' (pas stable)'} · ${fmt(res)}`);
    if (stable && better(res, ref)) cands.push({ tag: `${m}:tom`, daily: l, res });
  }

  // Ensemble : signaux retenus un à un, puis la meilleure règle de journée
  console.log('\n=== Ensemble (ajout un à un, meilleur ≤ 14 j d\'abord) ===');
  let intra = { ...cur }; let extra = []; let accRes = ref;
  for (const c of cands.sort((x, y) => y.res.p14 - x.res.p14)) {
    const nextIntra = c.intra ? { ...c.intra } : { ...intra, ...(c.add || {}) };
    const nextExtra = [...extra, ...(c.daily || [])];
    const res = evalL(nextIntra, nextExtra);
    const ok = better(res, accRes);
    console.log(`${ok ? '✅' : '  '} + ${c.tag.padEnd(40)} ${fmt(res)}`);
    if (ok) { intra = nextIntra; extra = nextExtra; accRes = res; }
  }
  for (const g of goodRules.sort((x, y) => y.res.p14 - x.res.p14)) {
    const res = evalL(intra, extra, g.rules);
    console.log(`${better(res, accRes) ? '✅' : '  '} + ${g.name.padEnd(40)} ${fmt(res)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
