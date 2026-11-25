#!/usr/bin/env node
/**
 * Nouvelles stratégies intraday Nasdaq taillées pour Lucid (objectif de gain proche, séries de pertes courtes), sur
 * la séance seule de New York (comme en direct), QQQ 5 min nov. 2024 → nov. 2026. Chaque candidate (objectif 0,5 /
 * 0,75 R) doit avoir un avantage positif sur les DEUX années, ≤ 8 pertes de suite, puis est ajoutée au réglage Lucid
 * actuel (journalières + n_mom10_t05 + n_orb15_t05) : réussite de l'évaluation, délai médian, trades par jour.
 *
 *   npm run lucid-research2
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const S = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const { hm, breakout, momentum } = S;
const withTp = (s, k) => ({ ...s, id: `${s.id}_t${String(k).replace('.', '')}`, name: `${s.name} · objectif ${k} R`, evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 ? { ...r, tp: k * r.sl } : r; } });

function candidates() {
  const C = [];
  // Cassures du range d'ouverture : 5 / 10 / 30 min, hausse / baisse / les deux, entrée avant midi, sortie 15 h 55
  for (const len of [5, 10, 30]) for (const dir of ['long', 'short', 'both']) {
    C.push(breakout({ id: `l_orb${len}_${dir}`, name: `Nasdaq : cassure des ${len} premières min (${dir === 'both' ? 'deux sens' : dir === 'long' ? 'hausse' : 'baisse'})`, tz: 'ny', start: hm(9, 30), len, entryEnd: hm(12), exitAt: hm(15, 55), dir }));
  }
  // « Opening drive » : sens des 30 premières min > seuil → suivre jusqu'à 11 h 30
  for (const th of [0.3, 0.5]) C.push(momentum({ id: `l_drive_${th}`, name: `Nasdaq : élan d'ouverture (9 h 30 → 10 h > ${th} %) suivi jusqu'à 11 h 30`, tz: 'ny', ref: hm(9, 35), at: hm(10), exitAt: hm(11, 30), th, mode: 'follow', stopAtr: 2 }));
  // Dernière heure : sens depuis l'ouverture → suivre / contrer de 15 h à 15 h 55
  for (const th of [0.5, 1]) for (const mode of ['follow', 'fade']) C.push(momentum({ id: `l_power_${th}_${mode}`, name: `Nasdaq : dernière heure, mouvement > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'}`, tz: 'ny', ref: hm(9, 35), at: hm(15), exitAt: hm(15, 55), th, mode }));
  // Range de la 1re heure : cassure l'après-midi
  C.push(breakout({ id: 'l_or60', name: 'Nasdaq : cassure du range de la 1re heure (avant 15 h)', tz: 'ny', start: hm(9, 30), len: 60, entryEnd: hm(15), exitAt: hm(15, 55) }));
  // Midi : élan du matin (10 h → 12 h) suivi l'après-midi
  for (const th of [0.3, 0.6]) C.push(momentum({ id: `l_noon_${th}`, name: `Nasdaq : élan du matin (10 h → 12 h > ${th} %) suivi jusqu'à 15 h 55`, tz: 'ny', ref: hm(10), at: hm(12), exitAt: hm(15, 55), th, mode: 'follow' }));
  return C.flatMap((s) => [0.5, 0.75].map((k) => withTp(s, k)));
}

(async () => {
  const qs = require('./src/oanda').nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const t0 = qs[0].t + 30 * 86400; const t1 = qs[qs.length - 1].t; const mid = (t0 + t1) / 2;
  const opt = { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' };
  const trades = (s) => backtest(s, qs, opt).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, sid: `nas100:${s.id}`, market: 'nas100', intraday: true, contractUsd: t.entry * 82, contractFee: 2.5 }));
  const days = (t1 - t0) / 86400 * (5 / 7);
  const rows = [];
  for (const s of candidates()) {
    const l = trades(s);
    const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const all = rStats(l);
    rows.push({ s, l, a, b, all, ok: a.expR > 0.02 && b.expR > 0.02 && all.worstRun <= 8 && a.n >= 30 && b.n >= 30 });
  }
  rows.sort((p, q) => Math.min(q.a.expR, q.b.expR) - Math.min(p.a.expR, p.b.expR));
  console.log('=== Candidates (QQQ séance seule, nov. 2024 → nov. 2026) · R moyen 1re / 2e année · gagnants · pire série · baisse max · trades / jour ===');
  for (const r of rows) console.log(`${r.ok ? '✅' : '  '} ${r.s.id.padEnd(22)} ${(r.a.expR >= 0 ? '+' : '') + r.a.expR.toFixed(2)} / ${(r.b.expR >= 0 ? '+' : '') + r.b.expR.toFixed(2)} R · ${r.all.win.toFixed(0)} % · ${String(r.all.worstRun).padStart(2)} · ${r.all.maxDdR.toFixed(1).padStart(5)} R · ${(r.l.length / days).toFixed(2)} /j  ${r.s.name}`);

  // ---- Évaluation Lucid : réglage actuel + candidates retenues (une à une, puis les meilleures ensemble)
  const kept = rows.filter((r) => r.ok);
  console.log(`\n${kept.length} candidate(s) retenue(s).`);
  const { all } = await buildTrades(cfg, CACHE);
  const L = accountOf(cfg, 'lucid');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const daily = all.filter((t) => !t.intraday && L.strategies.includes(t.sid)).map((t) => ({ ...t, riskPct: L.riskOf(...strat(t.sid)) })).filter((t) => t.riskPct > 0);
  const cur = cfg.lucidIntradayStrategies.flatMap((k) => trades(selectStrategies([k.split(':')[1]])[0]));
  const R = { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop };
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const halfStart = t0 + (t1 - 365 * 86400 - t0) / 2;
  const evalLucid = (intra) => {
    const list = [...daily, ...intra.map((t) => ({ ...t, riskPct: cfg.lucidIntradayRisk }))].filter((t) => t.entryT >= t0);
    const one = (a, e) => challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(e ? { end: e + 365 * 86400 } : {}), ...R });
    const c = one(t0); const h1 = one(t0, halfStart); const h2 = one(halfStart);
    const st = rStats([...intra].sort((p, q) => p.exitT - q.exitT));
    return `réussite ${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j) · moitiés ${h1.passRate.toFixed(0)} / ${h2.passRate.toFixed(0)} % · intraday ${(intra.length / days).toFixed(1)} /j, ${st.win.toFixed(0)} % gagnants, pire série ${st.worstRun}`;
  };
  console.log('\n=== Lucid 50K, départ chaque semaine (nov. 2024 → nov. 2026) ===');
  console.log(`${'actuel (n_mom10_t05, n_orb15_t05)'.padEnd(40)} ${evalLucid(cur)}`);
  for (const r of kept) console.log(`${('+ ' + r.s.id).padEnd(40)} ${evalLucid([...cur, ...r.l])}`);
  // Meilleures ensemble (sans doublon de famille : une variante d'objectif par stratégie)
  const fam = new Map();
  for (const r of kept) { const f = r.s.id.replace(/_t\d+$/, ''); if (!fam.has(f)) fam.set(f, r); }
  const best = [...fam.values()].slice(0, 4);
  for (let n = 2; n <= best.length; n++) console.log(`${('+ ' + best.slice(0, n).map((r) => r.s.id).join(' + ')).padEnd(40)} ${evalLucid([...cur, ...best.slice(0, n).flatMap((r) => r.l)])}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
