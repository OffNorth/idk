#!/usr/bin/env node
/**
 * Backtest des stratégies or sur l'historique 1 h (PAXG/USD, Coinbase).
 *   npm run backtest          → 90 jours
 *   npm run backtest -- 180   → 180 jours
 */
const cfg = require('./src/config');
const { backtest, fetchHistory } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');

(async () => {
  const days = Number(process.argv[2]) || 90;
  const candles = await fetchHistory(days);
  if (candles.length < 250) throw new Error(`Historique insuffisant (${candles.length} bougies)`);
  const first = candles[0];
  const last = candles[candles.length - 1];
  const buyHold = (last.c / first.c - 1) * 100;
  console.log(
    `Or (PAXG/USD) 1 h · ${candles.length} bougies · ${new Date(first.t * 1000).toISOString().slice(0, 10)} → ` +
      `${new Date(last.t * 1000).toISOString().slice(0, 10)} · $${first.c.toFixed(0)} → $${last.c.toFixed(0)} ` +
      `(achat-conservation ${buyHold >= 0 ? '+' : ''}${buyHold.toFixed(1)} %)`,
  );
  console.log(`Taille $${cfg.goldSizeUsd} par trade · frais ${cfg.goldFeePct} % par côté\n`);
  console.log('STRATÉGIE                                TRADES  GAGNANTS   PnL $     PnL %   PF    DD max');
  for (const s of selectStrategies(cfg.goldStrategies)) {
    const r = backtest(s, candles, { size: cfg.goldSizeUsd, feePct: cfg.goldFeePct });
    console.log(
      [
        s.name.padEnd(40),
        String(r.trades).padStart(6),
        `${r.winRate.toFixed(0)}%`.padStart(9),
        `${r.pnlUsd >= 0 ? '+' : ''}${r.pnlUsd.toFixed(2)}`.padStart(9),
        `${((r.pnlUsd / cfg.goldSizeUsd) * 100).toFixed(1)}%`.padStart(8),
        (r.profitFactor === null ? '-' : r.profitFactor.toFixed(2)).padStart(5),
        `$${r.maxDrawdown.toFixed(0)}`.padStart(8),
      ].join(' '),
    );
  }
  console.log('\nPF = profit factor (gains / pertes, > 1 = rentable). Résultats passés ≠ résultats futurs.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
