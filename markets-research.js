#!/usr/bin/env node
/**
 * Quels marchés ajouter pour avoir plus de positions sans empiler les mêmes paris ? Candidats tradables chez FTMO (CFD)
 * et Lucid (micro-futures) : pétrole (USO / MCL), argent (SLV / SIL), euro (EUR/USD / M6E), Dow Jones (DIA / MYM),
 * Russell 2000 (IWM / M2K), Bitcoin (BTC / MBT).
 *   1. Corrélation des rendements journaliers avec le Nasdaq et l'or (2 ans) : plus elle est basse, plus le marché
 *      apporte des positions vraiment différentes.
 *   2. Stratégies intraday du bot (Polygon 5 min, nov. 2024 → nov. 2026) : R moyen 1re / 2e année, pire série.
 *   3. Stratégies journalières (Yahoo, depuis 2000) sur 3 tranches.
 *   4. Les retenues ajoutées aux comptes FTMO et Lucid : réussite < 1 an, délai, positions par jour.
 *
 *   npm run markets-research
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

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
// ticker Polygon 5 min, symbole Yahoo journalier, séance (NY ou 24 h), micro-contrat Lucid (valeur ≈ prix × mult, frais)
const MARKETS = {
  oil: { name: 'Pétrole', poly: 'USO', yahoo: 'CL=F', ny: true, micro: 'MCL', mult: 6000 / 75, fee: 2.5, fin: 4 },
  silver: { name: 'Argent', poly: 'SLV', yahoo: 'SI=F', ny: true, micro: 'SIL', mult: 1075, fee: 3.5, fin: 4 },
  dow: { name: 'Dow Jones', poly: 'DIA', yahoo: '^DJI', ny: true, micro: 'MYM', mult: 50, fee: 2.5, fin: 6 },
  russell: { name: 'Russell 2000', poly: 'IWM', yahoo: '^RUT', ny: true, micro: 'M2K', mult: 50, fee: 2.5, fin: 6 },
  euro: { name: 'EUR/USD', poly: 'C:EURUSD', yahoo: 'EURUSD=X', ny: false, micro: 'M6E', mult: 12500, fee: 4, fin: 2 },
  btc: { name: 'Bitcoin', poly: 'X:BTCUSD', yahoo: 'BTC-USD', ny: false, micro: 'MBT', mult: 0.1, fee: 5, fin: 8 },
};
// Stratégies de séance de New York (heures NY, calcul forcé à l'horaire du Nasdaq) et de Londres (heures UTC, comme l'or)
const NY_FTMO = ['n_noise', 'n_orb5s', 'n_orb15', 'n_mom10', 'n_crabel7_15', 'n_crabel7_30', 'n_crabel4_30', 'n_wvb05'];
const NY_LUCID = ['n_noise_t05', 'n_orb5s_t05', 'n_orb15_t05', 'n_mom10_t05', 'n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05', 'n_crabel4_t05', 'n_wvb05_t075', 'n_wvb07_t05'];
const LDN = ['g_orb30', 'g_orb60', 'g_gap', 'g_asiabrk'];
const asMkt = (s, timing) => ({ ...s, compute: (c, sec) => s.compute(c, sec, timing) });
const DAILY = ['rsi2', 'ibs', 'down3', 'double7'];

const corr = (a, b) => {
  const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n; const mb = b.reduce((x, y) => x + y, 0) / n;
  let s = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb);
};
const dailyRet = (d) => { const m = new Map(); for (let i = 1; i < d.length; i++) m.set(Math.floor(d[i].t / 86400), d[i].c / d[i - 1].c - 1); return m; };

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d', {}, 72).then((d) => d.filter((k) => k.c > 0));
  const ndx = await y('^NDX'); const gc = await y('GC=F'); const vix = await y('^VIX');
  const rN = dailyRet(ndx); const rG = dailyRet(gc);
  const from2y = Date.now() / 1000 - 730 * 86400;
  const rows = [];
  const report = [];
  for (const [id, M] of Object.entries(MARKETS)) {
    const d = await y(M.yahoo).catch(() => null);
    // 1. corrélations (2 ans)
    let cN = null; let cG = null;
    if (d) {
      const r = dailyRet(d.filter((k) => k.t >= from2y));
      const k1 = [...r.keys()].filter((k) => rN.has(k)); const k2 = [...r.keys()].filter((k) => rG.has(k));
      cN = corr(k1.map((k) => r.get(k)), k1.map((k) => rN.get(k))); cG = corr(k2.map((k) => r.get(k)), k2.map((k) => rG.get(k)));
    }
    // 2. intraday
    let bars = null;
    try { bars = await require('./src/polygon').polygonBars(CACHE, M.poly, 5, '2024-11-18', { maxAgeH: Infinity }); } catch { /* pas de données */ }
    const intra = [];
    if (bars?.length) {
      const c5 = M.ny ? nySession(bars) : bars;
      const t0 = c5[0].t + 30 * 86400; const t1 = c5[c5.length - 1].t; const mid = (t0 + t1) / 2;
      const days = ((t1 - t0) / 86400) * (5 / 7);
      const ids = [...NY_FTMO.map((s) => ['FTMO', s, 'nas100']), ...NY_LUCID.map((s) => ['Lucid', s, 'nas100']), ...(M.ny ? [] : LDN.map((s) => ['FTMO', s, 'gold']))];
      for (const [acct, sid, timing] of ids) {
        const s = selectStrategies([sid])[0]; if (!s) continue;
        let l;
        try { l = backtest(asMkt(s, timing), c5, { size: 1000, feePct: 0.003, financingPct: M.fin, barSec: 300, market: timing }).list.filter((t) => t.entryT >= t0); } catch { continue; }
        const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const st = rStats(l);
        const ok = a.expR > 0.02 && b.expR > 0.02 && a.n >= 25 && b.n >= 25 && st.worstRun <= (acct === 'Lucid' ? 8 : 12);
        const row = { mk: id, acct, sid, l: l.map((t) => ({ ...t, sid: `${id}:${sid}`, market: id, intraday: true, contractUsd: t.entry * M.mult, contractFee: M.fee })), a, b, st, ok, perDay: l.length / days };
        rows.push(row); intra.push(row);
      }
    }
    // 3. journalier
    const daily = [];
    if (d && d.length > 500) {
      const ind = computeAll(d, d, 86400, null, vix, {});
      const sl = [[Y(2000), Y(2010)], [Y(2010), Y(2018)], [Y(2018), Infinity]];
      for (const sid of DAILY) {
        const s = selectStrategies([sid])[0];
        const l = backtest(s, d, { size: 1000, feePct: 0.01, financingPct: M.fin, barSec: 86400, ind, daily: d, vix }).list;
        const per = sl.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
        daily.push({ sid, per, ok: per.every((p) => p.expR > 0.02 && p.n >= 15) });
      }
    }
    report.push({ id, M, cN, cG, intra, daily });
  }

  for (const r of report) {
    console.log(`\n=== ${r.M.name} (${r.M.poly} · Lucid ${r.M.micro}) · corrélation journalière avec le Nasdaq ${r.cN === null ? '—' : r.cN.toFixed(2)}, avec l'or ${r.cG === null ? '—' : r.cG.toFixed(2)} ===`);
    for (const x of r.intra.filter((q) => q.ok)) console.log(`  ✅ intraday ${x.acct.padEnd(5)} ${x.sid.padEnd(16)} ${(x.a.expR >= 0 ? '+' : '') + x.a.expR.toFixed(2)} / ${(x.b.expR >= 0 ? '+' : '') + x.b.expR.toFixed(2)} R · ${x.st.win.toFixed(0)} % · série ${x.st.worstRun} · ${x.perDay.toFixed(2)} /j`);
    const nOk = r.intra.filter((q) => q.ok).length;
    console.log(`  intraday : ${nOk} / ${r.intra.length} stables`);
    for (const x of r.daily) console.log(`  ${x.ok ? '✅' : '  '} journalier ${x.sid.padEnd(8)} ${x.per.map((p) => `${(p.expR >= 0 ? '+' : '') + p.expR.toFixed(2)} (${p.n})`).join(' | ')} R  (2000–09 | 2010–17 | 2018–26)`);
  }

  // 4. Comptes : réglage actuel + intraday retenues de chaque marché (FTMO : versions sans objectif ; Lucid : avec objectif)
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const nasCache = {};
  const nasTrades = (sid) => (nasCache[sid] ??= backtest(selectStrategies([sid.split(':')[1]])[0], qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: 'nas100', intraday: true, contractUsd: t.entry * 82, contractFee: 2.5 })));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const sizer = RULES[cfg.ftmoSizing];
  const A0 = q5[0].t + 30 * 86400; const days = ((qs[qs.length - 1].t - A0) / 86400) * (5 / 7);
  const R = {
    gold: { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop },
    lucid: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop },
  };
  const evalAcc = (id, extra) => {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id);
    const sids = A.strategies.filter((k) => { const [m, s] = strat(k); return A.riskOf(m, s) > 0; });
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100') && t.entryT >= A0);
    const nas = sids.filter((k) => k.startsWith('nas100:') && strat(k)[1].tf && strat(k)[1].tf !== '1d').flatMap(nasTrades).filter((t) => t.entryT >= A0);
    const xr = id === 'gold' ? cfg.ftmoIntradayRisk * (cfg.ftmoRiskMul ?? 1) : cfg.lucidIntradayRisk;
    const list = [...[...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) })), ...extra.filter((t) => t.entryT >= A0).map((t) => ({ ...t, riskPct: xr }))];
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: A0, ...R[id] });
    const intraDay = (nas.length + extra.filter((t) => t.entryT >= A0).length) / days;
    return `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j) · intraday ${intraDay.toFixed(1)} /j`;
  };
  console.log('\n=== Comptes, nov. 2024 → nov. 2026 (départ chaque semaine) : réussite < 1 an (délai médian), positions intraday par jour ===');
  console.log(`${'actuel'.padEnd(34)} FTMO ${evalAcc('gold', [])}  ·  Lucid ${evalAcc('lucid', [])}`);
  const allF = []; const allL = [];
  for (const r of report) {
    const f = r.intra.filter((q) => q.ok && q.acct === 'FTMO').flatMap((q) => q.l);
    const l = r.intra.filter((q) => q.ok && q.acct === 'Lucid').flatMap((q) => q.l);
    if (!f.length && !l.length) continue;
    allF.push(...f); allL.push(...l);
    console.log(`${('+ ' + r.M.name).padEnd(34)} FTMO ${f.length ? evalAcc('gold', f) : '—'}  ·  Lucid ${l.length ? evalAcc('lucid', l) : '—'}`);
  }
  if (allF.length || allL.length) console.log(`${'+ tous les marchés'.padEnd(34)} FTMO ${allF.length ? evalAcc('gold', allF) : '—'}  ·  Lucid ${allL.length ? evalAcc('lucid', allL) : '—'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
