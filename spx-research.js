#!/usr/bin/env node
/**
 * Plus de positions : les stratégies intraday du Nasdaq appliquées au S&P 500 (SPY 1 min Polygon → 5 min, séance de
 * New York seule, nov. 2024 → nov. 2026). Le bot ne trade aujourd'hui le S&P qu'en journalier.
 * Sélection : avantage > +0,02 R les deux années, ≥ 25 trades par année ; séries ≤ 12 pertes (FTMO, sans objectif) ou
 * ≤ 8 (Lucid, avec objectif). Puis ajout aux comptes : réussite < 1 an, délai, positions intraday par jour.
 *
 *   npm run spx-research     (télécharge SPY via Polygon au 1er lancement : POLYGON_API_KEY)
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

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
// Stratégies de séance de New York (heures de New York) : calcul forcé à l'horaire du Nasdaq
const asSpx = (s) => ({ ...s, markets: ['spx'], compute: (c, sec) => s.compute(c, sec, 'nas100') });
const FTMO_IDS = ['n_noise', 'n_orb5s', 'n_orb15', 'n_mom10', 'n_crabel7_15', 'n_crabel7_30', 'n_crabel4_30', 'n_wvb05'];
const LUCID_IDS = ['n_noise_t05', 'n_orb5s_t05', 'n_orb15_t05', 'n_mom10_t05', 'n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05', 'n_crabel4_t05', 'n_crabel7_15_t075', 'n_wvb05_t075', 'n_wvb07_t05'];

(async () => {
  const sp = require('./src/oanda').nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const qs = require('./src/oanda').nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const t0 = sp[0].t + 30 * 86400; const t1 = sp[sp.length - 1].t; const mid = (t0 + t1) / 2;
  const days = ((t1 - t0) / 86400) * (5 / 7);
  // MES = 5 $ × indice ≈ 5 × 10 × SPY
  const spxTrades = (id) => backtest(asSpx(selectStrategies([id])[0]), sp, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'spx' }).list
    .filter((t) => t.entryT >= t0).map((t) => ({ ...t, sid: `spx:${id}`, market: 'spx', intraday: true, contractUsd: t.entry * 50, contractFee: 4 }));
  const rows = [];
  for (const [acct, ids, maxRun] of [['FTMO', FTMO_IDS, 12], ['Lucid', LUCID_IDS, 8]]) for (const id of ids) {
    const l = spxTrades(id);
    const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const all = rStats(l);
    rows.push({ acct, id, l, a, b, all, ok: a.expR > 0.02 && b.expR > 0.02 && a.n >= 25 && b.n >= 25 && all.worstRun <= maxRun });
  }
  console.log('=== S&P 500 intraday (SPY séance seule, nov. 2024 → nov. 2026) · R moyen 1re / 2e année · gagnants · pire série · baisse max · trades / jour ===');
  for (const r of rows) console.log(`${r.ok ? '✅' : '  '} ${r.acct.padEnd(5)} ${r.id.padEnd(18)} ${(r.a.expR >= 0 ? '+' : '') + r.a.expR.toFixed(2)} / ${(r.b.expR >= 0 ? '+' : '') + r.b.expR.toFixed(2)} R · ${r.all.win.toFixed(0)} % · série ${String(r.all.worstRun).padStart(2)} · baisse ${r.all.maxDdR.toFixed(1).padStart(5)} R · ${(r.l.length / days).toFixed(2)} /j`);

  // ---- Comptes : réglage actuel (Nasdaq intraday recalculé sur la séance seule) + S&P retenues
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const nasCache = {};
  const nasTrades = (sid) => (nasCache[sid] ??= backtest(selectStrategies([sid.split(':')[1]])[0], qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: 'nas100', intraday: true, contractUsd: t.entry * 82, contractFee: 2.5 })));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const sizer = RULES[cfg.ftmoSizing];
  const A0 = q5[0].t + 30 * 86400;
  const P = { B: [Y(2009) + 60 * 86400, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const R = {
    gold: { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop },
    lucid: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop },
  };
  const evalAcc = (id, extra) => {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id);
    const sids = A.strategies.filter((k) => { const [m, s] = strat(k); return A.riskOf(m, s) > 0; });
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100'));
    const nas = sids.filter((k) => k.startsWith('nas100:') && strat(k)[1].tf && strat(k)[1].tf !== '1d').flatMap(nasTrades);
    const xr = id === 'gold' ? cfg.ftmoIntradayRisk * (cfg.ftmoRiskMul ?? 1) : cfg.lucidIntradayRisk;
    const list = [...[...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) })), ...extra.map((t) => ({ ...t, riskPct: xr }))];
    const intraDay = [...nas, ...extra].filter((t) => t.entryT >= A0).length / days;
    return Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && (t.market === 'nas100' || t.market === 'spx'))));
      const c = challengeStats(l, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...R[id] });
      return `${k} ${c.passRate.toFixed(0)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`;
    }).join(' | ') + ` · intraday ${intraDay.toFixed(1)} /j`;
  };
  for (const [acct, id] of [['FTMO', 'gold'], ['Lucid', 'lucid']]) {
    const kept = rows.filter((r) => r.ok && r.acct === acct);
    console.log(`\n=== ${acct} (réussite < 1 an : 2009–19 | 2020–26 | nov. 24–26) ===`);
    console.log(`${'actuel'.padEnd(26)} ${evalAcc(id, [])}`);
    for (const r of kept) console.log(`${('+ spx ' + r.id).padEnd(26)} ${evalAcc(id, r.l)}`);
    if (kept.length > 1) console.log(`${'+ toutes'.padEnd(26)} ${evalAcc(id, kept.flatMap((r) => r.l))}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
