#!/usr/bin/env node
/**
 * Banc d'essai du SCALP (bougies 1 et 5 min, PAXG, archive Binance).
 *
 *   npm run scalp
 *
 * 5 min : sept. 2020 → oct. 2026, choix avant le 2024-07-01, vérification après.
 * 1 min : nov. 2025 → oct. 2026, choix avant le 2026-05-01, vérification après.
 *
 * Pour chaque stratégie : gain moyen par trade AVANT frais, frais maximum supportables,
 * et PnL selon plusieurs niveaux de frais (par côté) :
 *   0,005 % ≈ compte ECN XAU/USD (spread serré + commission)
 *   0,01 %  ≈ broker CFD classique
 *   0,05 %  ≈ PAXG sur un exchange crypto
 */
const path = require('path');
const { loadKlines } = require('./src/history');
const { backtest } = require('./src/gold');
const { computeScalp } = require('./src/indicators');
const { STRATEGIES, withTf, TF_SEC } = require('./src/strategies');

const FEES = [0, 0.005, 0.01, 0.05];
const SIZE = 1000;
const CACHE = path.join(__dirname, 'data', 'research');

const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}$`;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

(async () => {
  console.log('Chargement des bougies 5 min et 1 min (archive Binance, mise en cache)…');
  const datasets = [
    { tf: '5m', candles: await loadKlines(CACHE, { interval: '5m', log: console.log }), split: '2024-07-01' },
    { tf: '1m', candles: await loadKlines(CACHE, { interval: '1m', from: '2025-11', log: console.log }), split: '2026-05-01' },
  ];

  const summary = [];
  for (const { tf, candles, split } of datasets) {
    const cut = candles.findIndex((c) => c.t >= Date.parse(split) / 1000);
    const years = (candles[candles.length - 1].t - candles[0].t) / (365 * 86400);
    console.log(`\n=== Bougies ${tf} : ${candles.length} (${iso(candles[0].t)} → ${iso(candles[candles.length - 1].t)}) · choix avant ${split} ===`);
    const ind = computeScalp(candles, TF_SEC[tf]);
    console.log(
      'STRATÉGIE'.padEnd(46) +
        'trades/an  brut/trade  frais max | ' +
        FEES.filter((f) => f > 0).map((f) => `frais ${f}% : choix / vérif`.padEnd(28)).join(' | '),
    );
    for (const base of STRATEGIES.filter((s) => s.scalp && !s.scalp2)) { // 2e série : scalp2.js
      const s = withTf(base, tf);
      const run = (fee, range) => backtest(s, candles, { size: SIZE, feePct: fee, barSec: TF_SEC[tf], ind, ...range });
      const gross = run(0, {});
      const avgGross = gross.trades ? gross.list.reduce((a, t) => a + t.pnlPct, 0) / gross.trades : 0;
      const cells = FEES.filter((f) => f > 0).map((fee) => {
        const tr = run(fee, { to: cut });
        const te = run(fee, { from: cut });
        return `${usd(tr.pnlUsd).padStart(9)} / ${usd(te.pnlUsd).padStart(8)}`.padEnd(28);
      });
      console.log(
        base.name.slice(0, 44).padEnd(46) +
          `${(gross.trades / years).toFixed(0).padStart(9)}  ${(avgGross >= 0 ? '+' : '') + avgGross.toFixed(4)}%   ${(Math.max(0, avgGross) / 2).toFixed(4)}% | ` +
          cells.join(' | '),
      );
      summary.push({ id: base.id, tf, avgGross, tradesPerYear: gross.trades / years });
    }
  }

  console.log('\n« brut/trade » = gain moyen par trade AVANT frais. « frais max » = frais par côté qui ramènent ce gain à zéro.');
  console.log('Une stratégie de scalp n’est viable que si ses frais réels sont nettement inférieurs à « frais max ».');
  const viable = summary.filter((r) => r.avgGross / 2 > 0.01);
  console.log(
    viable.length
      ? `Supportent plus de 0,01 % de frais par côté : ${viable.map((r) => `${r.id}@${r.tf}`).join(', ')}`
      : 'Aucune stratégie ne supporte 0,01 % de frais par côté (≈ broker CFD classique).',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
