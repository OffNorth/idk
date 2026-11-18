#!/usr/bin/env node
/**
 * L'effet de nuit du Nasdaq 100 jugé comme un challenge FTMO, sur 25 ans (^NDX journalier : clôture → ouverture suivante).
 * Chaque nuit = un trade : entrée à la clôture, sortie à l'ouverture. Le stop (X %) ne sert qu'à dimensionner la position
 * (taille = risque ÷ X %) ; une ouverture en gap sous le stop sort au prix d'ouverture (perte plus grande que prévu).
 * Coûts : 0,003 % par côté + financement CFD 6 %/an (1 nuit, 3 le week-end).
 * Filtres testés : aucun, prix > moyenne 200 jours, prix > moyenne 20 jours, VIX < 25.
 * Choix 2000–2015, vérification 2016–2026.
 *
 *   npm run ftmo-night
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { sma } = require('./src/indicators');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const SPLIT = Date.parse('2016-01-01') / 1000;
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

(async () => {
  const nd = (await cachedYahoo(CACHE, '^NDX', '1d')).filter((c) => c.t >= Date.parse('2000-01-01') / 1000 && c.o && c.o !== c.c);
  const vix = await cachedYahoo(CACHE, '^VIX', '1d');
  const vixAt = new Map(vix.map((v) => [v.t, v.c]));
  const closes = nd.map((c) => c.c);
  const s200 = sma(closes, 200);
  const s20 = sma(closes, 20);
  const FILTERS = {
    'aucun filtre': () => true,
    'prix > moyenne 200 j': (i) => s200[i] !== null && closes[i] > s200[i],
    'prix > moyenne 20 j': (i) => s20[i] !== null && closes[i] > s20[i],
    'VIX < 25': (i) => (vixAt.get(nd[i].t) ?? 99) < 25,
  };
  console.log(`=== Effet de nuit ^NDX : ${new Date(nd[0].t * 1000).toISOString().slice(0, 10)} → aujourd'hui · choix 2000–2015, vérification 2016–2026 ===`);
  console.log('FILTRE / STOP'.padEnd(34) + 'nuits/mois  gagn.  R choix | vérif | FTMO < 6 mois risque 1 % · 1,5 % · 2 % (tout) | 2016–2026 à 1,5 %');
  const best = [];
  for (const [fname, ok] of Object.entries(FILTERS)) {
    for (const stop of [1, 1.5, 2]) {
      const trades = [];
      for (let i = 1; i < nd.length - 1; i++) {
        if (!ok(i)) continue;
        const a = nd[i];
        const b = nd[i + 1];
        const nights = Math.max(1, Math.round((b.t - a.t) / 86400));
        const raw = (b.o / a.c - 1) * 100;
        const pnlPct = raw - 0.006 - (6 * nights) / 365;
        trades.push({ entryT: a.t + 20 * 3600, exitT: b.t + 14.5 * 3600, entry: a.c, initSl: a.c * (1 - stop / 100), pnlPct, worstPct: Math.min(0, raw) });
      }
      const tr = trades.filter((t) => t.entryT < SPLIT);
      const te = trades.filter((t) => t.entryT >= SPLIT);
      const cs = [1, 1.5, 2].map((r) => challengeStats(trades, { riskPct: r, dayStopPct: 0 }));
      const cr = challengeStats(te, { riskPct: 1.5, dayStopPct: 0 });
      const st = rStats(trades);
      console.log(
        `${fname}, stop ${stop} %`.padEnd(34) +
        `${st.tradesPerMonth.toFixed(1).padStart(8)}  ${st.win.toFixed(0).padStart(4)}%  ${f2(rStats(tr).expR).padStart(6)} | ${f2(rStats(te).expR).padStart(5)} | ` +
        cs.map((c) => `${c.passRate.toFixed(0)} % ${c.medianDays ? `(${c.medianDays.toFixed(0)} j)` : ''}`.padEnd(13)).join(' ') + ` | ${cr.passRate.toFixed(0)} % ${cr.medianDays ? `(${cr.medianDays.toFixed(0)} j)` : ''}`,
      );
      best.push({ fname, stop, cs, cr, choiceR: rStats(tr).expR, verifR: rStats(te).expR });
    }
  }
  // Choix sur 2000–2015 uniquement : meilleure espérance en R, puis on regarde la vérification
  const pick = best.reduce((a, b) => (b.choiceR > a.choiceR ? b : a));
  console.log(`\nChoisi sur 2000–2015 (meilleure espérance) : ${pick.fname}, stop ${pick.stop} % → vérification 2016–2026 : ${f2(pick.verifR)} R par nuit, FTMO à 1,5 % : ${pick.cr.passRate.toFixed(0)} % de réussite`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
