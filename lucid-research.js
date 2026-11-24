#!/usr/bin/env node
/**
 * Stratégies intraday faites pour Lucid : peu de pertes de suite, petite baisse en R. La perte max Lucid (2 000 $
 * suiveuse en fin de journée) ne laisse qu'≈ 10 trades perdants d'affilée ; les stratégies de cassure (20–40 % de
 * gagnants, séries de 16 à 49 pertes) la font échouer même quand elles gagnent en moyenne.
 *   1. Stratégies intraday existantes (or, Nasdaq) avec un OBJECTIF de gain (0,5 / 1 / 1,5 × le risque) : plus de
 *      trades gagnants, séries de pertes plus courtes.
 *   2. Nouvelles familles à taux de réussite élevé : retour au VWAP après un écart de k ATR (Nasdaq 10 h → 15 h NY,
 *      or 8 h → 16 h UTC), objectif = le VWAP ; écart d'ouverture du Nasdaq comblé avec objectif partiel.
 * Mesures : gain sur 3 tranches, % gagnants, pire série de pertes, pire baisse (R), puis réussite de l'évaluation
 * Lucid 50K avec les stratégies Lucid actuelles (et du challenge FTMO).
 *
 *   npm run lucid-research
 */
const fs = require('fs');
const path = require('path');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats } = require('./src/ftmo');
const { selectStrategies } = require('./src/strategies');
const S = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const hm = S.hm;

/** Même stratégie avec un objectif de gain à k × la distance du stop. */
const withTp = (s, k) => ({ ...s, id: `${s.id}_tp${k}`, name: `${s.name} + objectif ${k} R`, evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 ? { ...r, tp: k * r.sl } : r; } });

/** Retour au VWAP : écart > k ATR entre start et end (minutes du fuseau) → contre-pied, objectif = VWAP, stop = m × écart. */
function vwapFade({ id, name, market, tz, start, end, exitAt, k, m = 1 }) {
  return {
    id, name, tf: '5m', scalp: true, warmup: 300, markets: [market], compute: (c) => S.computeFor(c, market),
    evaluate(x0, i) {
      const x = S.withNyx(x0);
      const mm = x.tz[tz].min[i];
      const wd = new Date(x.candles[i].t * 1000).getUTCDay();
      const exit = wd === 0 || wd === 6 || mm >= exitAt || mm < start;
      const out = { entry: null, exitLong: exit, exitShort: exit, sl: 0, tp: null };
      if (exit || mm >= end || x.vwap[i] == null || !(x.atr[i] > 0)) return out;
      const d = x.closes[i] - x.vwap[i];
      if (Math.abs(d) < k * x.atr[i]) return out;
      const key = d > 0 ? `${id}s` : `${id}l`;
      const first = S.firstOfDay(x, tz, key, (j) => { const mj = x.tz[tz].min[j]; return x.vwap[j] != null && mj >= start && mj < end && (d > 0 ? x.closes[j] - x.vwap[j] >= k * x.atr[j] : x.vwap[j] - x.closes[j] >= k * x.atr[j]); });
      if (!first[i]) return out;
      return { ...out, entry: d > 0 ? 'short' : 'long', sl: m * Math.abs(d), tp: Math.abs(d) };
    },
  };
}

function evaluate(list, candles, slices, { fee, fin, market, minTrades }) {
  const rows = [];
  for (const s of list) {
    let r;
    try {
      r = backtest(s, candles, { size: 1000, feePct: fee, financingPct: fin, barSec: 300, market });
    } catch (err) {
      console.log(`  ${s.id} : erreur ${err.message}`);
      continue;
    }
    const sl = slices.map(([a, b]) => r.list.filter((t) => t.entryT >= a && t.entryT < b));
    const g = sl.map((l) => l.reduce((a, t) => a + t.pnlPct, 0));
    const st = rStats(r.list.filter((t) => t.entryT >= slices[0][0]));
    rows.push({ s, market, list: r.list, g, n: sl.map((l) => l.length), st, ok: g.every((v) => v > 0) && sl.every((l) => l.length >= minTrades) });
  }
  return rows;
}

