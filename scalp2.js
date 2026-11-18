#!/usr/bin/env node
/**
 * Banc d'essai du scalp, 2e série (src/scalp2.js) : or et Nasdaq 100, bougies 1 et 5 min.
 *
 *   npm run scalp2
 *
 * Données (gratuites) :
 *   Or PAXG (archive Binance)    5 min sept. 2020 → aujourd'hui, 1 min sur 12 mois — week-ends ignorés
 *   Or GC=F (future, Yahoo)      5 min sur 60 jours, 1 min sur ~30 jours
 *   Nasdaq NQ=F (future, Yahoo)  5 min sur 60 jours, 1 min sur ~30 jours (Yahoo ne donne pas plus en intraday)
 *
 * Frais par côté testés : 0 (avant frais), 0,002 %, 0,004 %, 0,01 %.
 *   Or (XAU/USD compte ECN ≈ 0,2 $ d'écart + commission) ≈ 0,004 % par côté ; Nasdaq (NAS100 / NQ) ≈ 0,002–0,003 %.
 * Règle de sélection fixée avant de voir la vérification, aux frais réalistes du marché :
 *   au moins 30 trades, PnL > 0 et profit factor ≥ 1,15 sur la période de CHOIX.
 */
const path = require('path');
const fs = require('fs');
const { loadKlines } = require('./src/history');
const { fetchYahoo, cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { SCALP2, computeScalp2 } = require('./src/scalp2');
const { withTf, TF_SEC } = require('./src/strategies');

const CACHE = path.join(__dirname, 'data', 'research');
const FEES = [0, 0.002, 0.004, 0.01];
const SIZE = 1000;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}$`;

/** Bougies 1 min Yahoo sur ~30 jours (morceaux de 7 jours), mises en cache 12 h. */
async function yahoo1m(symbol) {
  const file = path.join(CACHE, `yahoo-${symbol.replace(/[^A-Za-z0-9]/g, '_')}-1m-30d.json`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 12 * 3_600_000) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const out = new Map();
  for (let k = 4; k >= 0; k--) {
    const p2 = now - k * 6 * 86400;
    const p1 = Math.max(now - 29 * 86400, p2 - 7 * 86400);
    try {
      for (const c of await fetchYahoo(symbol, '1m', { period1: p1, period2: p2 })) out.set(c.t, c);
    } catch (err) {
      console.warn(`  ${symbol} 1m ${iso(p1)} → ${iso(p2)} : ${err.message}`);
    }
  }
  const list = [...out.values()].sort((a, b) => a.t - b.t);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
  return list;
}

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const WHICH = process.argv[2] || 'all'; // all | gold | nas

(async () => {
  const sets = [];
  if (WHICH !== 'nas') {
    console.log('Chargement : or PAXG (Binance), GC=F (Yahoo)…');
    sets.push({ name: 'Or PAXG 5 min', market: 'gold', tf: '5m', fee: 0.004, candles: await loadKlines(CACHE, { interval: '5m' }), split: '2024-07-01' });
    sets.push({ name: 'Or PAXG 1 min', market: 'gold', tf: '1m', fee: 0.004, candles: await loadKlines(CACHE, { interval: '1m', from: '2025-11' }), split: '2026-05-01' });
    sets.push({ name: 'Or GC=F 5 min', market: 'gold', tf: '5m', fee: 0.004, candles: await cachedYahoo(CACHE, 'GC=F', '5m', { range: '60d' }, 12) });
    sets.push({ name: 'Or GC=F 1 min', market: 'gold', tf: '1m', fee: 0.004, candles: await yahoo1m('GC=F') });
  }
  if (WHICH !== 'gold') {
    console.log('Chargement : Nasdaq NQ=F (Yahoo)…');
    sets.push({ name: 'Nasdaq NQ=F 5 min', market: 'nas100', tf: '5m', fee: 0.003, candles: await cachedYahoo(CACHE, 'NQ=F', '5m', { range: '60d' }, 12) });
    sets.push({ name: 'Nasdaq NQ=F 1 min', market: 'nas100', tf: '1m', fee: 0.003, candles: await yahoo1m('NQ=F') });
  }

  const rows = [];
  for (const set of sets) {
    const { candles, tf } = set;
    if (!candles?.length) { console.log(`\n${set.name} : aucune donnée`); continue; }
    const split = set.split ? Date.parse(set.split) / 1000 : candles[Math.floor(candles.length / 2)].t; // sinon : moitié / moitié
    const cut = candles.findIndex((c) => c.t >= split);
    const days = new Set(candles.map((c) => Math.floor(c.t / 86400))).size * (5 / 7) || 1;
    console.log(`\n=== ${set.name} : ${candles.length} bougies, ${iso(candles[0].t)} → ${iso(candles[candles.length - 1].t)} · choix avant ${iso(split)} · frais réalistes ${set.fee} % ===`);
    console.log('SÉL  STRATÉGIE'.padEnd(50) + 'trades/j  gagn.  brut/trade | ' + FEES.slice(1).map((f) => `frais ${f}% choix / vérif`.padEnd(24)).join(' | ') + ' | PF choix / vérif (réaliste)');
    const ind = computeScalp2(candles, TF_SEC[tf], set.market);
    for (const base of SCALP2) {
      if (ONLY && !ONLY.includes(base.id)) continue;
      const s = withTf(base, tf);
      const run = (fee, range) => backtest(s, candles, { size: SIZE, feePct: fee, barSec: TF_SEC[tf], ind, ...range });
      const gross = run(0, {});
      const avg = gross.trades ? gross.list.reduce((a, t) => a + t.pnlPct, 0) / gross.trades : 0;
      const cells = FEES.slice(1).map((fee) => `${usd(run(fee, { to: cut }).pnlUsd).padStart(8)} / ${usd(run(fee, { from: cut }).pnlUsd).padStart(7)}`.padEnd(24));
      const tr = run(set.fee, { to: cut });
      const te = run(set.fee, { from: cut });
      const sel = tr.trades >= 30 && tr.pnlUsd > 0 && (tr.profitFactor || 0) >= 1.15;
      const pf = (r) => (r.profitFactor ? r.profitFactor.toFixed(2) : ' -  ');
      console.log(
        (sel ? ' ✔   ' : '     ') + base.name.slice(0, 44).padEnd(45) +
          `${(gross.trades / days).toFixed(1).padStart(7)}  ${gross.winRate.toFixed(0).padStart(4)}%  ${(avg >= 0 ? '+' : '') + avg.toFixed(4)}% | ` +
          cells.join(' | ') + ` | ${pf(tr)} / ${pf(te)}  (${tr.trades} / ${te.trades} trades)`,
      );
      rows.push({ set: set.name, id: base.id, sel, train: tr, test: te, perDay: gross.trades / days, avg });
    }
  }

  console.log('\n« brut/trade » = gain moyen par trade avant frais (en % de la position). Montants : 1 000 $ par trade, sans réinvestir.');
  const kept = rows.filter((r) => r.sel);
  console.log(`\nRetenues sur la période de choix (frais réalistes) : ${kept.length}`);
  for (const r of kept) {
    console.log(`  ${r.set} · ${r.id} : vérification ${usd(r.test.pnlUsd)} (PF ${r.test.profitFactor ? r.test.profitFactor.toFixed(2) : '-'}, ${r.test.trades} trades, ${r.perDay.toFixed(1)} trades/jour)`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
