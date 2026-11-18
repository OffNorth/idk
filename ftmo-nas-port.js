#!/usr/bin/env node
/**
 * Compte FTMO Nasdaq : choix d'un portefeuille de stratégies journalières (^NDX 1985–2026) qui passe le challenge.
 *
 * Candidates : les stratégies Nasdaq journalières actives qui passent l'audit des 3 périodes, en version d'origine et en
 * version « stop serré » (1,5 ATR : position plus grosse pour le même risque).
 * Choix glouton sur 1985–1999 ET 2000–2009 (on ajoute la stratégie qui améliore le plus le PIRE des deux taux de réussite),
 * puis vérification sur 2010–2026 (jamais utilisée pour choisir). Risque testé : 0,5 à 2 % par trade.
 * Frais 0,003 % par côté + swap 6 %/an, perte du jour maison −2 %, levier 30, réussite des 2 étapes en moins de 6 mois.
 *
 *   npm run ftmo-nas-port
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { selectStrategies } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { challengeStats } = require('./src/ftmo');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [['1985–1999', Y(1985), Y(2000)], ['2000–2009', Y(2000), Y(2010)], ['2010–2026', Y(2010), Infinity]];
const IDS = (process.env.IDS || 'golden,mom12_1,trendmix,mom12,sma200,lowvol,rates,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,n_rsi4,tom,rsi2,ibs,double7,down3,cumrsi,dip5,vixspike,ema_long,dualmom').split(',');
const RISKS = [0.5, 1, 1.5, 2];

const tight = (s, k) => ({ ...s, id: `${s.id}~${k}`, evaluate(ind, i) { const r = s.evaluate(ind, i); return { ...r, sl: k * ind.atr[i] }; } });
const pct = (c) => (c && c.tries ? (c.passed / c.tries) * 100 : 0);

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d').catch(() => null);
  const nd = await y('^NDX');
  const vix = await y('^VIX');
  const aux = { tnx: await y('^TNX'), dxy: await y('DX-Y.NYB'), sox: await y('^SOX'), oil: await y('CL=F'), spx: await y('^GSPC'), peer: await y('GC=F') };
  const ind = computeAll(nd, nd, 86400, null, vix, aux);
  const T = {};
  for (const s0 of selectStrategies(IDS)) {
    for (const s of [s0, tight(s0, 1.5)]) {
      const r = backtest(s, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind, daily: nd, vix, aux, market: 'nas100' });
      if (r.list.length >= 20) T[s.id] = r.list;
    }
  }
  const stats = (ids, risk, k) => challengeStats(ids.flatMap((id) => T[id]), { riskPct: risk, dayStopPct: 2, start: P[k][1], end: P[k][2] === Infinity ? null : P[k][2] });
  const score = (ids, risk) => Math.min(pct(stats(ids, risk, 0)), pct(stats(ids, risk, 1)));

  console.log(`=== ${Object.keys(T).length} candidates (${IDS.length} stratégies × 2 stops) · challenge FTMO 2 étapes en < 6 mois ===\n`);
  const best = [];
  for (const risk of RISKS) {
    let port = [];
    let cur = 0;
    for (;;) {
      let pick = null;
      for (const id of Object.keys(T)) {
        if (port.some((p) => p.split('~')[0] === id.split('~')[0])) continue;
        const sc = score([...port, id], risk);
        if (sc > cur + 1 && (!pick || sc > pick.sc)) pick = { id, sc };
      }
      if (!pick) break;
      port = [...port, pick.id];
      cur = pick.sc;
    }
    const res = [0, 1, 2].map((k) => stats(port, risk, k));
    best.push({ risk, port, res });
    console.log(`Risque ${risk} % : ${port.join(', ') || '—'}`);
    console.log(`   réussite ${res.map((c, k) => `${P[k][0]} ${pct(c).toFixed(0)} %`).join(' · ')}`);
    console.log(`   échecs (perte du jour / perte max / pas fini) : ${res.map((c) => `${c.failedDaily}/${c.failedMax}/${c.unfinished}`).join(' · ')}\n`);
  }
  // Portefeuille actuel du compte FTMO Nasdaq, pour comparer
  const cur = ['n_weekrev', 'n_low10', 'n_drop', 'n_dollarfall', 'n_rsspx', 'n_2down', 'n_goldfall', 'n_rsi4', 'tom'].filter((id) => T[id]);
  for (const risk of RISKS) console.log(`Actuel à ${risk} % : ${[0, 1, 2].map((k) => `${P[k][0]} ${pct(stats(cur, risk, k)).toFixed(0)} %`).join(' · ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
