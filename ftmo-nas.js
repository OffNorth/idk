#!/usr/bin/env node
/**
 * Recherche FTMO sur le Nasdaq 100 avec les données gratuites disponibles :
 *   - journalier ^NDX depuis 1985 (40 ans) : retours à la moyenne courts « à la Connors », achat seul, dans la tendance
 *   - 1 h NQ=F sur 2 ans : mêmes idées (src/meanrev.js) en bougies 1 h
 * Chaque stratégie est testée avec son stop d'origine (3 ATR) et une version au stop serré (1,5 ATR, position plus grosse
 * pour le même risque). Juge : challenge FTMO 2 étapes, réussite en < 6 mois, risque 1 % / 1,5 % / 2 % par trade.
 * Frais 0,003 % par côté, swap 6 %/an pour les nuits passées en position. Choix avant 2010, vérification après.
 *
 *   npm run ftmo-nas
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { selectStrategies, withTf, TF_SEC } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { computeScalp2 } = require('./src/scalp2');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
const DAILY = ['ibs', 'cumrsi', 'double7', 'rsi2', 'down3', 'dip5', 'pctb', 'tom', 'tuesday', 'vixspike'];
const H1 = ['x_rsi2', 'm_ibs', 'm_bb', 'm_down3', 'm_vwap', 'm_rsi2x'];

/** Version « stop serré » : même signal, stop à k ATR (achat seul pour les stratégies journalières). */
function tight(s, k) {
  return { ...s, id: `${s.id}~${k}`, name: `${s.name} (stop ${k} ATR)`, evaluate(ind, i) { const r = s.evaluate(ind, i); return { ...r, sl: k * ind.atr[i] }; } };
}

function judge(label, trades, split) {
  const tr = trades.filter((t) => t.entryT < split);
  const te = trades.filter((t) => t.entryT >= split);
  const a = rStats(trades);
  const sa = rStats(tr);
  const sb = rStats(te);
  const w = tr.filter((t) => t.pnlPct > 0).reduce((x, t) => x + t.pnlPct, 0);
  const l = -tr.filter((t) => t.pnlPct <= 0).reduce((x, t) => x + t.pnlPct, 0);
  const sel = sa.n >= 30 && sa.expR > 0.1 && l > 0 && w / l >= 1.15;
  const cs = [1, 1.5, 2].map((risk) => challengeStats(trades, { riskPct: risk, dayStopPct: 0 }));
  const recent = [1, 1.5, 2].map((risk) => challengeStats(te, { riskPct: risk, dayStopPct: 0 }));
  const fc = (c) => (c ? `${c.passRate.toFixed(0)} %${c.medianDays ? ` ${c.medianDays.toFixed(0)}j` : ''}` : '—');
  console.log(
    (sel ? ' ✔   ' : '     ') + label.slice(0, 50).padEnd(51) +
    `${a.tradesPerMonth.toFixed(1).padStart(5)}  ${a.win.toFixed(0).padStart(4)}%  ${f2(sa.expR).padStart(7)} | ${f2(sb.expR).padStart(6)} | ` +
    cs.map(fc).map((x) => x.padEnd(11)).join(' ') + ' | ' + recent.map(fc).map((x) => x.padEnd(11)).join(' '),
  );
  return { sel, sb, cs, recent, trades };
}

(async () => {
  const nd = await cachedYahoo(CACHE, '^NDX', '1d');
  const vix = await cachedYahoo(CACHE, '^VIX', '1d');
  const split = Date.parse('2010-01-01') / 1000;
  const ind = computeAll(nd, nd, 86400, null, vix, {});
  console.log(`=== Nasdaq 100 journalier : ${iso(nd[0].t)} → ${iso(nd[nd.length - 1].t)} · choix avant 2010 · frais 0,003 % + swap 6 %/an ===`);
  console.log('SÉL  STRATÉGIE'.padEnd(56) + 'tr/mois gagn.  R choix | vérif  | réussite < 6 mois, risque 1 % · 1,5 % · 2 %   | période 2010–2026 seule');
  const kept = [];
  for (const base of selectStrategies(DAILY)) {
    for (const s of [base, tight(base, 1.5)]) {
      const r = backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind, daily: nd, vix });
      if (r.trades < 20) continue;
      const j = judge(s.name, r.list, split);
      if (j.sel && j.sb.expR > 0.05) kept.push({ s, ...j });
    }
  }

  const h = await cachedYahoo(CACHE, 'NQ=F', '1h', { range: '730d' });
  const hsplit = h[Math.floor(h.length / 2)].t;
  const hind = computeScalp2(h, 3600, 'nas100');
  console.log(`\n=== Nasdaq 1 h (NQ=F) : ${iso(h[0].t)} → ${iso(h[h.length - 1].t)} · choix avant ${iso(hsplit)} · frais 0,003 % ===`);
  for (const base of selectStrategies(H1)) {
    const s = withTf(base, '1h');
    const r = backtest(s, h, { size: 1000, feePct: 0.003, barSec: 3600, ind: hind, market: 'nas100' });
    if (r.trades < 20) continue;
    judge(s.name, r.list, hsplit);
  }

  console.log(`\nRetenues (choix) et positives en vérification : ${kept.length}`);
  for (const k of kept) console.log(`  ${k.s.id} : ${f2(k.sb.expR)} R/trade 2010–2026`);
  // Une seule version par stratégie (la meilleure en vérification), sinon les mêmes signaux compteraient deux fois
  const best = new Map();
  for (const k of kept) {
    const b = k.s.id.split('~')[0];
    if (!best.has(b) || best.get(b).sb.expR < k.sb.expR) best.set(b, k);
  }
  const uniq = [...best.values()];
  if (uniq.length > 1) {
    console.log(`\nPortefeuille : ${uniq.map((k) => k.s.id).join(' + ')}`);
    const all = uniq.flatMap((k) => k.trades);
    console.log('\nPortefeuille Nasdaq des retenues sur un même compte (1985–2026 / 2010–2026) :');
    for (const risk of [0.5, 1, 1.5]) {
      const c = challengeStats(all, { riskPct: risk });
      const cr = challengeStats(all.filter((t) => t.entryT >= split), { riskPct: risk });
      console.log(`  risque ${risk} % : réussite ${c.passRate.toFixed(0)} % (médiane ${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, échecs max ${c.failedMax}, jour ${c.failedDaily}) · 2010–2026 : ${cr.passRate.toFixed(0)} % (médiane ${cr.medianDays ? cr.medianDays.toFixed(0) : '—'} j)`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
