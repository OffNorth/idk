#!/usr/bin/env node
/**
 * Banc d'essai « compte FTMO » : chaque stratégie est jugée comme sur un challenge FTMO en 2 étapes
 * (+10 % puis +5 %, perte du jour max 5 %, perte max 10 %), avec une taille de position calculée au risque.
 *
 *   npm run ftmo                → toutes les stratégies candidates, risque 1 % et 0,5 % par trade
 *
 * Frais réalistes d'un CFD chez FTMO, par côté : or 0,005 % (écart ≈ 0,25 $ + commission), Nasdaq 0,003 % (écart ≈ 1,5 point).
 * Financement de nuit (swap) pour les positions gardées plusieurs jours : or 4 %/an, Nasdaq 6 %/an.
 * Choix / vérification : la sélection se fait sur la 1re période (espérance > 0,1 R, PF ≥ 1,15, ≥ 30 trades),
 * la 2e période ne sert qu'à vérifier.
 */
const path = require('path');
const { loadKlines, loadHourly } = require('./src/history');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { selectStrategies, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const f1 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

// Candidates : nouvelles stratégies FTMO + les meilleures existantes qui ont un stop
const CANDIDATES = {
  '1h': ['f_pullback', 'f_pdbreak', 'f_nightbreak'],
  '1d': ['f_insideday', 'f_nr7', 'f_weekbreak', 'golden', 'trendmix', 'mom12_1', 'season', 'macro', 'sma200'],
  '5m': ['x_rsi2'],
};

(async () => {
  console.log('Chargement des données…');
  const sets = [
    { name: 'Or 1 h (PAXG 2020–2026)', market: 'gold', tf: '1h', fee: 0.005, fin: 0, split: '2024-07-01', candles: await loadHourly(CACHE) },
    { name: 'Or 1 jour (GC=F 2000–2026)', market: 'gold', tf: '1d', fee: 0.005, fin: 4, split: '2016-01-01', candles: await cachedYahoo(CACHE, 'GC=F', '1d') },
    { name: 'Or 5 min (PAXG 2020–2026)', market: 'gold', tf: '5m', fee: 0.005, fin: 0, split: '2024-07-01', candles: await loadKlines(CACHE, { interval: '5m' }) },
    { name: 'Nasdaq 1 h (NQ=F, 2 ans)', market: 'nas100', tf: '1h', fee: 0.003, fin: 0, candles: await cachedYahoo(CACHE, 'NQ=F', '1h', { range: '730d' }) },
    { name: 'Nasdaq 1 jour (^NDX 1985–2026)', market: 'nas100', tf: '1d', fee: 0.003, fin: 6, split: '2010-01-01', candles: await cachedYahoo(CACHE, '^NDX', '1d') },
  ];
  const vix = await cachedYahoo(CACHE, '^VIX', '1d');
  const tnx = await cachedYahoo(CACHE, '^TNX', '1d');

  const kept = [];
  for (const set of sets) {
    const { candles, tf } = set;
    const split = set.split ? Date.parse(set.split) / 1000 : candles[Math.floor(candles.length / 2)].t;
    console.log(`\n=== ${set.name} : ${iso(candles[0].t)} → ${iso(candles[candles.length - 1].t)} · choix avant ${iso(split)} · frais ${set.fee} %/côté${set.fin ? ` · swap ${set.fin} %/an` : ''} ===`);
    console.log('SÉL  STRATÉGIE'.padEnd(52) + 'trades/mois  gagn.  R/trade choix | vérif   pire série  R/mois | FTMO réussite en < 6 mois · risque 1 % (+ stop du jour à −2 %) | 0,5 %');
    const ind = tf === '1d' ? computeAll(candles, candles, 86400, null, vix, { tnx }) : null;
    for (const s of selectStrategies(CANDIDATES[tf])) {
      if (s.markets && !s.markets.includes(set.market)) continue;
      const r = backtest(s, candles, { size: 1000, feePct: set.fee, financingPct: set.fin, barSec: TF_SEC[tf], daily: tf === '1d' ? candles : null, vix, aux: { tnx }, market: set.market, ...(ind && !s.compute ? { ind } : {}) });
      const trades = r.list.filter((t) => (t.initSl ?? t.sl) && t.entry);
      if (trades.length < 5) { console.log(`     ${s.name.slice(0, 46).padEnd(47)}trop peu de trades (${trades.length})`); continue; }
      const tr = trades.filter((t) => t.entryT < split);
      const te = trades.filter((t) => t.entryT >= split);
      const a = rStats(trades);
      const sa = rStats(tr);
      const sb = rStats(te);
      const pf = (() => { const w = tr.filter((t) => t.pnlPct > 0).reduce((x, t) => x + t.pnlPct, 0); const l = -tr.filter((t) => t.pnlPct <= 0).reduce((x, t) => x + t.pnlPct, 0); return l ? w / l : 0; })();
      const sel = sa.n >= 30 && sa.expR > 0.1 && pf >= 1.15;
      const c1 = challengeStats(trades, { riskPct: 1, dayStopPct: 2 });
      const c05 = challengeStats(trades, { riskPct: 0.5, dayStopPct: 2 });
      const fmtC = (c) => (c ? `${c.passRate.toFixed(0).padStart(3)} %, ${c.medianDays ? `${c.medianDays.toFixed(0)} j` : '—'}`.padEnd(14) : '—');
      console.log(
        (sel ? ' ✔   ' : '     ') + s.name.slice(0, 46).padEnd(47) +
        `${a.tradesPerMonth.toFixed(1).padStart(8)}  ${a.win.toFixed(0).padStart(4)}%  ${f1(sa.expR).padStart(9)} | ${f1(sb.expR).padStart(6)}  ${String(a.worstRun).padStart(7)}  ${f1(a.rPerMonth).padStart(7)} | ${fmtC(c1)} (échecs : jour ${c1.failedDaily}, max ${c1.failedMax}) | ${fmtC(c05)}`,
      );
      if (sel && sb.expR > 0) kept.push({ set, s, trades, sb });
    }
  }

  console.log(`\nRetenues (choix) et positives en vérification : ${kept.length}`);
  for (const k of kept) console.log(`  ${k.set.name} · ${k.s.id} : ${f1(k.sb.expR)} R/trade en vérification, ${k.sb.n} trades`);

  // Portefeuille : toutes les retenues sur un seul compte FTMO
  if (kept.length > 1) {
    const all = kept.flatMap((k) => k.trades).sort((x, y) => x.entryT - y.entryT);
    const from = Math.max(...kept.map((k) => k.trades[0].entryT)); // période commune
    const common = all.filter((t) => t.entryT >= from);
    console.log(`\nPortefeuille des ${kept.length} retenues sur un même compte (depuis ${iso(from)}, ${common.length} trades) :`);
    for (const risk of [0.25, 0.5, 1]) {
      const c = challengeStats(common, { riskPct: risk, start: from, dayStopPct: 2 });
      const st = rStats(common);
      console.log(`  risque ${risk} % par trade : réussite ${c.passRate.toFixed(0)} % (${c.passed} / ${c.tries - c.unfinished}), durée médiane ${c.medianDays ? c.medianDays.toFixed(0) : '—'} jours, échecs perte du jour ${c.failedDaily} · perte max ${c.failedMax} · ${f1(st.rPerMonth * risk)} %/mois en moyenne`);
    }
  }
  // Période récente seule (vérification) pour les retenues
  console.log('\nPériode de vérification seule (risque 1 %, stop du jour −2 %) :');
  for (const k of kept) {
    const split = k.set.split ? Date.parse(k.set.split) / 1000 : k.trades[Math.floor(k.trades.length / 2)].entryT;
    const c = challengeStats(k.trades.filter((t) => t.entryT >= split), { riskPct: 1, dayStopPct: 2 });
    if (c) console.log(`  ${k.set.name} · ${k.s.id} : réussite ${c.passRate.toFixed(0)} % des départs (${c.passed} / ${c.tries}), durée médiane ${c.medianDays ? c.medianDays.toFixed(0) + ' j' : '—'}, échecs jour ${c.failedDaily} · max ${c.failedMax}`);
  }
  console.log('\nR = multiple du risque pris (1 R = la perte si le stop est touché). Réussite = étapes 1 (+10 %) ET 2 (+5 %) réussies,');
  console.log('challenges lancés chaque semaine sur toute la période. Simulation : pas un conseil, résultats passés ≠ futurs.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
