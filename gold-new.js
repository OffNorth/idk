#!/usr/bin/env node
/**
 * Banc d'essai des nouvelles stratégies or (src/gold2.js).
 *   - journalières : future GC=F 2000–2026, choix avant 2016, vérification après ; frais 0,05 % par côté (comme les
 *     autres stratégies journalières de l'or)
 *   - g_asia : PAXG 5 min 2020–2026, choix avant juillet 2024, frais 0,005 % (CFD), juge FTMO + portefeuille FTMO or
 *
 *   npm run gold-new
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { loadKlines } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, withTf } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { computeScalp2 } = require('./src/scalp2');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
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
  const ok = sa.n >= 20 && sa.expR > 0.05 && l > 0 && w / l >= 1.15 && sb.expR > 0;
  console.log(
    (ok ? ' ✔   ' : '     ') + name.padEnd(46) +
    `${a.tradesPerMonth.toFixed(1).padStart(5)} tr/mois  ${a.win.toFixed(0)} % gagn. · choix ${f2(sum(tr))} % (${f2(sa.expR)} R) · vérif ${f2(sum(te))} % (${f2(sb.expR)} R)`,
  );
  return ok;
}

(async () => {
  const kept = [];
  const g = await cachedYahoo(CACHE, 'GC=F', '1d');
  const aux = { tnx: await cachedYahoo(CACHE, '^TNX', '1d'), dxy: await cachedYahoo(CACHE, 'DX-Y.NYB', '1d'), silver: await cachedYahoo(CACHE, 'SI=F', '1d') };
  const split = Date.parse('2016-01-01') / 1000;
  const ind = computeAll(g, g, 86400, null, null, aux);
  console.log('=== Or journalier (GC=F 2000–2026) · choix avant 2016 · frais 0,05 % ===');
  for (const s of selectStrategies(['g_low10', 'g_weekrev', 'g_yieldfall', 'g_dollarfall', 'g_silverlead'])) {
    const r = backtest(s, g, { size: 1000, feePct: 0.05, barSec: 86400, ind, daily: g, aux, market: 'gold' });
    if (report(s.name, r.list, split)) kept.push(s.id);
  }

  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const sp5 = Date.parse('2024-07-01') / 1000;
  const x5 = computeScalp2(g5, 300, 'gold');
  console.log('\n=== Or 5 min (PAXG 2020–2026) · choix avant juillet 2024 · frais 0,005 % ===');
  const s = withTf(selectStrategies(['g_asia'])[0], '5m');
  const r = backtest(s, g5, { size: 1000, feePct: 0.005, barSec: 300, ind: x5, market: 'gold' });
  const okAsia = report(s.name, r.list, sp5);
  const c = challengeStats(r.list, { riskPct: 1, dayStopPct: 2 });
  const cr = challengeStats(r.list.filter((t) => t.entryT >= sp5), { riskPct: 1, dayStopPct: 2 });
  console.log(`     FTMO seule, risque 1 % : ${c.passRate.toFixed(0)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j) · récent ${cr.passRate.toFixed(0)} %`);
  if (okAsia) {
    kept.push('g_asia');
    // Portefeuille FTMO or actuel + g_asia
    const ids = { x_rsi2: '5m', m_bb: '5m', m_keltner: '5m' };
    const { aggregate } = require('./src/history');
    const g15 = aggregate(g5, 900, 300);
    const x15 = computeScalp2(g15, 900, 'gold');
    const base = [];
    for (const [id, tf] of Object.entries(ids)) base.push(...backtest(withTf(selectStrategies([id])[0], tf), g5, { size: 1000, feePct: 0.005, barSec: 300, ind: x5, market: 'gold' }).list);
    for (const id of ['m_ibs', 'm_rsi2x']) base.push(...backtest(withTf(selectStrategies([id])[0], '15m'), g15, { size: 1000, feePct: 0.005, barSec: 900, ind: x15, market: 'gold' }).list);
    for (const [label, list] of [['portefeuille FTMO or actuel', base], ['+ séance asiatique', [...base, ...r.list]]]) {
      const a = challengeStats(list, { riskPct: 0.5, dayStopPct: 2 });
      const b = challengeStats(list.filter((t) => t.entryT >= sp5), { riskPct: 0.5, dayStopPct: 2 });
      console.log(`     ${label.padEnd(30)} risque 0,5 % : ${a.passRate.toFixed(0)} % (${a.medianDays ? a.medianDays.toFixed(0) : '—'} j) · récent ${b.passRate.toFixed(0)} % (${b.medianDays ? b.medianDays.toFixed(0) : '—'} j)`);
    }
  }
  console.log(`\nRetenues : ${kept.length ? kept.join(', ') : 'aucune'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
