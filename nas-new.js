#!/usr/bin/env node
/**
 * Banc d'essai des stratégies Nasdaq de src/nas2.js.
 *   - n_overnight, n_gapfill, n_firsthour : QQQ en 5 min sur 2 ans (Polygon, clé gratuite), 1re année = choix, 2e = vérification
 *   - n_preholiday : ^NDX journalier 1985–2026, choix avant 2010
 *   - en plus : l'effet de nuit mesuré sur 25 ans d'ouvertures / clôtures journalières du ^NDX
 * Frais 0,003 % par côté ; financement d'un CFD 6 %/an pour les positions gardées la nuit.
 *
 *   npm run nas-new
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, TF_SEC } = require('./src/strategies');
const { computeScalp2 } = require('./src/scalp2');
const { computeAll } = require('./src/indicators');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

function report(name, list, split) {
  const tr = list.filter((t) => t.entryT < split);
  const te = list.filter((t) => t.entryT >= split);
  const sum = (l) => l.reduce((a, t) => a + t.pnlPct, 0);
  const a = rStats(list);
  const sa = rStats(tr);
  const sb = rStats(te);
  const w = tr.filter((t) => t.pnlPct > 0).reduce((x, t) => x + t.pnlPct, 0);
  const l = -tr.filter((t) => t.pnlPct <= 0).reduce((x, t) => x + t.pnlPct, 0);
  const sel = sa.n >= 20 && sa.expR > 0.05 && l > 0 && w / l >= 1.15;
  const c = challengeStats(list, { riskPct: 1, dayStopPct: 2 });
  console.log(
    (sel && sb.expR > 0 ? ' ✔   ' : '     ') + name.padEnd(46) +
    `${a.tradesPerMonth.toFixed(1).padStart(5)} tr/mois  ${a.win.toFixed(0)} % gagn. · choix ${f2(sum(tr))} % (${f2(sa.expR)} R) · vérif ${f2(sum(te))} % (${f2(sb.expR)} R) · FTMO 1 % : ${c ? `${c.passRate.toFixed(0)} %` : '—'}`,
  );
  return sel && sb.expR > 0;
}

(async () => {
  const kept = [];
  // 1) Intraday sur QQQ 5 min
  try {
    const { polygonBars } = require('./src/polygon');
    const m1 = await polygonBars(CACHE, 'QQQ', 1, '2024-11-18');
    const c = aggregate(m1, 300, 60);
    const split = c[Math.floor(c.length / 2)].t;
    const ind = computeScalp2(c, 300, 'nas100');
    console.log(`=== QQQ 5 min (Polygon) : ${iso(c[0].t)} → ${iso(c[c.length - 1].t)} · choix avant ${iso(split)} · frais 0,003 % + 6 %/an la nuit ===`);
    for (const s of selectStrategies(['n_overnight', 'n_gapfill', 'n_firsthour'])) {
      const r = backtest(s, c, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, ind, market: 'nas100' });
      if (report(s.name, r.list, split)) kept.push(s.id);
      if (s.id === 'n_overnight') {
        const r0 = backtest(s, c, { size: 1000, feePct: 0.003, financingPct: 0, barSec: 300, ind, market: 'nas100' });
        report('  (même chose sans financement : ETF / future)', r0.list, split);
      }
    }
  } catch (err) {
    console.log(`QQQ indisponible : ${err.message}`);
  }

  // 2) Veille de jour férié sur 40 ans
  const nd = await cachedYahoo(CACHE, '^NDX', '1d');
  const split = Date.parse('2010-01-01') / 1000;
  console.log(`\n=== ^NDX journalier : ${iso(nd[0].t)} → ${iso(nd[nd.length - 1].t)} · choix avant 2010 ===`);
  const ind = computeAll(nd, nd, 86400, null, null, {});
  for (const s of selectStrategies(['n_preholiday'])) {
    const r = backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind, daily: nd });
    if (report(s.name, r.list, split)) kept.push(s.id);
  }

  // 3) L'effet de nuit sur 25 ans (ouverture / clôture journalières du ^NDX)
  console.log('\n=== Effet de nuit sur le ^NDX (rendement moyen annuel, en %) ===');
  const by = {};
  for (let i = 1; i < nd.length; i++) {
    const y = new Date(nd[i].t * 1000).getUTCFullYear();
    if (y < 2000 || !nd[i].o || nd[i].o === nd[i].c) continue;
    const b = (by[Math.floor(y / 5) * 5] ||= { night: 0, day: 0, n: 0 });
    b.night += Math.log(nd[i].o / nd[i - 1].c);
    b.day += Math.log(nd[i].c / nd[i].o);
    b.n++;
  }
  for (const [p, b] of Object.entries(by)) {
    const yrs = b.n / 252;
    console.log(`  ${p}–${+p + 4} : nuit ${f2((Math.exp(b.night / yrs) - 1) * 100)} %/an · journée ${f2((Math.exp(b.day / yrs) - 1) * 100)} %/an`);
  }
  console.log(`\nRetenues : ${kept.length ? kept.join(', ') : 'aucune'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
