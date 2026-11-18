#!/usr/bin/env node
/**
 * Recherche de stratégies qui passent le challenge FTMO : famille « retour à la moyenne dans la tendance »
 * (x_rsi2 + src/meanrev.js) sur 5 min, 15 min et 1 h, or et Nasdaq, puis portefeuille sur un seul compte.
 *
 *   npm run ftmo-mr
 *
 * Même juge que ftmo.js : risque 1 % par trade, stop du jour −2 %, challenges lancés chaque semaine,
 * réussite = étapes 1 (+10 %) et 2 (+5 %) en moins de 6 mois. Sélection sur la période de CHOIX uniquement
 * (≥ 30 trades, espérance > 0,1 R, profit factor ≥ 1,15), puis vérification sur la période suivante.
 */
const path = require('path');
const { loadKlines, loadHourly, aggregate } = require('./src/history');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { selectStrategies, withTf, TF_SEC } = require('./src/strategies');
const { computeScalp2 } = require('./src/scalp2');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const IDS = ['x_rsi2', 'm_ibs', 'm_bb', 'm_down3', 'm_vwap', 'm_rsi2x'];
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
const RULES = { riskPct: 1, dayStopPct: 2 };

(async () => {
  console.log('Chargement des données…');
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const sets = [
    { name: 'Or 5 min (PAXG 2020–2026)', market: 'gold', tf: '5m', fee: 0.005, split: '2024-07-01', candles: g5 },
    { name: 'Or 15 min (PAXG 2020–2026)', market: 'gold', tf: '15m', fee: 0.005, split: '2024-07-01', candles: aggregate(g5, 900, 300) },
    { name: 'Or 1 h (PAXG 2020–2026)', market: 'gold', tf: '1h', fee: 0.005, split: '2024-07-01', candles: await loadHourly(CACHE) },
    { name: 'Nasdaq 5 min (NQ=F, 60 jours)', market: 'nas100', tf: '5m', fee: 0.003, candles: await cachedYahoo(CACHE, 'NQ=F', '5m', { range: '60d' }, 12) },
    { name: 'Nasdaq 15 min (NQ=F, 60 jours)', market: 'nas100', tf: '15m', fee: 0.003, candles: await cachedYahoo(CACHE, 'NQ=F', '15m', { range: '60d' }, 12) },
    { name: 'Nasdaq 1 h (NQ=F, 2 ans)', market: 'nas100', tf: '1h', fee: 0.003, candles: await cachedYahoo(CACHE, 'NQ=F', '1h', { range: '730d' }) },
  ];

  const kept = [];
  for (const set of sets) {
    const { candles, tf } = set;
    const split = set.split ? Date.parse(set.split) / 1000 : candles[Math.floor(candles.length / 2)].t;
    const ind = computeScalp2(candles, TF_SEC[tf], set.market);
    console.log(`\n=== ${set.name} : ${iso(candles[0].t)} → ${iso(candles[candles.length - 1].t)} · choix avant ${iso(split)} · frais ${set.fee} %/côté ===`);
    console.log('SÉL  STRATÉGIE'.padEnd(54) + 'trades/mois  gagn.  R/trade choix | vérif   R/mois | FTMO réussite < 6 mois (tout / période récente)');
    for (const base of selectStrategies(IDS)) {
      const s = withTf(base, tf);
      const r = backtest(s, candles, { size: 1000, feePct: set.fee, barSec: TF_SEC[tf], ind, market: set.market });
      const trades = r.list;
      if (trades.length < 20) { console.log(`     ${base.name.slice(0, 48).padEnd(49)}trop peu de trades (${trades.length})`); continue; }
      const tr = trades.filter((t) => t.entryT < split);
      const te = trades.filter((t) => t.entryT >= split);
      const a = rStats(trades);
      const sa = rStats(tr);
      const sb = rStats(te);
      const w = tr.filter((t) => t.pnlPct > 0).reduce((x, t) => x + t.pnlPct, 0);
      const l = -tr.filter((t) => t.pnlPct <= 0).reduce((x, t) => x + t.pnlPct, 0);
      const sel = sa.n >= 30 && sa.expR > 0.1 && l > 0 && w / l >= 1.15;
      const call = challengeStats(trades, RULES);
      const crec = challengeStats(te, RULES);
      const fc = (c) => (c ? `${c.passRate.toFixed(0)} % (${c.medianDays ? `${c.medianDays.toFixed(0)} j` : '—'})` : '—');
      console.log(
        (sel ? ' ✔   ' : '     ') + base.name.slice(0, 48).padEnd(49) +
        `${a.tradesPerMonth.toFixed(0).padStart(7)}  ${a.win.toFixed(0).padStart(5)}%  ${f2(sa.expR).padStart(9)} | ${f2(sb.expR).padStart(6)}  ${f2(a.rPerMonth).padStart(7)} | ${fc(call).padEnd(14)} / ${fc(crec)}`,
      );
      if (sel && sb.expR > 0.03) kept.push({ set, id: s.id, name: base.name, trades, split });
    }
  }

  console.log(`\nRetenues au choix ET positives en vérification (> 0,03 R/trade) : ${kept.length}`);
  for (const k of kept) console.log(`  ${k.set.name} · ${k.id}`);

  // Portefeuille sur un même compte, période commune de l'or (2020–2026) et période récente seule
  const gold = kept.filter((k) => k.set.market === 'gold');
  if (gold.length) {
    const all = gold.flatMap((k) => k.trades.map((t) => ({ ...t, sid: k.id })));
    const recentFrom = Date.parse('2024-07-01') / 1000;
    console.log(`\nPortefeuille or (${gold.map((k) => k.id).join(' + ')}) sur un seul compte :`);
    for (const risk of [0.5, 0.75, 1]) {
      const c = challengeStats(all, { riskPct: risk, dayStopPct: 2 });
      const cr = challengeStats(all.filter((t) => t.entryT >= recentFrom), { riskPct: risk, dayStopPct: 2 });
      const st = rStats([...all].sort((x, y) => x.exitT - y.exitT));
      console.log(`  risque ${risk} % : réussite ${c.passRate.toFixed(0)} % (médiane ${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, échecs jour ${c.failedDaily} · max ${c.failedMax}) · période récente ${cr.passRate.toFixed(0)} % (médiane ${cr.medianDays ? cr.medianDays.toFixed(0) : '—'} j) · ${st.tradesPerMonth.toFixed(0)} trades/mois`);
    }
  }
  console.log('\nRéussite = 2 étapes en moins de 6 mois, challenges lancés chaque semaine (non fini = raté). Simulation, pas un conseil.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
