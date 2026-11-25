#!/usr/bin/env node
/**
 * Réussir l'évaluation plus vite (FTMO 1 étape et LucidFlex 50K) sans faire baisser la réussite. Leviers testés :
 *   1. risque par stratégie selon son avantage (R moyen appris sur 2009–2019 seulement, vérifié ensuite) ;
 *   2. retrait des stratégies à faible avantage ;
 *   3. règles « accélérer puis protéger » (plus de risque au début / quand le compte gagne) ;
 *   4. plus de risque partout (comparaison).
 * Mesures : réussite en moins de 6 mois et d'un an, délai médian, sur 2009–19 (choix) / 2020–26 / nov. 24–26.
 *
 *   npm run speed
 */
const path = require('path');
const cfg = require('./src/config');
const { challengeStats, cmeDay, rStats } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { programOf, accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const several = (s) => (s.open >= 2 ? 0.5 : 1);
const gain = (s) => (s.balance / s.capital - 1) * 100;

// Règles de taille (multiplicateur du risque) ; s : { balance, capital, dayStart, target, open }
const SIZERS = {
  actuel: RULES[cfg.ftmoSizing] || RULES.fixe,
  'accélère au début (× 1,5 jusqu’à mi-objectif)': (t, s) => several(s) * (gain(s) < s.target / 2 ? 1.5 : 1),
  'plus de risque en gain (× 1 → 1,5)': (t, s) => several(s) * clamp(1 + gain(s) / 10, 0.75, 1.5),
  'prudence en perte (× 0,5 sous −2 %)': (t, s) => several(s) * (gain(s) < -2 ? 0.5 : 1),
  'accélère + prudence en perte': (t, s) => several(s) * (gain(s) < -2 ? 0.6 : gain(s) < s.target / 2 ? 1.4 : 1),
};

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')], A: [q5[0].t + 30 * 86400, Infinity, () => true] };
  const F = programOf(cfg);
  const L = accountOf(cfg, 'lucid');
  const G = accountOf(cfg, 'gold');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '5m' }]; };
  const ACC = {
    FTMO: { R: { steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, dayStopPct: cfg.ftmoDayStop }, follow: new Set(G.strategies), risk: (t) => G.riskOf(...strat(t.sid)) },
    Lucid: { R: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop }, follow: new Set(L.strategies), risk: (t) => L.riskOf(...strat(t.sid)) },
  };
  // Avantage de chaque stratégie (R moyen) appris sur 2009–2019 seulement (Nasdaq intraday : 1re moitié de sa période)
  const learnEnd = (t) => (t.intraday && t.market === 'nas100' ? q5[0].t + 365 * 86400 : Y(2020));
  const bySid = {};
  for (const t of all) if (t.entryT < learnEnd(t)) (bySid[t.sid] ||= []).push(t);
  const edge = Object.fromEntries(Object.entries(bySid).map(([k, l]) => [k, rStats(l)]));
  console.log('Avantage appris (R moyen par trade, période d’apprentissage) :');
  console.log(Object.entries(edge).filter(([k]) => ACC.FTMO.follow.has(k) || ACC.Lucid.follow.has(k)).sort((a, b) => b[1].expR - a[1].expR).map(([k, s]) => `${k} ${s.expR >= 0 ? '+' : ''}${s.expR.toFixed(2)} (${s.n})`).join(' · '));
  const med = (() => { const v = Object.values(edge).map((s) => s.expR).filter((x) => x > 0).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] || 0.05; })();
  const W = {
    'poids = avantage (× 0,5 à × 2)': (sid) => clamp((edge[sid]?.expR ?? med) / med, 0.5, 2),
    'sans les stratégies < +0,03 R': (sid) => ((edge[sid]?.expR ?? 1) < 0.03 ? 0 : 1),
    'poids avantage + retrait < +0,03 R': (sid) => ((edge[sid]?.expR ?? 1) < 0.03 ? 0 : clamp((edge[sid]?.expR ?? med) / med, 0.5, 2)),
    'risque × 1,25 partout': () => 1.25,
    'risque × 1,5 partout': () => 1.5,
  };
  const run = (A, weight, sizer) => Object.entries(P).map(([k, [a, b, f]]) => {
    const list = all.filter((t) => A.follow.has(t.sid) && t.entryT >= a && t.entryT < b && f(t)).map((t) => ({ ...t, riskPct: A.risk(t) * weight(t.sid) })).filter((t) => t.riskPct > 0);
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...A.R });
    const p6 = c.tries ? (c.durations.filter((d) => d <= 182).length / c.tries) * 100 : 0;
    return { k, p6, p12: c.passRate, med: c.medianDays };
  });
  const fmt = (r) => r.map((x) => `${x.k} ${x.p6.toFixed(0).padStart(3)} % / ${x.p12.toFixed(0).padStart(3)} % (${x.med ? x.med.toFixed(0) : '—'} j)`).join(' | ');
  for (const [name, A] of Object.entries(ACC)) {
    console.log(`\n=== ${name} · réussite < 6 mois / < 1 an (délai médian) : 2009–19 (choix) | 2020–26 | nov. 24–26 ===`);
    console.log(`${'actuel'.padEnd(46)} ${fmt(run(A, () => 1, SIZERS.actuel))}`);
    for (const [lbl, w] of Object.entries(W)) console.log(`${lbl.padEnd(46)} ${fmt(run(A, w, SIZERS.actuel))}`);
    for (const [lbl, sz] of Object.entries(SIZERS)) if (lbl !== 'actuel') console.log(`${lbl.padEnd(46)} ${fmt(run(A, () => 1, sz))}`);
    console.log(`${'poids avantage + accélère + prudence'.padEnd(46)} ${fmt(run(A, W['poids avantage + retrait < +0,03 R'], SIZERS['accélère + prudence en perte']))}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
