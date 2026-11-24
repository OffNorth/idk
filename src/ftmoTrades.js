/**
 * Trades simulés des stratégies du compte FTMO (FTMO_STRATEGIES + Nasdaq, compte combiné) pour les bancs d'essai
 * du challenge (lucid-compare.js, ftmo-protect.js) : or réel HistData intraday + journalières Yahoo (or GC=F, Nasdaq,
 * S&P 500, EUR/USD) + Nasdaq intraday (QQQ Polygon, en cache, depuis nov. 2024).
 * Chaque trade porte : sid, market, intraday, riskPct (risque du compte FTMO), contractUsd / contractFee (micro-futures).
 */
const fs = require('fs');
const path = require('path');
const { cachedYahoo } = require('./yahoo');
const { aggregate } = require('./history');
const { backtest } = require('./gold');
const { selectStrategies, tfOf, TF_SEC } = require('./strategies');
const { computeAll } = require('./indicators');
const { accountOf } = require('./ftmoAccount');
const { annotate } = require('./sizing');

// Micro-futures CME : valeur d'un contrat (× prix) et frais aller-retour (commission ≈ 1,5 $ + 1 tick de glissement par côté)
// Nasdaq intraday : prix du QQQ (≈ Nasdaq 100 ÷ 41) → MNQ = 2 $ × indice ≈ 82 × QQQ
const MICRO = {
  gold: { mult: 10, fee: 3.5 }, // MGC : 10 onces, tick 0,10 $ = 1 $
  nas100: { mult: 2, fee: 2.5 }, // MNQ : 2 $ par point, tick 0,25 pt = 0,50 $
  nas100q: { mult: 82, fee: 2.5 },
  spx: { mult: 5, fee: 4 }, // MES : 5 $ par point, tick 0,25 pt = 1,25 $
  eurusd: { mult: 12_500, fee: 4 }, // M6E : 12 500 €, tick 0,0001 = 1,25 $
};

/** Retourne { all (trades annotés), q5 (bougies Nasdaq 5 min ou null), A (compte FTMO) }. */
async function buildTrades(cfg, CACHE, { withLucid = false } = {}) {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const vix = await y('^VIX');
  const gc = (await y('GC=F')).filter((k) => k.c > 0);
  const nd = await y('^NDX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: aux.tnx, dxy: aux.dxy, silver: await y('SI=F'), oil: aux.oil, peer: nd };
  const daily = {
    nas100: { c: nd, aux }, gold: { c: gc, aux: goldAux },
    eurusd: { c: (await y('EURUSD=X')).filter((k) => k.c > 0), aux }, spx: { c: (await y('^GSPC')).filter((k) => k.c > 0), aux },
  };
  for (const d of Object.values(daily)) d.ind = computeAll(d.c, d.c, 86400, null, vix, d.aux);
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  let q5 = null;
  try { q5 = aggregate(await require('./polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60); } catch { /* sans clé Polygon */ }
  const intra = { gold: { '5m': g5, '15m': aggregate(g5, 900, 300) }, nas100: q5 ? { '5m': q5, '15m': aggregate(q5, 900, 300) } : null };
  const FEE = { gold: [0.005, 4], nas100: [0.003, 6], eurusd: [0.002, 3], spx: [0.003, 6] };
  const A = accountOf(cfg, 'gold');

  const all = [];
  // withLucid (Time Machine) : + stratégies propres au compte Lucid (variantes « objectif 0,5 R »)
  const ids = withLucid ? [...new Set([...A.strategies, ...accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid').strategies])] : A.strategies;
  for (const k of ids) {
    const [m, id] = k.split(':');
    const s = selectStrategies([id])[0];
    if (!s) continue;
    const tf = tfOf(s);
    const [fee, fin] = FEE[m];
    let r = null;
    if (tf === '1d') {
      const d = daily[m];
      r = backtest(s, d.c, { size: 1000, feePct: fee, financingPct: fin, barSec: 86400, ind: d.ind, daily: d.c, vix, aux: d.aux, market: m === 'gold' ? 'gold' : 'nas100' });
    } else if (intra[m]?.[tf]) {
      const c = intra[m][tf];
      r = backtest(s, c, { size: 1000, feePct: fee, financingPct: fin, barSec: TF_SEC[tf], ind: s.compute(c, TF_SEC[tf], m), market: m });
    }
    if (!r) { console.log(`  (pas de données pour ${k})`); continue; }
    const mc = MICRO[m === 'nas100' && tf !== '1d' ? 'nas100q' : m];
    all.push(...r.list.map((t) => ({ ...t, sid: k, market: m, intraday: tf !== '1d', riskPct: A.riskOf(m, s), contractUsd: t.entry * mc.mult, contractFee: mc.fee })));
  }
  annotate(all);
  return { all, q5, A, daily, vix };
}

module.exports = { buildTrades, MICRO };
