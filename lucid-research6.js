#!/usr/bin/env node
/**
 * 6e recherche Lucid (npm run lucid-research6) : refaire passer, avec le RÉGLAGE ACTUEL de Lucid (risque intraday × 3
 * pendant l'évaluation, journée finie à +750 $ ou après 1 perte, euro en 6E réel, journalières Russell / Nasdaq / argent),
 * les stratégies stables écartées sous l'ancien réglage, et les variantes « Lucid » de l'intraday or :
 *   Or (MGC, or au comptant HistData 5 min 2009–2026) : g_orb30, g_orb60, g_mom8, g_gap, g_asiabrk, g_nypdl, telles
 *     quelles, avec objectif 0,5 / 0,75 R, ou stop au prix d'entrée après +0,5 R (objectif 1 R) ;
 *     stable = > +0,02 R sur 2009–14, 2015–20 et 2021–26, ≤ 8 pertes de suite.
 *   Pétrole (MCL, USO), S&P (MES, SPY), Russell (M2K, IWM), Dow (MYM, DIA), argent (SIL, SLV) : toute la panoplie
 *     intraday Lucid (séance de New York, 2 ans) ; stable = > +0,02 R les deux années, ≤ 8 pertes de suite.
 * Mesure : réussite < 1 an 2009–19 | 2020–26 | nov. 24–26 ; nov. 24–26 départ chaque jour ouvré : réussie ≤ 14 j / ≤ 30 j,
 * échouée ≤ 14 j, évaluations achetées. Ajout un à un (meilleur ≤ 14 j d'abord), gardé si rien ne baisse.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, runPhase, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { withTp } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const withBE = (s, k, tp, id) => ({
  ...s, id,
  evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 ? { ...r, tp: tp * r.sl } : r; },
  trail(pos) { const fav = pos.side === 'long' ? pos.best - pos.entry : pos.entry - pos.best; return fav >= k * Math.abs(pos.entry - pos.initSl) ? pos.entry : NaN; },
});
const variants = (s) => [s, withTp(s, 0.5, `${s.id}_t05`, `${s.name} (0,5 R)`), withTp(s, 0.75, `${s.id}_t075`, `${s.name} (0,75 R)`), withBE(s, 0.5, 1, `${s.id}_be`)];
const NY_LUCID = ['n_noise_t05', 'n_orb5s_t05', 'n_orb15_t05', 'n_mom10_t05', 'n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05', 'n_crabel4_t05', 'n_crabel7_15_t075', 'n_wvb05_t075', 'n_wvb07_t05', 'n_mom10_t1be'];

(async () => {
  // Compte Lucid actuel
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const nyRun = (bars, s, sid, m, mult, fee) => backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, bars, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  const NYB = {
    nas100: [qs, 82, 2.5], silver: [nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity })), 1075, 3.5],
    dow: [nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    russell: [nySession(await polygonBars(CACHE, 'IWM', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    spx: [nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60)), 50, 4],
    oil: [nySession(await polygonBars(CACHE, 'USO', 5, '2024-11-18', { maxAgeH: Infinity })), 80, 2.5],
  };
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const intraBase = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; })
    .flatMap((k) => { const [b, mult, fee] = NYB[k.split(':')[0]]; return nyRun(b, strat(k)[1], k, k.split(':')[0], mult, fee); });
  const base = [...all.filter((t) => sids.includes(t.sid) && !t.intraday), ...intraBase].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  const ir = A.riskOf('nas100', selectStrategies(['n_mom10_t05'])[0]);
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2,
    contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer: RULES[cfg.ftmoSizing],
    dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * 50_000 * 0.06, maxLossesPerDay: cfg.lucidMaxLossesDay || Infinity };
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const evalL = (extra) => {
    const list = [...base, ...extra.map((t) => ({ ...t, riskPct: ir }))];
    const per = Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      const c = challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...RL });
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
      const r = runPhase(win(s), { ...RL, from: s }); const d = (r.at - s) / DAY;
      if (r.outcome === 'target' && d <= 14) p14++;
      if (r.outcome === 'target' && d <= 30) p30++;
      if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) f14++;
      let t = s; let k = 0;
      while (k < 30) { k++; const q = runPhase(win(t), { ...RL, from: t }); if (q.outcome === 'target') { buys += k; fundedN++; break; } if (q.outcome === 'open') break; t = Math.floor(q.at / DAY) * DAY + DAY; }
    }
    return { per, p14: (p14 / n) * 100, p30: (p30 / n) * 100, f14: (f14 / n) * 100, buys: fundedN ? buys / fundedN : null };
  };
  const fmt = (r) => `${r.per.map((p) => `${p.pass.toFixed(0).padStart(3)} %`).join(' |')} || ≤14 j ${r.p14.toFixed(0).padStart(2)} % · ≤30 j ${r.p30.toFixed(0).padStart(2)} % · échec ≤14 j ${r.f14.toFixed(0).padStart(2)} % · ${r.buys ? r.buys.toFixed(1) : '—'} éval.`;
  const better = (r, ref) => r.per.every((p, i) => p.pass >= ref.per[i].pass - 0.5) && r.p14 >= ref.p14 - 0.5 && (r.p14 > ref.p14 + 0.5 || r.p30 > ref.p30 + 0.5 || r.f14 < ref.f14 - 0.5 || r.per.some((p, i) => p.pass > ref.per[i].pass + 0.5));
  const ref = evalL([]);
  console.log('Lucid (réglage actuel) · réussite < 1 an 2009–19 | 2020–26 | nov. 24–26 || nov. 24–26 départ chaque jour ouvré');
  console.log(`${'actuel'.padEnd(36)} ${fmt(ref)}`);
  const cands = [];

  // Or : HistData 5 min 2009–2026 (MGC : 10 onces, frais 3,5 $)
  console.log('\n=== Or (MGC), 2009–2026 ===');
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const g15 = aggregate(g5, 900, 300);
  const SL = [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]];
  for (const id of ['g_orb30', 'g_orb60', 'g_mom8', 'g_gap', 'g_asiabrk', 'g_nypdl']) {
    const s0 = selectStrategies([id])[0]; if (!s0) continue;
    for (const s of variants(s0)) {
      const c = s.tf === '15m' ? g15 : g5; const sec = s.tf === '15m' ? 900 : 300;
      const l = backtest(s, c, { size: 1000, feePct: 0.005, financingPct: 0, barSec: sec, ind: s.compute ? s.compute(c, sec, 'gold') : undefined, market: 'gold' }).list
        .map((t) => ({ ...t, sid: `gold:${s.id}`, market: 'gold', intraday: true, contractUsd: t.entry * 10, contractFee: 3.5 }));
      const per = SL.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
      const st = rStats(l);
      const ok = per.every((p) => p.expR > 0.02 && p.n >= 50) && st.worstRun <= 8;
      if (!ok) { console.log(`   ${s.id.padEnd(18)} ${per.map((p) => sgn(p.expR)).join(' / ')} R · série ${st.worstRun} — pas stable`); continue; }
      const res = evalL(l);
      const good = better(res, ref);
      console.log(`${good ? '✅' : '  '} ${s.id.padEnd(18)} ${per.map((p) => sgn(p.expR)).join(' / ')} R · série ${st.worstRun} · ${fmt(res)}`);
      if (good) cands.push({ tag: `gold:${s.id}`, l, res });
    }
  }

  // Séance de New York : pétrole, S&P, Russell, Dow, argent (panoplie Lucid)
  const t0 = qs[0].t + 30 * DAY; const t1 = qs[qs.length - 1].t; const mid = (t0 + t1) / 2;
  for (const m of ['oil', 'spx', 'russell', 'dow', 'silver']) {
    console.log(`\n=== ${m} (séance de New York, 2 ans) ===`);
    const [b, mult, fee] = NYB[m];
    for (const id of NY_LUCID) {
      if (sids.includes(`${m}:${id}`)) continue;
      const s = selectStrategies([id])[0]; if (!s) continue;
      const l = nyRun(b, s, `${m}:${id}`, m, mult, fee).filter((t) => t.entryT >= t0);
      const a = rStats(l.filter((t) => t.entryT < mid)); const c = rStats(l.filter((t) => t.entryT >= mid)); const st = rStats(l);
      if (!(a.expR > 0.02 && c.expR > 0.02 && a.n >= 25 && c.n >= 25 && st.worstRun <= 8)) continue;
      const res = evalL(l);
      const good = better(res, ref);
      console.log(`${good ? '✅' : '  '} ${id.padEnd(18)} ${sgn(a.expR)} / ${sgn(c.expR)} R · série ${st.worstRun} · ${fmt(res)}`);
      if (good) cands.push({ tag: `${m}:${id}`, l, res });
    }
  }

  console.log('\n=== Ensemble (ajout un à un, meilleur ≤ 14 j d\'abord) ===');
  let acc = []; let accRes = ref;
  for (const c of cands.sort((x, y) => y.res.p14 - x.res.p14 || y.res.p30 - x.res.p30)) {
    if (acc.some((t) => t.sid.split('_')[0] === c.tag.split('_')[0] && t.sid !== c.tag)) continue; // une seule variante par stratégie
    const res = evalL([...acc, ...c.l]);
    const ok = better(res, accRes);
    console.log(`${ok ? '✅' : '  '} + ${c.tag.padEnd(32)} ${fmt(res)}`);
    if (ok) { acc = [...acc, ...c.l]; accRes = res; }
  }
})().catch((e) => { console.error(e); process.exit(1); });
