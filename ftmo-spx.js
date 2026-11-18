#!/usr/bin/env node
/**
 * Stratégies S&P 500 pour le compte FTMO : le compte actuel (stratégies journalières or GC=F, Nasdaq, EUR/USD à 1,5 %)
 * plus chaque stratégie S&P 500 candidate (positive sur 2009–2012, 2013–2016, 2017–2019), à 0,25 / 0,5 / 1 / 1,5 %,
 * puis ajout glouton. Formule FTMO_PROGRAM (1 étape par défaut), réussite en moins de 6 mois / d'un an,
 * choix sur 2009–2019, vérification sur 2020–2026.
 *
 *   npm run ftmo-spx
 */
const path = require('path');
const cfg = require('./src/config');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { annotate, RULES } = require('./src/sizing');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [[Y(2009), Y(2013)], [Y(2013), Y(2017)], [Y(2017), Y(2020)]];
const SPLIT = Y(2020);
const T0 = Y(2009) + 60 * 86400;
const IDS = ['rsi2', 'ibs', 'double7', 'down3', 'cumrsi', 'dip5', 'pctb', 'tom', 'n_rsi4', 'n_low10', 'n_weekrev', 'n_drop', 'n_2down', 'n_dollarfall', 'n_goldfall', 'vixspike', 'golden', 'sma200', 'trendmix', 'mom12_1', 'ema_long', 'rates', 'season'];

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const vix = await y('^VIX');
  const nd = await y('^NDX');
  const gc = (await y('GC=F')).filter((k) => k.c > 0);
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: gc };
  const goldAux = { tnx: aux.tnx, dxy: aux.dxy, silver: await y('SI=F'), oil: aux.oil, peer: nd };
  const D = {
    nas100: { c: nd, aux, fee: 0.003, fin: 6 },
    gold: { c: gc, aux: goldAux, fee: 0.005, fin: 4 },
    eurusd: { c: (await y('EURUSD=X')).filter((k) => k.c > 0), aux, fee: 0.002, fin: 3 },
    spx: { c: (await y('^GSPC')).filter((k) => k.c > 0), aux, fee: 0.003, fin: 6 },
  };
  for (const d of Object.values(D)) d.ind = computeAll(d.c, d.c, 86400, null, vix, d.aux);
  const trades = (m, id) => {
    const s = selectStrategies([id])[0];
    if (!s || tfOf(s) !== '1d') return null;
    const d = D[m];
    return backtest(s, d.c, { size: 1000, feePct: d.fee, financingPct: d.fin, barSec: 86400, ind: d.ind, daily: d.c, vix, aux: d.aux, market: m === 'gold' ? 'gold' : 'nas100' }).list
      .filter((t) => t.entryT >= T0).map((t) => ({ ...t, sid: `${m}:${id}`, market: m }));
  };
  const risk = (m) => (m === 'nas100' ? cfg.ftmoComboNasRisk : m === 'eurusd' ? cfg.ftmoEurRisk : cfg.ftmoRisk);
  const base = [...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies].flatMap((k) => { const [m, id] = k.split(':'); return (trades(m, id) || []).map((t) => ({ ...t, riskPct: risk(m) })); });
  annotate(base);

  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay };
  const st = (l, part, h) => challengeStats(part === 'choix' ? l.filter((t) => t.entryT < SPLIT) : l.filter((t) => t.entryT >= SPLIT), { ...opts, horizonDays: h, ...(part === 'choix' ? { start: T0, end: SPLIT } : { start: SPLIT }) });
  const pr = (c) => (c ? c.passRate : 0);
  const fmt = (l) => ['choix', 'verif'].map((p) => { const a = st(l, p, 180); const b = st(l, p, 365); return `${p === 'choix' ? 'choix' : 'vérif'} ${pr(a).toFixed(0).padStart(2)} % / ${pr(b).toFixed(0).padStart(2)} % (${b?.medianDays?.toFixed(0) ?? '—'} j)`; }).join(' | ');

  console.log(`=== ${F.label} · compte actuel + stratégies S&P 500 · « < 6 mois / < 1 an (médiane) » ===\n`);
  console.log(`  Compte actuel ${''.padEnd(24)} ${fmt(base)}\n`);
  const C = {};
  for (const id of IDS) {
    const l = trades('spx', id);
    if (!l) continue;
    const parts = P.map(([a, b]) => { const k = l.filter((t) => t.entryT >= a && t.entryT < b); return { n: k.length, s: k.reduce((x, t) => x + t.pnlPct, 0) }; });
    if (!parts.every((p) => p.s > 0 && p.n >= 3)) continue;
    for (const r of [0.25, 0.5, 1, 1.5]) {
      C[`spx:${id} @${r} %`] = l.map((t) => ({ ...t, riskPct: r }));
      annotate(C[`spx:${id} @${r} %`]);
    }
  }
  for (const [k, l] of Object.entries(C)) console.log(`  + ${k.padEnd(36)} ${fmt([...base, ...l])}`);

  let port = [...base];
  let cur = pr(st(port, 'choix', 365));
  const added = [];
  for (;;) {
    let pick = null;
    for (const [k, l] of Object.entries(C)) {
      if (added.some((a) => a.split(' @')[0] === k.split(' @')[0])) continue;
      const v = pr(st([...port, ...l], 'choix', 365));
      if (v > cur + 0.5 && (!pick || v > pick.v)) pick = { k, v };
    }
    if (!pick) break;
    added.push(pick.k);
    port = [...port, ...C[pick.k]];
    cur = pick.v;
  }
  console.log(`\nAjout glouton (choix 2009–2019, < 1 an) : ${added.join(', ') || 'aucun'}`);
  console.log(`  → ${fmt(port)}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
