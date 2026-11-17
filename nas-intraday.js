#!/usr/bin/env node
/**
 * Test des 3 stratégies intraday NAS100 de la formation TradingView (module 5) :
 *   A. cassure du range d'ouverture 15 min, B. repli VWAP / EMA 20, C. chasse aux stops.
 *
 *   npm run nas-intraday
 *
 * Données : indice ^NDX en bougies 5 min sur les 60 derniers jours (limite gratuite de Yahoo Finance).
 * Première moitié = choix, seconde moitié = vérification. Plusieurs niveaux de frais par côté :
 *   0,005 % ≈ future NQ / MNQ ou CFD très serré · 0,01 % ≈ CFD NAS100 classique · 0,02 % ≈ CFD avec spread large
 */
const { fetchYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { computeIntraday } = require('./src/intraday');
const { STRATEGIES } = require('./src/strategies');

const FEES = [0, 0.005, 0.01, 0.02];
const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}$`;

(async () => {
  const candles = await fetchYahoo('^NDX', '5m', { range: '60d' });
  const hourly = await fetchYahoo('^NDX', '1h', { range: '730d' });
  const ind = computeIntraday(candles, 300, hourly);
  const days = [...new Set(ind.day)];
  const cutDay = days[Math.floor(days.length / 2)];
  const cut = ind.day.findIndex((d) => d === cutDay);
  console.log(`^NDX 5 min : ${candles.length} bougies, ${days.length} séances (${days[0]} → ${days[days.length - 1]}) · choix avant ${cutDay}, vérification après`);
  console.log(`Indice : ${candles[0].c.toFixed(0)} → ${candles[candles.length - 1].c.toFixed(0)} · 1 000 $ par trade\n`);

  for (const s of STRATEGIES.filter((x) => x.intraday)) {
    const gross = backtest(s, candles, { ind, barSec: 300, feePct: 0 });
    const n = gross.trades;
    const avg = n ? gross.list.reduce((a, t) => a + t.pnlPct, 0) / n : 0;
    const wins = gross.list.filter((t) => t.pnlPct > 0).length;
    const avgR = n
      ? gross.list.reduce((a, t) => a + (t.side === 'long' ? 1 : -1) * (t.exit - t.entry) / Math.abs(t.entry - t.initSl), 0) / n
      : 0;
    console.log(`${s.name}`);
    console.log(`  ${n} trades en ${days.length} séances · ${n ? ((wins / n) * 100).toFixed(0) : 0} % gagnants · gain moyen avant frais ${avg >= 0 ? '+' : ''}${avg.toFixed(3)} % (${avgR >= 0 ? '+' : ''}${avgR.toFixed(2)} R) par trade`);
    console.log(`  frais maximum supportables : ${(Math.max(0, avg) / 2).toFixed(4)} % par côté`);
    for (const fee of FEES.filter((f) => f > 0)) {
      const a = backtest(s, candles, { ind, barSec: 300, feePct: fee, to: cut });
      const b = backtest(s, candles, { ind, barSec: 300, feePct: fee, from: cut });
      console.log(`  frais ${String(fee).padEnd(5)} % : choix ${usd(a.pnlUsd).padStart(5)} (${a.trades} tr) · vérification ${usd(b.pnlUsd).padStart(5)} (${b.trades} tr) · total ${usd(a.pnlUsd + b.pnlUsd)}`);
    }
    console.log('');
  }
  console.log('⚠️ 60 séances seulement : un échantillon trop court pour conclure. À confirmer en paper trading.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
