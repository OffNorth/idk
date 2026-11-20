#!/usr/bin/env node
/**
 * Réglage du compte Lucid (LucidFlex 50K) et du compte FTMO : quelles stratégies et quel risque ?
 * Lucid : perte max 2 000 $ suiveuse en fin de journée, pas de perte du jour, micro-futures (1 micro minimum si
 * raisonnable). On essaie des sous-ensembles (tout / sans l'or et le Nasdaq journaliers, non tradables / intraday
 * seulement / intraday + EUR/USD + S&P) × risque intraday × risque journalier × stop du jour maison.
 * Choix sur 2009–2019 (sans Nasdaq intraday), vérification 2020–2026 et nov. 2024 → nov. 2026 (avec).
 *
 *   npm run lucid-tune
 */
const path = require('path');
const cfg = require('./src/config');
const { challengeStats, cmeDay } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const F = programOf(cfg);
  const RULESETS = {
    'LucidFlex 50K': { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: 50, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay },
    'LucidFlex 100K': { capital: 100_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 3000, eodTrailing: true, lockAt: 100, bestDayPct: 50, minDays: 2, contracts: true, maxContracts: 60, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay },
    [`FTMO ${F.label}`]: { steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay },
  };
  const SUBSETS = {
    tout: () => true,
    'sans or/Nasdaq journaliers': (t) => t.intraday || !['gold', 'nas100'].includes(t.market),
    'intraday seulement': (t) => t.intraday,
    'intraday + EUR/USD': (t) => t.intraday || t.market === 'eurusd',
  };
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')] };
  if (q5) P.A = [q5[0].t + 30 * 86400, Infinity, () => true];
  const L = Object.fromEntries(Object.entries(P).map(([k, [a, b, f]]) => [k, all.filter((t) => t.entryT >= a && t.entryT < b && f(t))]));
  const run = (k, R, sub, ir, dr, ds) => {
    const list = L[k].filter(SUBSETS[sub]).map((t) => ({ ...t, riskPct: t.intraday ? ir : dr }));
    return challengeStats(list, { riskPct: 1, sizer, dayStopPct: ds, horizonDays: 365, start: P[k][0], ...(Number.isFinite(P[k][1]) ? { end: P[k][1] } : {}), ...R });
  };
  const f = (c) => (c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, ${c.failedDaily}/${c.failedMax})` : '  —');
  for (const [name, R] of Object.entries(RULESETS)) {
    const rows = [];
    for (const sub of Object.keys(SUBSETS)) for (const ir of [0.25, 0.5, 0.75, 1]) for (const dr of [0.5, 1, 1.5]) for (const ds of [cfg.ftmoDayStop, 0]) {
      if (sub === 'intraday seulement' && dr !== 1) continue;
      const b = run('B', R, sub, ir, dr, ds);
      rows.push({ sub, ir, dr, ds, b });
    }
    rows.sort((x, z) => (z.b?.passRate || 0) - (x.b?.passRate || 0));
    const cur = run('B', R, 'tout', cfg.ftmoIntradayRisk, cfg.ftmoRisk, cfg.ftmoDayStop);
    console.log(`\n=== ${name} · réussite < 1 an (médiane, échecs jour/max) : 2009–2019 | 2020–2026 | nov. 24–26 ===`);
    console.log(`  réglage actuel (tout, intraday ${cfg.ftmoIntradayRisk} %, journalières ${cfg.ftmoRisk} %) : ${f(cur)} | ${f(run('C', R, 'tout', cfg.ftmoIntradayRisk, cfg.ftmoRisk, cfg.ftmoDayStop))}${P.A ? ` | ${f(run('A', R, 'tout', cfg.ftmoIntradayRisk, cfg.ftmoRisk, cfg.ftmoDayStop))}` : ''}`);
    for (const r of rows.slice(0, 6)) {
      console.log(`  ${r.sub.padEnd(28)} intraday ${String(r.ir).padEnd(4)} % · journ. ${String(r.dr).padEnd(3)} % · stop jour ${r.ds ? `${r.ds} %` : 'non'} : ${f(r.b)} | ${f(run('C', R, r.sub, r.ir, r.dr, r.ds))}${P.A ? ` | ${f(run('A', R, r.sub, r.ir, r.dr, r.ds))}` : ''}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
