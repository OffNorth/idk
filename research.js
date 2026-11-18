#!/usr/bin/env node
/**
 * Banc d'essai : toutes les stratégies × toutes les unités de temps (1 h, 6 h, 1 j),
 * avec séparation CHOIX / VÉRIFICATION pour éviter de se tromper soi-même.
 *
 *   npm run research                      → or (PAXG, archive Binance, ~6 ans), frais 0,05 %
 *   npm run research -- 0.1               → or, frais 0,1 % par côté
 *   npm run research -- 0.05 2023-07-01   → or, autre date de coupure
 *   npm run research -- nas100            → Nasdaq 100 (journalier depuis 1985, 1 h sur ~2 ans), frais 0,01 %
 *   npm run research -- nas100 0.02
 *
 * Règle de sélection fixée AVANT de regarder la vérification (période de choix uniquement) :
 *   PnL > 0, profit factor ≥ 1,15, au moins 20 trades, et positive au moins 60 % des années.
 */
const path = require('path');
const { loadHourly, aggregate } = require('./src/history');
const { cachedYahoo } = require('./src/yahoo');
const { loadAux } = require('./src/aux');
const { backtest } = require('./src/gold');
const { STRATEGIES, withTf, tfOf, TF_SEC } = require('./src/strategies');

const CACHE = path.join(__dirname, 'data', 'research');

/** Marchés disponibles : données, frais par défaut, dates de coupure choix / vérification. */
const MARKETS = {
  gold: {
    name: 'Or (PAXG)',
    fee: 0.05,
    splits: { '1h': '2024-07-01', '6h': '2024-07-01', '1d': '2024-07-01' },
    exclude: [],
    async load() {
      const hourly = await loadHourly(CACHE, { log: console.log });
      const fx = aggregate(await loadHourly(CACHE, { log: console.log, symbol: 'EURUSDT' }), TF_SEC['1d']);
      const daily = aggregate(hourly, TF_SEC['1d']);
      const aux = await loadAux(CACHE, 'gold');
      return { series: { '1h': hourly, '6h': aggregate(hourly, TF_SEC['6h']), '1d': daily }, daily, fx, vix: await cachedYahoo(CACHE, '^VIX', '1d'), aux };
    },
  },
  goldlong: {
    name: 'Or long terme (future GC=F, journalier depuis 2000)',
    fee: 0.05,
    tfs: ['1d'],
    splits: { '1d': '2016-01-01' },
    exclude: [],
    market: 'gold',
    async load() {
      const d = await cachedYahoo(CACHE, 'GC=F', '1d');
      const aux = await loadAux(CACHE, 'gold');
      return { series: { '1d': d }, daily: d, fx: await cachedYahoo(CACHE, 'EURUSD=X', '1d'), vix: await cachedYahoo(CACHE, '^VIX', '1d'), aux };
    },
  },
  nas100: {
    name: 'Nasdaq 100',
    fee: 0.01, // CFD NAS100 : spread ~1–2 points sur ~20 000
    splits: { '1h': '2025-08-01', '6h': '2025-08-01', '1d': '2010-01-01' },
    exclude: ['dollar'], // pas de données EUR/USD avant 2020
    async load() {
      const daily = await cachedYahoo(CACHE, '^NDX', '1d');
      const hourly = await cachedYahoo(CACHE, 'NQ=F', '1h', { range: '730d' });
      const vix = await cachedYahoo(CACHE, '^VIX', '1d');
      const aux = await loadAux(CACHE, 'nas100');
      return { series: { '1h': hourly, '6h': aggregate(hourly, TF_SEC['6h']), '1d': daily }, daily, fx: null, vix, aux };
    },
  },
};

const args = process.argv.slice(2);
const MARKET = args[0] && MARKETS[args[0]] ? args.shift() : 'gold';
const M = MARKETS[MARKET];
const FEE = Number(args[0]) || M.fee;
const SPLITS = args[1] ? { '1h': args[1], '6h': args[1], '1d': args[1] } : M.splits;
const SIZE = 1000;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; // ex. ONLY=golden,trendmix

