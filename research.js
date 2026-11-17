#!/usr/bin/env node
/**
 * Banc d'essai : toutes les stratégies × toutes les unités de temps (1 h, 6 h, 1 j) sur ~6 ans de PAXG
 * (archive Binance), avec séparation CHOIX / VÉRIFICATION pour éviter de se tromper soi-même.
 *
 *   npm run research                  → frais 0,05 % par côté, coupure au 2024-07-01
 *   npm run research -- 0.1           → frais 0,1 % par côté
 *   npm run research -- 0.05 2023-07-01
 *
 * Règle de sélection fixée AVANT de regarder la vérification (période de choix uniquement) :
 *   PnL > 0, profit factor ≥ 1,15, au moins 20 trades, et positive au moins 60 % des années.
 */
const path = require('path');
const { loadHourly, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { STRATEGIES, withTf, tfOf, TF_SEC } = require('./src/strategies');

const FEE = Number(process.argv[2]) || 0.05;
const SPLIT = process.argv[3] || '2024-07-01';
const SIZE = 1000;

const year = (t) => new Date(t * 1000).getUTCFullYear();
const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}$`;

function yearly(list) {
  const by = {};
  for (const t of list) by[year(t.exitT)] = (by[year(t.exitT)] || 0) + t.pnlUsd;
  return by;
}

function exposure(list, from, to) {
  const inMarket = list.reduce((s, t) => s + Math.max(0, Math.min(t.exitT, to) - Math.max(t.entryT, from)), 0);
  return inMarket / (to - from);
}

(async () => {
  console.log('Chargement de l’historique PAXG 1 h (archive Binance)…');
  const hourly = await loadHourly(path.join(__dirname, 'data', 'research'), { log: console.log });
  const fx = aggregate(await loadHourly(path.join(__dirname, 'data', 'research'), { log: console.log, symbol: 'EURUSDT' }), TF_SEC['1d']);
  const series = { '1h': hourly, '6h': aggregate(hourly, TF_SEC['6h']), '1d': aggregate(hourly, TF_SEC['1d']) };
  const daily = series['1d'];
  const split = Date.parse(SPLIT) / 1000;
  const first = hourly[0];
  const last = hourly[hourly.length - 1];
  const at = (t) => hourly.find((c) => c.t >= t);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const holdTrain = SIZE * (at(split).c / first.c - 1);
  const holdTest = SIZE * (last.c / at(split).c - 1);

  console.log(`\nOr (PAXG) ${iso(first.t)} → ${iso(last.t)} · ${hourly.length} bougies 1 h · frais ${FEE} % par côté`);
  console.log(`CHOIX : ${iso(first.t)} → ${SPLIT} (achat-conservation ${usd(holdTrain)})`);
  console.log(`VÉRIF : ${SPLIT} → ${iso(last.t)} (achat-conservation ${usd(holdTest)})\n`);

  const rows = [];
  for (const base of STRATEGIES) {
    if (base.id === 'hold' || base.scalp) continue; // le scalp a son propre banc d'essai (scalp.js)
    for (const tf of base.onlyTf || ['1h', '6h', '1d']) {
      const s = withTf(base, tf);
      const candles = series[tf];
      const barSec = TF_SEC[tf];
      const cut = candles.findIndex((c) => c.t >= split);
      const opts = { size: SIZE, feePct: FEE, daily, barSec, fx };
      const train = backtest(s, candles.slice(0, cut), opts);
      const test = backtest(s, candles, { ...opts, from: cut });
      const ys = Object.entries(yearly(train.list));
      const posYears = ys.filter(([, v]) => v > 0).length / Math.max(1, ys.length);
      const selected = train.pnlUsd > 0 && (train.profitFactor || 0) >= 1.15 && train.trades >= 20 && posYears >= 0.6;
      rows.push({
        s, tf, train, test, posYears, selected,
        expTrain: exposure(train.list, first.t, split),
        expTest: exposure(test.list, split, last.t),
        years: yearly([...train.list, ...test.list]),
      });
    }
  }

  rows.sort((a, b) => b.train.pnlUsd - a.train.pnlUsd);
  const allYears = [...new Set(rows.flatMap((r) => Object.keys(r.years)))].sort();
  const pf = (r) => (r.profitFactor ? r.profitFactor.toFixed(2) : ' -  ');
  console.log(
    'SÉL  STRATÉGIE'.padEnd(52) + 'TF  ' + 'CHOIX: PnL   PF  trades expo'.padEnd(31) + '| VÉRIF: PnL   PF  trades | ' + allYears.join('   '),
  );
  for (const r of rows) {
    console.log(
      (r.selected ? ' ✔   ' : '     ') +
        (r.s.name.replace(/ \[.*\]$/, '')).slice(0, 46).padEnd(47) +
        r.tf.padEnd(4) +
        `${usd(r.train.pnlUsd).padStart(11)} ${pf(r.train)} ${String(r.train.trades).padStart(6)} ${(r.expTrain * 100).toFixed(0).padStart(3)}% | ` +
        `${usd(r.test.pnlUsd).padStart(10)} ${pf(r.test)} ${String(r.test.trades).padStart(6)} | ` +
        allYears.map((y) => usd(r.years[y] || 0).padStart(6)).join(' '),
    );
  }

  const sel = rows.filter((r) => r.selected);
  console.log(`\n${sel.length} combinaison(s) retenue(s) sur la période de choix. Leur résultat en VÉRIFICATION :`);
  for (const r of sel) {
    console.log(`  ${r.s.id}${r.tf === tfOf(r.s) ? '' : ''} [${r.tf}] : ${usd(r.test.pnlUsd)} (PF ${pf(r.test)}, ${r.test.trades} trades, exposition ${(r.expTest * 100).toFixed(0)} %)`);
  }
  console.log(`  (achat-conservation sur la même période : ${usd(holdTest)})`);
  console.log('\nPnL en $ pour 1 000 $ par trade, frais inclus. Résultats passés ≠ résultats futurs.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
