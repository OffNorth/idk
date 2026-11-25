#!/usr/bin/env node
/**
 * Réglage « comme Lucid » pour FTMO (npm run ftmo-lucidlike) :
 *   Évaluation : risque intraday × 1 / × 2 / × 3, avec ou sans gestion de la journée (plus de trade après un gain du jour
 *     de 25 % de l'objectif, soit 2 500 $, ou après 1 trade perdant). Mesures : réussite < 1 an (2009–19 | 2020–26 |
 *     nov. 24–26) et, sur nov. 24–26 (départ chaque jour ouvré), réussie ≤ 14 j / ≤ 30 j, échouée ≤ 14 j.
 *   Compte financé : risque × 1 / 0,75 / 0,5 / 0,35 (avec les sorties partielles ⅓ +1 R / ⅓ +2 R / stop suiveur), départ
 *     chaque semaine 2009–2023 : comptes encore en vie après 12 / 24 / 36 mois, retraits moyens pour le trader (80 %)
 *     sur 36 mois, et part des comptes qui atteignent 4 hausses de capital de 25 % (scaling FTMO : ≥ 2 retraits et solde
 *     positif sur chaque période de 4 mois) — calcul simplifié, capital constant.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, runPhase } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { withTp } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const DAY = 86400;
const ACT = cfg.ftmoTrailActR || 2;
const DIST = cfg.ftmoTrailDistR ?? 1;
const withTrail = (s) => ({
  ...s,
  trail(pos, ind, i) {
    const prev = s.trail ? s.trail(pos, ind, i) : NaN;
    const long = pos.side === 'long'; const r = Math.abs(pos.entry - pos.initSl);
    const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
    if (!(fav >= ACT * r)) return prev;
    const next = long ? pos.best - DIST * r : pos.best + DIST * r;
    return Number.isFinite(prev) ? (long ? Math.max(prev, next) : Math.min(prev, next)) : next;
  },
});
const part = (k) => (s) => { const t = withTrail(s); return k ? withTp(t, k, s.id, s.name) : t; };

(async () => {
  const A = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const isIntra = (s) => s.tf && s.tf !== '1d';
  let A0 = 0;
  const lists = {};
  const listOf = async (k) => {
    if (lists[k ?? 'x']) return lists[k ?? 'x'];
    const wrap = part(k);
    const { all, q5 } = await buildTrades(cfg, CACHE, { wrap });
    A0 = q5[0].t + 30 * DAY;
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100'));
    const nas = sids.filter((x) => x.startsWith('nas100:') && isIntra(strat(x)[1])).flatMap((x) => backtest(wrap(strat(x)[1]), qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' })
      .list.map((t) => ({ ...t, sid: x, market: 'nas100', intraday: true })));
    return (lists[k ?? 'x'] = [...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) })));
  };
  const evalList = await listOf(null);
  // Compte financé : ⅓ +1 R, ⅓ +2 R, ⅓ stop suiveur (trade combiné)
  const l1 = new Map((await listOf(1)).map((t) => [`${t.sid}|${t.entryT}`, t]));
  const l2 = new Map((await listOf(2)).map((t) => [`${t.sid}|${t.entryT}`, t]));
  const fundList = evalList.map((t) => { const a = l1.get(`${t.sid}|${t.entryT}`) || t; const b = l2.get(`${t.sid}|${t.entryT}`) || t;
    return { ...t, pnlPct: (t.pnlPct + a.pnlPct + b.pnlPct) / 3, exitT: Math.max(t.exitT, a.exitT, b.exitT) }; });

  const sizer = RULES[cfg.ftmoSizing];
  const RF = { steps: 1, capital: 100_000, target: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer };

  // ---------- Évaluation ----------
  const evalRes = (mIntra, rules) => {
    const list = evalList.map((t) => ({ ...t, riskPct: t.riskPct * (t.intraday ? mIntra : 1) }));
    const o = { ...RF, ...rules };
    const per = Object.entries({ B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] }).map(([k, [a, b]]) => {
      const x = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      const c = challengeStats(x, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...o, target1: 10 });
      return `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`;
    }).join(' | ');
    const l = list.filter((t) => t.entryT >= A0).sort((p, q) => p.entryT - q.entryT);
    const end = l[l.length - 1].entryT - 60 * DAY;
    let n = 0; let p14 = 0; let p30 = 0; let f14 = 0;
    for (let s = A0; s < end; s += DAY) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      n++;
      const r = runPhase(l.filter((t) => t.entryT >= s && t.entryT < s + 200 * DAY), { ...o, from: s });
      const d = (r.at - s) / DAY;
      if (r.outcome === 'target' && d <= 14) p14++;
      if (r.outcome === 'target' && d <= 30) p30++;
      if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) f14++;
    }
    return `${per} || ≤14 j ${((p14 / n) * 100).toFixed(0).padStart(2)} % · ≤30 j ${((p30 / n) * 100).toFixed(0).padStart(2)} % · échec ≤14 j ${((f14 / n) * 100).toFixed(0).padStart(2)} %`;
  };
  const DAYR = { dayProfitCapUsd: 0.25 * 10_000, maxLossesPerDay: 1 };
  console.log('=== FTMO évaluation · réussite < 1 an (délai) 2009–19 | 2020–26 | nov. 24–26 || nov. 24–26 départ chaque jour ===');
  for (const [name, m, rules] of [['actuel', 1, {}], ['journée gérée (+2 500 $ / 1 perte)', 1, DAYR], ['intraday × 2', 2, {}], ['intraday × 2 + journée gérée', 2, DAYR],
    ['intraday × 3', 3, {}], ['intraday × 3 + journée gérée', 3, DAYR]]) {
    console.log(`${name.padEnd(36)} ${evalRes(m, rules)}`);
  }

  // ---------- Compte financé ----------
  console.log('\n=== FTMO compte financé (départ chaque semaine 2009–2023, journalier + intraday or) ===');
  console.log(`${'risque'.padEnd(12)} en vie 12 / 24 / 36 mois · retraits trader moyens 36 mois · 4 hausses de 25 % atteintes`);
  const fl = fundList.filter((t) => !(t.intraday && t.market !== 'gold'));
  for (const mul of [1, 0.75, 0.5, 0.35, 0.25]) {
    const list = fl.map((t) => ({ ...t, riskPct: t.riskPct * mul }));
    let n = 0; let a12 = 0; let a24 = 0; let a36 = 0; let paidSum = 0; let scaled = 0;
    for (let s = Y(2009) + 60 * DAY; s < Y(2023); s += 7 * DAY) {
      n++;
      const paid = [];
      let last = s;
      const payout = ({ t, balance, capital }) => {
        const gain = balance - capital;
        if (t - last < 14 * DAY || gain <= 0) return 0;
        last = t; paid.push(t); return gain;
      };
      const until = s + 3 * 365 * DAY;
      const r = runPhase(list, { ...RF, from: s, until, target: Infinity, bestDayPct: 0, payout });
      const end = r.outcome === 'open' ? until : r.at;
      const life = (end - s) / (30.4 * DAY);
      if (life >= 12) a12++; if (life >= 24) a24++; if (life >= 36 - 0.5) a36++;
      paidSum += r.paid.reduce((x, p) => x + p.amount, 0) * 0.8;
      // Scaling : chaque période de 4 mois vécue avec ≥ 2 retraits → une hausse ; 4 hausses = capital × 2,44
      let ups = 0;
      for (let k = 0; k < 9; k++) {
        const a = s + k * 4 * 30.4 * DAY; const b = a + 4 * 30.4 * DAY;
        if (b > end) break;
        if (r.paid.filter((p) => p.t >= a && p.t < b).length >= 2) ups++;
      }
      if (ups >= 4) scaled++;
    }
    const pc = (x) => `${((x / n) * 100).toFixed(0).padStart(3)} %`;
    console.log(`× ${String(mul).replace('.', ',').padEnd(10)} ${pc(a12)} / ${pc(a24)} / ${pc(a36)} · ${Math.round(paidSum / n).toLocaleString('fr-FR').padStart(8)} $ · ${pc(scaled)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