const usd = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}$`;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/** Gains par période : par année, ou par tranche de 5 ans si l'historique est long. */
function buckets(list, step) {
  const by = {};
  for (const t of list) {
    const y = new Date(t.exitT * 1000).getUTCFullYear();
    const k = step > 1 ? Math.floor(y / step) * step : y;
    by[k] = (by[k] || 0) + t.pnlUsd;
  }
  return by;
}

function exposure(list, from, to) {
  const inMarket = list.reduce((s, t) => s + Math.max(0, Math.min(t.exitT, to) - Math.max(t.entryT, from)), 0);
  return inMarket / (to - from);
}

(async () => {
  console.log(`Chargement des données : ${M.name}…`);
  const { series, daily, fx, vix = null, aux = {} } = await M.load();
  const step = (series['1d'][series['1d'].length - 1].t - series['1d'][0].t) / (365 * 86400) > 15 ? 5 : 1;

  console.log(`\n${M.name} · frais ${FEE} % par côté · 1 000 $ par trade`);
  const hold = {};
  for (const tf of M.tfs || ['1h', '6h', '1d']) {
    const c = series[tf];
    const split = Date.parse(SPLITS[tf]) / 1000;
    const k = c.findIndex((x) => x.t >= split);
    hold[tf] = { train: SIZE * (c[k].c / c[0].c - 1), test: SIZE * (c[c.length - 1].c / c[k].c - 1) };
    console.log(
      `  ${tf} : ${c.length} bougies, ${iso(c[0].t)} → ${iso(c[c.length - 1].t)} · CHOIX avant ${SPLITS[tf]} ` +
        `(achat-conservation ${usd(hold[tf].train)}) · VÉRIF après (achat-conservation ${usd(hold[tf].test)})`,
    );
  }
  console.log('');

  const rows = [];
  for (const base of STRATEGIES) {
    if (base.id === 'hold' || base.scalp || M.exclude.includes(base.id)) continue; // scalp : voir scalp.js
    if (base.markets && !base.markets.includes(M.market || MARKET)) continue; // stratégie propre à un autre marché
    if (base.intraday) continue; // intraday : voir nas-intraday.js
    if (ONLY && !ONLY.includes(base.id)) continue;
    for (const tf of (base.onlyTf || ['1h', '6h', '1d']).filter((x) => !M.tfs || M.tfs.includes(x))) {
      const s = withTf(base, tf);
      const candles = series[tf];
      const barSec = TF_SEC[tf];
      const split = Date.parse(SPLITS[tf]) / 1000;
      const cut = candles.findIndex((c) => c.t >= split);
      const opts = { size: SIZE, feePct: FEE, daily, barSec, fx, vix, aux, market: M.market || MARKET };
      const train = backtest(s, candles.slice(0, cut), opts);
      const test = backtest(s, candles, { ...opts, from: cut });
      const ys = Object.entries(buckets(train.list, 1));
      const posYears = ys.filter(([, v]) => v > 0).length / Math.max(1, ys.length);
      const selected = train.pnlUsd > 0 && (train.profitFactor || 0) >= 1.15 && train.trades >= 20 && posYears >= 0.6;
      rows.push({
        s, tf, train, test, posYears, selected,
        expTrain: exposure(train.list, candles[0].t, split),
        expTest: exposure(test.list, split, candles[candles.length - 1].t),
        years: buckets([...train.list, ...test.list], step),
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
  console.log(`  (achat-conservation en vérification : 1 j ${usd(hold['1d'].test)}${hold['1h'] ? ` · 6 h / 1 h ${usd(hold['1h'].test)}` : ''})`);
  console.log('\nPnL en $ pour 1 000 $ par trade, frais inclus. Résultats passés ≠ résultats futurs.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