const line = (r) => `${r.ok ? '✅' : '  '} ${r.s.id.padEnd(24)} ${r.g.map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`.padStart(8)).join(' |')} · ${String(r.list.length).padStart(5)} tr · ${r.st.win.toFixed(0).padStart(2)} % gagnants · pire série ${String(r.st.worstRun).padStart(2)} · baisse max ${r.st.maxDdR.toFixed(1).padStart(5)} R · ${r.st.expR >= 0 ? '+' : ''}${r.st.expR.toFixed(2)} R`;

(async () => {
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const q5 = aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60);
  // Nasdaq : bougies de la séance seulement (comme en direct)
  const qs = require('./src/oanda').nySession(q5);
  const goldBase = selectStrategies(['g_orb30', 'g_orb60', 'g_mom8', 'g_gap', 'g_asiabrk', 'g_nypdl']);
  const nasBase = selectStrategies(['n_noise', 'n_orb5s', 'n_orb15', 'n_mom10', 'n_pdlbrk']);
  const gold = [...goldBase, ...goldBase.flatMap((s) => [0.5, 1, 1.5].map((k) => withTp(s, k)))];
  for (const k of [1.5, 2, 3]) for (const m of [1, 1.5]) gold.push(vwapFade({ id: `gv_vwap_${k}_${m}`, name: `Or : retour au VWAP après ${k} ATR d'écart (8 h → 16 h UTC), stop ${m} × l'écart`, market: 'gold', tz: 'utc', start: hm(8), end: hm(16), exitAt: hm(19, 55), k, m }));
  const nas = [...nasBase, ...nasBase.flatMap((s) => [0.5, 1, 1.5].map((k) => withTp(s, k)))];
  for (const k of [1.5, 2, 3]) for (const m of [1, 1.5]) nas.push(vwapFade({ id: `nv_vwap_${k}_${m}`, name: `Nasdaq : retour au VWAP après ${k} ATR d'écart (10 h → 15 h NY), stop ${m} × l'écart`, market: 'nas100', tz: 'ny', start: hm(10), end: hm(15), exitAt: hm(15, 55), k, m }));

  console.log(`=== Or (comptant 5 min) · tranches 2009–14 | 2015–20 | 2021–26 ===`);
  const gr = evaluate(gold, g5, [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]], { fee: 0.005, fin: 0, market: 'gold', minTrades: 50 });
  gr.sort((a, b) => a.st.worstRun - b.st.worstRun || b.st.expR - a.st.expR).forEach((r) => console.log(line(r)));
  const a0 = qs[0].t + 30 * 86400; const third = (qs[qs.length - 1].t - a0) / 3;
  console.log(`\n=== Nasdaq (QQQ 5 min, séance) · 3 tranches de 8 mois ===`);
  const nr = evaluate(nas, qs, [[a0, a0 + third], [a0 + third, a0 + 2 * third], [a0 + 2 * third, Infinity]], { fee: 0.003, fin: 6, market: 'nas100', minTrades: 20 });
  nr.sort((a, b) => a.st.worstRun - b.st.worstRun || b.st.expR - a.st.expR).forEach((r) => console.log(line(r)));

  // ---- Évaluation Lucid (et FTMO) : stratégies actuelles + chaque candidate positive sur les 3 tranches, pire série ≤ 12
  const cand = [...gr, ...nr].filter((r) => r.ok && r.st.worstRun <= 12);
  console.log(`\n${cand.length} candidate(s) positives sur les 3 tranches avec au plus 12 pertes de suite.`);
  if (!cand.length) return;
  const cfg = require('./src/config');
  const { challengeStats, cmeDay } = require('./src/ftmo');
  const { RULES } = require('./src/sizing');
  const { buildTrades } = require('./src/ftmoTrades');
  const { programOf, accountOf } = require('./src/ftmoAccount');
  const { all, q5: qq } = await buildTrades(cfg, CACHE);
  const sizer = RULES[cfg.ftmoSizing];
  const F = programOf(cfg);
  const L = accountOf(cfg, 'lucid');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '5m' }]; };
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')], A: [qq[0].t + 30 * 86400, Infinity, () => true] };
  const RS = {
    Lucid: { R: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop }, risk: (t) => (t.extra ? cfg.lucidIntradayRisk : L.riskOf(...strat(t.sid))) },
    FTMO: { R: { steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, dayStopPct: cfg.ftmoDayStop }, risk: (t) => t.riskPct },
  };
  const run = (extra, replace = null) => Object.entries(RS).map(([name, R]) => `${name} ${Object.entries(P).map(([k, [a, b, f]]) => {
    const list = [...all.filter((t) => !replace || t.sid !== replace), ...extra].filter((t) => t.entryT >= a && t.entryT < b && f(t)).map((t) => ({ ...t, riskPct: R.risk(t) })).filter((t) => t.riskPct > 0);
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...R.R });
    return `${k} ${c.passRate.toFixed(0)} %`;
  }).join(' | ')}`).join('  ·  ');
  console.log('\n=== Réussite < 1 an (2009–19 | 2020–26 | nov. 24–26 ; Nasdaq intraday seulement sur la dernière) ===');
  console.log(`actuel                      ${run([])}`);
  for (const r of cand.sort((a, b) => a.st.worstRun - b.st.worstRun).slice(0, Number(process.env.TOP || 12))) {
    const mult = r.market === 'gold' ? 10 : 82; const cfee = r.market === 'gold' ? 3.5 : 2.5;
    const extra = r.list.map((t) => ({ ...t, sid: `${r.market}:${r.s.id}`, market: r.market, intraday: true, extra: true, riskPct: cfg.ftmoIntradayRisk, contractUsd: t.entry * mult, contractFee: cfee }));
    // Variante « objectif » d'une stratégie déjà sur Lucid / FTMO : elle REMPLACE l'originale
    const orig = r.s.id.includes('_tp') ? `${r.market}:${r.s.id.split('_tp')[0]}` : null;
    console.log(`${orig ? '↻' : '+'} ${r.s.id.padEnd(25)} ${run(extra, orig)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
