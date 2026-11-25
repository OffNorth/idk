#!/usr/bin/env node
/**
 * Objectif « réussir en 2 semaines » (npm run twoweeks) : avec les stratégies actuelles, que faut-il pour passer
 * l'évaluation en ≤ 14 jours, et à quel prix (échecs) ?
 *   Pour chaque compte (FTMO 1 étape 100K, LucidFlex 50K) et plusieurs niveaux de risque (× 1 à × 4 sur tout, ou sur
 *   l'intraday seulement), départ CHAQUE jour ouvré de nov. 2024 → nov. 2026 (toutes les stratégies, intraday compris) :
 *     - réussie en ≤ 14 j / ≤ 30 j, échouée en ≤ 14 j, encore en cours à 14 j ;
 *     - « financé en ≤ 14 j en recommençant après chaque échec » et nombre moyen d'évaluations achetées avant de
 *       réussir (un échec = nouvelle évaluation le jour suivant).
 *   Vérification sur 2020–2026 (journalières + intraday or, pas d'intraday Nasdaq avant nov. 2024).
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { runPhase, cmeDay, ftmoDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const run = (bars, sid, mult, fee) => {
    const s = strat(sid)[1];
    return backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, bars, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid, market: sid.split(':')[0], intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  };
  const intraBars = { nas100: [qs, 82, 2.5] };
  for (const [m, T, mult, fee] of [['silver', 'SLV', 1075, 3.5], ['dow', 'DIA', 50, 2.5]]) {
    try { intraBars[m] = [nySession(await polygonBars(CACHE, T, 5, '2024-11-18', { maxAgeH: Infinity })), mult, fee]; } catch { /* pas de données */ }
  }
  try { intraBars.spx = [nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60)), 50, 4]; } catch { /* pas de données */ }
  const listOf = (id) => {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id);
    const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market !== 'gold'));
    const intra = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && m !== 'gold' && intraBars[m]; })
      .flatMap((k) => { const [b, mult, fee] = intraBars[k.split(':')[0]]; return run(b, k, mult, fee); });
    return [...base, ...intra].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  };
  const sizer = RULES[cfg.ftmoSizing];
  const ACC = {
    FTMO: { list: listOf('gold'), opts: { capital: 100_000, target: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, dayOf: ftmoDay } },
    Lucid: { list: listOf('lucid'), opts: { capital: 50_000, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop } },
  };
  const A0 = q5[0].t + 30 * DAY;
  const PER = { 'nov. 24–26': [A0, Infinity, true], '2020–26': [Date.UTC(2020, 0, 1) / 1000, Date.UTC(2024, 10, 1) / 1000, false] };

  const scale = (list, mAll, mIntra) => list.map((t) => ({ ...t, riskPct: t.riskPct * mAll * (t.intraday ? mIntra : 1) }));
  const study = (list, opts, [a, b, withIntra]) => {
    const l = list.filter((t) => t.entryT >= a && t.entryT < b + 60 * DAY && (withIntra || !(t.intraday && t.market !== 'gold')));
    const end = Math.min(b, Math.max(...l.map((t) => t.entryT))) - 60 * DAY;
    const o = { ...opts, riskPct: 1, sizer };
    l.sort((x, y) => x.entryT - y.entryT);
    const idx = (t) => { let lo = 0; let hi = l.length; while (lo < hi) { const m = (lo + hi) >> 1; if (l[m].entryT < t) lo = m + 1; else hi = m; } return lo; };
    // Fenêtre de 400 jours à partir du départ (plus rapide que toute la liste)
    const win = (t) => l.slice(idx(t), idx(t + 400 * DAY));
    let n = 0; let p14 = 0; let p30 = 0; let f14 = 0; let fund14 = 0; let buys = 0; let fundedN = 0;
    for (let s = a; s < end; s += DAY) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      n++;
      const r = runPhase(win(s), { ...o, from: s });
      const d = (r.at - s) / DAY;
      if (r.outcome === 'target' && d <= 14) p14++;
      if (r.outcome === 'target' && d <= 30) p30++;
      if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) f14++;
      // En recommençant après chaque échec (nouvelle évaluation le lendemain), jusqu'à la réussite
      let t = s; let k = 0; let ok = false;
      while (k < 30) {
        k++;
        const q = runPhase(win(t), { ...o, from: t });
        if (q.outcome === 'target') { ok = true; if ((q.at - s) / DAY <= 14) fund14++; break; }
        if (q.outcome === 'open') break;
        t = Math.floor(q.at / DAY) * DAY + DAY;
      }
      if (ok) { buys += k; fundedN++; }
    }
    const pc = (x) => `${((x / n) * 100).toFixed(0).padStart(3)} %`;
    return `${pc(p14)} | ${pc(p30)} | ${pc(f14)} | ${pc(fund14)} | ${fundedN ? (buys / fundedN).toFixed(1) : '—'}`;
  };
  for (const [name, { list, opts }] of Object.entries(ACC)) {
    for (const [pname, per] of Object.entries(PER)) {
      console.log(`\n=== ${name} · ${pname} (départ chaque jour ouvré) ===`);
      console.log(`${'risque'.padEnd(26)} réussie ≤14 j | ≤30 j | échouée ≤14 j | financé ≤14 j (en recommençant) | évaluations achetées`);
      for (const [label, mAll, mIntra] of [['actuel', 1, 1], ['× 1,5', 1.5, 1], ['× 2', 2, 1], ['× 3', 3, 1], ['× 4', 4, 1], ['intraday × 2', 1, 2], ['intraday × 3', 1, 3], ['intraday × 5', 1, 5]]) {
        console.log(`${label.padEnd(26)} ${study(scale(list, mAll, mIntra), opts, per)}`);
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
