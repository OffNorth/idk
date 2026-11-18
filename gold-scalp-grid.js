#!/usr/bin/env node
/**
 * Test en masse des scalps or (PAXG 5 et 15 min, sept. 2020 → aujourd'hui, archive Binance) : ~100 variantes de la famille
 * « retour à la moyenne dans la tendance 1 h » (RSI, IBS, Bollinger, Williams %R, Keltner ; achat et vente).
 * Frais 0,005 % par côté (CFD). 3 tranches de 2 ans : choix si le gain net est positif sur les tranches 1 ET 2 (≥ 100 trades),
 * vérification sur la tranche 3 (la plus récente, jamais utilisée pour choisir).
 * Comparaison avec les 6 scalps déjà actifs.
 *
 *   npm run gold-scalp-grid       (or)
 *   npm run nas-scalp-grid        (Nasdaq : QQQ 1 min Polygon nov. 2024 → nov. 2026, 3 tranches de 8 mois)
 */
const path = require('path');
const { loadKlines, aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { computeScalp2, helpers } = require('./src/scalp2');
const { rsi, ema } = require('./src/indicators');
const { selectStrategies, withTf } = require('./src/strategies');

const { active, flat, trendUp, trendDown } = helpers;
const CACHE = path.join(__dirname, 'data', 'research');
const NAS = process.argv[2] === 'nas';
const FEE = NAS ? 0.003 : 0.005; // CFD : frais par côté
const FIN = NAS ? 6 : 0; // financement annuel des nuits en position (Nasdaq)
const MK = NAS ? 'nas100' : 'gold';

(async () => {
  const g5 = NAS ? aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18'), 300, 60) : await loadKlines(CACHE, { interval: '5m' });
  const sets = { '5m': { c: g5, sec: 300 }, '15m': { c: aggregate(g5, 900, 300), sec: 900 } };
  const results = [];
  for (const [tf, d] of Object.entries(sets)) {
    const x = computeScalp2(d.c, d.sec, MK);
    const cl = x.closes;
    const R = {};
    const rs = (k) => (R[k] ||= rsi(cl, k));
    // Bandes de Bollinger à écart variable (moyenne 20, écart-type 20)
    const m20 = x.bb.mid;
    const sd = cl.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += (cl[j] - m20[i]) ** 2; return Math.sqrt(s / 20); });
    const e20 = ema(cl, 20);
    const V = [];
    const add = (fam, name, buy, sell, exitL, exitS) => V.push({ fam, name, buy, sell, exitL, exitS });
    for (const k of [2, 3, 4]) for (const lo of [3, 5, 10, 15]) for (const ex of [50, 60, 70])
      add('RSI', `RSI ${k} < ${lo}, sortie > ${ex}`, (i) => rs(k)[i] < lo, (i) => rs(k)[i] > 100 - lo, (i) => rs(k)[i] > ex, (i) => rs(k)[i] < 100 - ex);
    for (const lo of [0.1, 0.15, 0.2]) for (const ex of ['ibs', 'haut'])
      add('IBS', `IBS < ${lo} sous EMA 20, sortie ${ex === 'ibs' ? 'IBS > 0,7' : 'au-dessus du plus haut précédent'}`,
        (i) => x.ibs[i] < lo && cl[i] < e20[i], (i) => x.ibs[i] > 1 - lo && cl[i] > e20[i],
        (i) => (ex === 'ibs' ? x.ibs[i] > 0.7 : cl[i] > x.candles[i - 1].h), (i) => (ex === 'ibs' ? x.ibs[i] < 0.3 : cl[i] < x.candles[i - 1].l));
    for (const z of [1.5, 2, 2.5, 3])
      add('Bollinger', `clôture à ${z} écarts-types sous la moyenne 20`, (i) => sd[i] && cl[i] < m20[i] - z * sd[i], (i) => sd[i] && cl[i] > m20[i] + z * sd[i], (i) => cl[i] >= m20[i], (i) => cl[i] <= m20[i]);
    for (const w of [-90, -95, -98]) for (const ex of [-50, -30])
      add('Williams', `Williams %R < ${w}, sortie > ${ex}`, (i) => x.wr10[i] !== null && x.wr10[i] < w, (i) => x.wr10[i] !== null && x.wr10[i] > -100 - w, (i) => x.wr10[i] > ex, (i) => x.wr10[i] < -100 - ex);
    for (const k of [1.5, 2, 2.5, 3])
      add('Keltner', `clôture sous EMA 20 − ${k} ATR`, (i) => cl[i] < e20[i] - k * x.atr[i], (i) => cl[i] > e20[i] + k * x.atr[i], (i) => cl[i] >= e20[i], (i) => cl[i] <= e20[i]);

    const a = d.c[0].t;
    const b = d.c[d.c.length - 1].t;
    const cuts = [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity];
    for (const v of V) {
      const strat = {
        id: 'grid', tf, warmup: 700,
        evaluate(ind, i) {
          const out = { entry: null, exitLong: flat(x, i) || v.exitL(i), exitShort: flat(x, i) || v.exitS(i), sl: 1.5 * x.atr[i], tp: null };
          if (!active(x, i)) return out;
          if (trendUp(x, i) && v.buy(i)) return { ...out, entry: 'long' };
          if (trendDown(x, i) && v.sell(i)) return { ...out, entry: 'short' };
          return out;
        },
      };
      const r = backtest(strat, d.c, { size: 1000, feePct: FEE, financingPct: FIN, barSec: d.sec, ind: x });
      const parts = [0, 1, 2].map((k) => { const l = r.list.filter((t) => t.entryT >= cuts[k] && t.entryT < cuts[k + 1]); return { n: l.length, sum: l.reduce((s, t) => s + t.pnlPct, 0) }; });
      const chosen = parts[0].sum > 0 && parts[1].sum > 0 && parts[0].n + parts[1].n >= (NAS ? 40 : 100);
      results.push({ tf, v, parts, chosen, valid: chosen && parts[2].sum > 0 && parts[2].n >= (NAS ? 20 : 50) });
    }
  }
  const fams = [...new Set(results.map((r) => `${r.v.fam} ${r.tf}`))];
  console.log(`=== ${results.length} variantes de scalp ${NAS ? 'Nasdaq (QQQ, Polygon)' : 'or (PAXG)'}, frais ${FEE} %) · choix tranches 1 + 2, vérification tranche 3 ===\n`);
  for (const f of fams) {
    const r = results.filter((x) => `${x.v.fam} ${x.tf}` === f);
    console.log(`  ${f.padEnd(16)} ${String(r.length).padStart(3)} testées · ${String(r.filter((x) => x.chosen).length).padStart(3)} choisies · ${String(r.filter((x) => x.valid).length).padStart(3)} confirmées`);
  }
  const chosen = results.filter((x) => x.chosen);
  const valid = results.filter((x) => x.valid);
  console.log(`\nTotal : ${results.length} testées · ${chosen.length} choisies · ${valid.length} confirmées (${chosen.length ? ((valid.length / chosen.length) * 100).toFixed(0) : 0} %)`);
  console.log('\nLes 15 meilleures sur la tranche la plus récente (gain net cumulé % : tranche 1 · 2 · 3, nombre de trades) :');
  for (const r of valid.sort((p, q) => q.parts[2].sum - p.parts[2].sum).slice(0, 15)) {
    console.log(`  [${r.tf}] ${r.v.fam.padEnd(9)} ${r.v.name.padEnd(48)} ${r.parts.map((p) => `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(0)} %`).join(' · ')} · ${r.parts.reduce((s, p) => s + p.n, 0)} trades`);
  }
  // Les 6 scalps actifs, mêmes tranches, pour comparer
  console.log('\nScalps déjà actifs (mêmes tranches) :');
  for (const [id, tf] of NAS ? [['m_down3', '15m'], ['x_orb5', '5m'], ['x_lasthalf', '5m'], ['n_overnight', '5m'], ['m_vwap', '15m'], ['g_ibsh', '5m']] : [['x_rsi2', '5m'], ['m_bb', '5m'], ['m_wr', '5m'], ['m_keltner', '5m'], ['m_ibs', '15m'], ['m_rsi2x', '15m']]) {
    const d = sets[tf];
    const s = withTf(selectStrategies([id])[0], tf);
    const r = backtest(s, d.c, { size: 1000, feePct: FEE, financingPct: FIN, barSec: d.sec, market: MK });
    const a = d.c[0].t; const b = d.c[d.c.length - 1].t; const cuts = [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity];
    const parts = [0, 1, 2].map((k) => r.list.filter((t) => t.entryT >= cuts[k] && t.entryT < cuts[k + 1]).reduce((s2, t) => s2 + t.pnlPct, 0));
    console.log(`  ${`${id}@${tf}`.padEnd(14)} ${parts.map((p) => `${p >= 0 ? '+' : ''}${p.toFixed(0)} %`).join(' · ')} · ${r.trades} trades`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
