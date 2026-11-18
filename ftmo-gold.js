#!/usr/bin/env node
/**
 * Nouvelles stratégies pour l'or (retour à la moyenne dans la tendance, src/meanrev.js) jugées comme un challenge FTMO,
 * puis comparaison du portefeuille actuel (x_rsi2, m_bb@5m, m_ibs, m_rsi2x) avec le portefeuille élargi.
 *
 *   npm run ftmo-gold
 *
 * PAXG 5 et 15 min, sept. 2020 → aujourd'hui (archive Binance), frais 0,005 % par côté. Choix avant le 1er juillet 2024
 * (≥ 30 trades, espérance > 0,1 R, profit factor ≥ 1,15), vérification après (> 0,03 R par trade).
 */
const path = require('path');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, withTf, TF_SEC } = require('./src/strategies');
const { computeScalp2 } = require('./src/scalp2');
const { challengeStats, rStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const NEW = (process.env.ONLY || 'm_wr,m_keltner,m_cci,m_stoch,m_2ll,m_vwap,m_down3').split(',');
const CURRENT = { '5m': ['x_rsi2', 'm_bb'], '15m': ['m_ibs', 'm_rsi2x'] };
const SPLIT = Date.parse('2024-07-01') / 1000;
const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

(async () => {
  const g5 = await loadKlines(CACHE, { interval: '5m' });
  const data = { '5m': g5, '15m': aggregate(g5, 900, 300) };
  const trades = {};
  const kept = [];
  for (const tf of ['5m', '15m']) {
    const c = data[tf];
    const ind = computeScalp2(c, TF_SEC[tf], 'gold');
    console.log(`\n=== Or ${tf} (PAXG) · choix avant 2024-07-01 · frais 0,005 % ===`);
    console.log('SÉL  STRATÉGIE'.padEnd(56) + 'tr/mois gagn.  R choix | vérif | réussite FTMO < 6 mois à 1 % (tout / récent)');
    for (const base of selectStrategies([...new Set([...NEW, ...CURRENT[tf]])])) {
      const s = withTf(base, tf);
      const r = backtest(s, c, { size: 1000, feePct: 0.005, barSec: TF_SEC[tf], ind, market: 'gold' });
      const list = r.list;
      trades[s.id] = list;
      if (list.length < 30) continue;
      const tr = list.filter((t) => t.entryT < SPLIT);
      const te = list.filter((t) => t.entryT >= SPLIT);
      const a = rStats(list);
      const sa = rStats(tr);
      const sb = rStats(te);
      const w = tr.filter((t) => t.pnlPct > 0).reduce((x, t) => x + t.pnlPct, 0);
      const l = -tr.filter((t) => t.pnlPct <= 0).reduce((x, t) => x + t.pnlPct, 0);
      const sel = sa.n >= 30 && sa.expR > 0.1 && l > 0 && w / l >= 1.15;
      const c1 = challengeStats(list, { riskPct: 1, dayStopPct: 2 });
      const cr = challengeStats(te, { riskPct: 1, dayStopPct: 2 });
      const isNew = !CURRENT[tf].includes(base.id);
      console.log(
        (sel ? ' ✔   ' : '     ') + `${base.name}${isNew ? '' : ' (déjà active)'}`.slice(0, 50).padEnd(51) +
        `${a.tradesPerMonth.toFixed(0).padStart(5)}  ${a.win.toFixed(0).padStart(4)}%  ${f2(sa.expR).padStart(6)} | ${f2(sb.expR).padStart(5)} | ${c1.passRate.toFixed(0)} % (${c1.medianDays ? c1.medianDays.toFixed(0) : '—'} j) / ${cr.passRate.toFixed(0)} % (${cr.medianDays ? cr.medianDays.toFixed(0) : '—'} j)`,
      );
      if (isNew && sel && sb.expR > 0.03) kept.push(s.id);
    }
  }

  console.log(`\nNouvelles retenues (choix + vérification) : ${kept.length ? kept.join(', ') : 'aucune'}`);
  const current = ['x_rsi2', 'm_bb@5m', 'm_ibs', 'm_rsi2x'];
  const port = (ids) => ids.flatMap((id) => trades[id] || []);
  const show = (label, ids) => {
    for (const risk of [0.5, 0.75]) {
      const all = port(ids);
      const c = challengeStats(all, { riskPct: risk, dayStopPct: 2 });
      const cr = challengeStats(all.filter((t) => t.entryT >= SPLIT), { riskPct: risk, dayStopPct: 2 });
      console.log(`  ${label.padEnd(36)} risque ${risk} % : ${c.passRate.toFixed(0)} % (médiane ${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, échecs jour ${c.failedDaily} · max ${c.failedMax}) · récent ${cr.passRate.toFixed(0)} % (${cr.medianDays ? cr.medianDays.toFixed(0) : '—'} j)`);
    }
  };
  console.log('\nPortefeuille sur un seul compte FTMO :');
  show('actuel (4 stratégies)', current);
  if (kept.length) show(`actuel + ${kept.length} nouvelle(s)`, [...current, ...kept]);
  for (const id of kept) show(`actuel + ${id}`, [...current, id]);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
