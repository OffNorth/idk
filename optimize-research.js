#!/usr/bin/env node
/**
 * Sept idées pour optimiser le rendement (npm run optimize), jamais testées dans le bot :
 *   1. Prop firms de futures : mêmes stratégies (compte Lucid) sous les règles 2026 d'Apex, Topstep, Tradeify et Take
 *      Profit Trader (sources secondaires, à vérifier) ; réussite et coût réel par compte financé (évaluations ratées
 *      et abonnements mensuels compris), prix catalogue et prix promo.
 *   2. Renfort des gagnants (compte FTMO financé) : dès +1 R sur une journalière, une 2e part entre au cours, stop de
 *      l'ensemble remonté au prix d'entrée de la 1re.
 *   3. Taille selon la corrélation : réduction seulement si une position du même groupe (indices US, métaux, devises,
 *      obligations) est déjà ouverte, au lieu de « 2 positions ouvertes, quelles qu'elles soient ».
 *   4. Structure du VIX (VIX / VIX3M) : stress (> 1) ou calme (< 0,85) pour filtrer ou doser le risque.
 *   5. Risque selon l'heure : × 1,5 aux heures qui gagnent, × 0,5 à celles qui perdent (choix sur une période,
 *      vérification sur une autre).
 *   6. Résultats d'entreprises : pas de trade intraday sur une action le jour de ses résultats (jours repérés par l'écart
 *      d'ouverture, comme si le calendrier était connu à l'avance).
 *   7. Entrée en 1 min au lieu de 5 min sur les cassures de l'or (bougies Binance XAUUSDT, déc. 2025 → oct. 2026).
 * Règle habituelle : retenue seulement si aucune période ne baisse et qu'au moins une monte (Lucid : aussi ≤ 14 j).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, runPhase, fundedRun, cmeDay, rStats } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { cachedYahoo } = require('./src/yahoo');
const { metalsOpen } = require('./src/binance');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y, m = 1) => Date.UTC(y, m - 1, 1) / 1000;
const DAY = 86400;
const sgn = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const offC = new Map();
const nyOff = (t) => { const d = Math.floor(t / DAY); if (!offC.has(d)) { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date((d * DAY + 61200) * 1000)).find((p) => p.type === 'timeZoneName').value; offC.set(d, (Number((s.match(/GMT([+-]\d+)/) || [])[1]) || -5) * 3600); } return offC.get(d); };
const nyHour = (t) => Math.floor(((t + nyOff(t)) % DAY) / 3600);
const nyDay = (t) => Math.floor((t + nyOff(t)) / DAY);
const stopPct = (t) => (Math.abs(t.entry - t.initSl) / t.entry) * 100;
const R = (t) => t.pnlPct / stopPct(t);
const CLUSTER = { nas100: 'idx', spx: 'idx', dow: 'idx', russell: 'idx', googl: 'idx', pltr: 'idx', lly: 'idx', ba: 'idx', gold: 'metal', silver: 'metal', eurusd: 'fx', tlt: 'bond' };
const STOCKS = { tlt: 'TLT', googl: 'GOOGL', pltr: 'PLTR', lly: 'LLY', ba: 'BA' };

(async () => {
  /* ---------- Comptes actuels (comme npm run ideas) + actions intraday du compte FTMO ---------- */
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const nyRun = (bars, s, sid, m, mult, fee, feePct = 0.003, fin = 6) => backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, bars, { size: 1000, feePct, financingPct: fin, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  const pg = async (tk, m = 5) => nySession(m === 1 ? aggregate(await polygonBars(CACHE, tk, 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60) : await polygonBars(CACHE, tk, 5, '2024-11-18', { maxAgeH: Infinity }));
  const NYB = { nas100: [qs, 82, 2.5], silver: [await pg('SLV'), 1075, 3.5], dow: [await pg('DIA'), 50, 2.5], russell: [await pg('IWM'), 50, 2.5], spx: [await pg('SPY', 1), 50, 4] };
  for (const [m, tk] of Object.entries(STOCKS)) NYB[m] = [await pg(tk), 1, 0, 0.005];
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const accts = {};
  for (const id of ['ftmo', 'lucid']) {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true, lucidSplit: false }, id === 'ftmo' ? 'gold' : 'lucid');
    const sids = A.strategies.filter((k) => A.riskOf(...strat(k), 'eval') > 0);
    const intra = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; })
      .flatMap((k) => { const [b, mult, fee, fp] = NYB[k.split(':')[0]]; return nyRun(b, strat(k)[1], k, k.split(':')[0], mult, fee, fp); });
    const list = [...all.filter((t) => sids.includes(t.sid) && !(t.intraday && NYB[t.market])), ...intra].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid), 'eval') }));
    accts[id] = { A, list, sids };
  }
  const levCap = Object.fromEntries(Object.keys(STOCKS).map((m) => [m, 5]));
  const RF = { steps: 1, capital: 100_000, target: 10, target1: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, riskPct: 1, levCap,
    sizer: RULES[cfg.ftmoSizing], dayProfitCapUsd: (cfg.ftmoDayProfitCapPct / 100) * 10_000, maxLossesPerDay: cfg.ftmoMaxLossesDay || Infinity };
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2,
    contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer: RULES[cfg.ftmoSizing],
    dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * 50_000 * 0.06, maxLossesPerDay: cfg.lucidMaxLossesDay || Infinity };
  const inPer = (t, k, a, b) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold'));
  const evaluate = (id, list, extra = {}) => {
    const o = { ...(id === 'ftmo' ? RF : RL), ...extra };
    const cs = Object.entries(P).map(([k, [a, b]]) => challengeStats(list.filter((t) => inPer(t, k, a, b)), { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...o }));
    const res = { per: cs.map((c) => c.passRate), days: cs.map((c) => c.medianDays), p14: 0, p30: 0, f14: 0 };
    if (id === 'lucid') {
      const l = list.filter((t) => t.entryT >= A0).sort((x, y) => x.entryT - y.entryT);
      const end = l[l.length - 1].entryT - 60 * DAY; let n = 0;
      for (let s = A0; s < end; s += DAY) {
        const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
        n++; const r = runPhase(l.filter((t) => t.entryT >= s && t.entryT < s + 200 * DAY), { ...o, from: s }); const d = (r.at - s) / DAY;
        if (r.outcome === 'target' && d <= 14) res.p14++; if (r.outcome === 'target' && d <= 30) res.p30++; if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) res.f14++;
      }
      res.p14 = (res.p14 / n) * 100; res.p30 = (res.p30 / n) * 100; res.f14 = (res.f14 / n) * 100;
    }
    return res;
  };
  const fmt = (r) => `${r.per.map((p, i) => `${p.toFixed(0).padStart(3)} %${process.env.DAYS ? ` (${r.days?.[i] ? r.days[i].toFixed(0) : '—'} j)` : ''}`).join(' |')}${r.p14 || r.p30 ? ` || ≤14 j ${r.p14.toFixed(0).padStart(2)} % · ≤30 j ${r.p30.toFixed(0).padStart(2)} % · échec ≤14 j ${r.f14.toFixed(0).padStart(2)} %` : ''}`;
  const better = (r, ref, id) => r.per.every((p, i) => p >= ref.per[i] - 0.5) && (id !== 'lucid' || (r.p14 >= ref.p14 - 0.5 && r.f14 <= ref.f14 + 0.5))
    && (r.per.some((p, i) => p > ref.per[i] + 0.5) || (id === 'lucid' && (r.p14 > ref.p14 + 0.5 || r.p30 > ref.p30 + 0.5)));
  const ref = { ftmo: evaluate('ftmo', accts.ftmo.list), lucid: evaluate('lucid', accts.lucid.list) };
  const line = (id, name, r) => console.log(`${better(r, ref[id], id) ? '✅' : '  '} ${id.padEnd(5)} ${name.padEnd(46)} ${fmt(r)}`);
  console.log(`Référence · FTMO ${fmt(ref.ftmo)}\n            Lucid ${fmt(ref.lucid)}  (réussite < 1 an 2009–19 | 2020–26 | nov. 24–26)\n`);

  const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null; const want = (n) => !ONLY || ONLY.includes(String(n));
  /* ---------- 1. Prop firms de futures : réussite et coût par compte financé ---------- */
  if (want(1)) {
  console.log('=== 1. Prop firms (évaluation 50K, stratégies du compte Lucid) ===');
  // price : [catalogue, promo] ; monthly : abonnement par tranche de 30 jours ; act : activation à la réussite
  const FIRMS = [
    { name: 'LucidFlex 50K (actuel)', o: {}, price: [136, 70] },
    { name: 'Tradeify Select 50K', o: { bestDayPct: 40 }, price: [165, 99] },
    { name: 'Topstep 50K (sans limite du jour)', o: { bestDayPct: 55, lockAt: 0 }, price: [49, 49], monthly: true, act: 149 },
    { name: 'Apex 50K EOD (perte du jour 1 000 $)', o: { bestDayPct: 0, lockAt: null, minDays: 1, dayStopPct: 2 }, price: [167, 35], monthly: true },
    { name: 'Take Profit Trader 50K', o: { bestDayPct: 0, minDays: 5 }, price: [170, 102], monthly: true },
  ];
  const firmStats = (o, l, a, b) => {
    const xs = l.filter((t) => t.entryT >= a && t.entryT < b).sort((x, y) => x.entryT - y.entryT);
    const end = Math.min(b, xs[xs.length - 1].entryT) - 120 * DAY; const runs = [];
    for (let s = a; s < end; s += DAY) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      const r = runPhase(xs.filter((t) => t.entryT >= s && t.entryT < s + 365 * DAY), { ...RL, ...o, from: s });
      runs.push({ pass: r.outcome === 'target', days: Math.max(1, (r.outcome === 'open' ? 365 * DAY : r.at - s) / DAY) });
    }
    return runs;
  };
  for (const F of FIRMS) {
    const cells = Object.entries(P).map(([k, [a, b]]) => {
      const runs = firmStats(F.o, accts.lucid.list.filter((t) => inPer(t, k, a, b)), a, Number.isFinite(b) ? b : Infinity);
      const p = runs.filter((r) => r.pass).length / runs.length;
      const med = runs.filter((r) => r.pass).map((r) => r.days).sort((x, y) => x - y);
      const cost = (pr) => { const c = runs.reduce((s, r) => s + (F.monthly ? pr * Math.ceil(r.days / 30) : pr) + (r.pass ? F.act || 0 : 0), 0) / runs.length; return p > 0 ? c / p : Infinity; };
      return `${(p * 100).toFixed(0).padStart(3)} % (${med.length ? med[Math.floor(med.length / 2)].toFixed(0) : '—'} j) ${Math.round(cost(F.price[0])).toLocaleString('fr-FR').padStart(5)} $ / ${Math.round(cost(F.price[1])).toLocaleString('fr-FR').padStart(5)} $`;
    });
    console.log(`   ${F.name.padEnd(38)} ${cells.join(' | ')}`);
  }
  console.log('   (réussite < 1 an (délai médian) · coût par compte financé au prix catalogue / promo ; 2009–19 | 2020–26 | nov. 24–26)\n');
  }

  /* ---------- 2. Renfort des gagnants (FTMO, journalières) ---------- */
  if (want(2)) {
  console.log('=== 2. Renfort des gagnants : 2e part à +1 R, stop de l’ensemble au prix d’entrée (journalières FTMO) ===');
  const ACT = cfg.ftmoTrailActR || 2; const DIST = cfg.ftmoTrailDistR ?? 1;
  const withStops = (s, be) => ({
    ...s,
    trail(pos, ind, i) {
      const prev = s.trail ? s.trail(pos, ind, i) : NaN;
      const long = pos.side === 'long'; const r = Math.abs(pos.entry - pos.initSl);
      const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
      let next = NaN;
      if (fav >= ACT * r) next = long ? pos.best - DIST * r : pos.best + DIST * r;
      if (be && fav >= r) next = Number.isFinite(next) ? (long ? Math.max(next, pos.entry) : Math.min(next, pos.entry)) : pos.entry;
      if (!Number.isFinite(next)) return prev;
      if (!Number.isFinite(prev)) return next;
      return long ? Math.max(prev, next) : Math.min(prev, next);
    },
  });
  const dailySids = accts.ftmo.sids.filter((k) => (strat(k)[1].tf || '1d') === '1d');
  const dailyOf = async (be) => (await buildTrades(cfg, CACHE, { wrap: (s) => withStops(s, be) })).all.filter((t) => dailySids.includes(t.sid)).map((t) => ({ ...t, riskPct: accts.ftmo.A.riskOf(...strat(t.sid), 'eval') }));
  const trailD = await dailyOf(false), beD = await dailyOf(true);
  const key = (t) => `${t.sid}|${t.entryT}`;
  const beMap = new Map(beD.map((t) => [key(t), t]));
  const pyramid = trailD.map((t) => {
    const u = beMap.get(key(t)); if (!u) return t;
    const r = Math.abs(u.entry - u.initSl); const fav = u.side === 'long' ? u.best - u.entry : u.entry - u.best;
    if (!(fav >= r)) return t;
    const rb = R(u); // 1re part avec stop au prix d'entrée dès +1 R ; 2e part entrée à +1 R, même sortie
    return { ...t, pnlPct: (rb + (rb - 1)) * stopPct(u) - 0.02, exitT: u.exitT };
  });
  const intraF = accts.ftmo.list.filter((t) => t.intraday);
  const dailyRef = accts.ftmo.list.filter((t) => !t.intraday);
  const fundedOf = (l) => {
    const x = l.filter((t) => !(t.intraday && t.market !== 'gold')); let n = 0, paid = 0, lost = 0;
    for (let s = Y(2009) + 60 * DAY; s < Y(2025); s += 7 * DAY) {
      const r = fundedRun(x, { ...RF, riskMul: cfg.ftmoFundedRiskMul ?? 0.75, dayProfitCapUsd: Infinity, maxLossesPerDay: Infinity, funded: { rule: 'ftmo', every: 14, days: 365 } }, s);
      n++; paid += r.paid * 0.8; if (r.lost && r.months <= 12) lost++;
    }
    return `financé 12 mois : retraits ${Math.round(paid / n).toLocaleString('fr-FR').padStart(6)} $ · perdus ${((lost / n) * 100).toFixed(0)} %`;
  };
  const rs = (l) => { const x = l.map(R); return `${sgn(x.reduce((a, b) => a + b, 0) / x.length)} R/trade (${x.length})`; };
  for (const [name, d] of [['journalières telles quelles', dailyRef], ['stop suiveur (comme en direct)', trailD], ['stop suiveur + renfort à +1 R', pyramid]]) {
    const l = [...d, ...intraF];
    console.log(`   ${name.padEnd(32)} ${rs(d)} · éval. ${fmt(evaluate('ftmo', l))} · ${fundedOf(l)}`);
  }
  console.log('');
  }

  /* ---------- 3. Taille selon la corrélation ---------- */
  if (want(3)) {
  console.log('=== 3. Taille selon la corrélation (réduction × 0,5) ===');
  const base = RULES[cfg.ftmoSizing];
  const same = (tr, st) => { let n = 0; for (const o of st.openTrades || []) if (CLUSTER[o.market] === CLUSTER[tr.market]) n++; return n; };
  const SZ = {
    'même groupe ≥ 1 ouverte': (tr, st) => (same(tr, st) >= 1 ? 0.5 : 1),
    'même groupe ≥ 2 ouvertes': (tr, st) => (same(tr, st) >= 2 ? 0.5 : 1),
    'même groupe ≥ 1, ou 3 ouvertes en tout': (tr, st) => (same(tr, st) >= 1 ? 0.5 : 1) * (st.open >= 3 ? 0.5 : 1),
    'actuel × groupe (≥ 1 du même groupe)': (tr, st) => base(tr, st) * (same(tr, st) >= 1 ? 0.5 : 1),
  };
  for (const [name, sz] of Object.entries(SZ)) for (const id of ['ftmo', 'lucid']) line(id, name, evaluate(id, accts[id].list, { sizer: sz }));
  console.log('');
  }

  /* ---------- 4. Structure du VIX ---------- */
  if (want(4)) {
  console.log('=== 4. Structure du VIX (VIX / VIX3M de la veille) ===');
  const vix = await cachedYahoo(CACHE, '^VIX', '1d'), v3 = await cachedYahoo(CACHE, '^VIX3M', '1d');
  const v3m = new Map(v3.map((k) => [Math.floor(k.t / DAY), k.c]));
  const ts = vix.filter((k) => v3m.has(Math.floor(k.t / DAY))).map((k) => ({ t: k.t, r: k.c / v3m.get(Math.floor(k.t / DAY)) }));
  const ratioAt = (t) => { let lo = 0, hi = ts.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m].t + DAY <= t) { ans = ts[m].r; lo = m + 1; } else hi = m - 1; } return ans; };
  console.log(`   ${ts.length} jours de VIX3M (${new Date(ts[0].t * 1000).getUTCFullYear()} → ) · stress (> 1) ${((ts.filter((x) => x.r > 1).length / ts.length) * 100).toFixed(0)} % des jours`);
  const VX = {
    'pas de journalière en stress (> 1)': (t, r) => (!t.intraday && r > 1 ? 0 : 1),
    'pas d’intraday en stress (> 1)': (t, r) => (t.intraday && r > 1 ? 0 : 1),
    'tout × 0,5 en stress (> 1)': (t, r) => (r > 1 ? 0.5 : 1),
    'intraday × 1,5 au calme (< 0,85)': (t, r) => (t.intraday && r < 0.85 ? 1.5 : 1),
    'journalières × 1,5 au calme (< 0,85)': (t, r) => (!t.intraday && r < 0.85 ? 1.5 : 1),
  };
  for (const [name, f] of Object.entries(VX)) {
    for (const id of ['ftmo', 'lucid']) {
      const l = accts[id].list.map((t) => { const r = ratioAt(t.entryT); const m = r === null ? 1 : f(t, r); return m === 1 ? t : m === 0 ? null : { ...t, riskPct: t.riskPct * m }; }).filter(Boolean);
      line(id, name, evaluate(id, l));
    }
  }
  console.log('');
  }

  /* ---------- 5. Risque selon l'heure ---------- */
  if (want(5)) {
  console.log('=== 5. Risque selon l’heure d’entrée (intraday) ===');
  const grp = (t) => (t.market === 'gold' ? 'or' : 'US');
  const SEL = { or: [Y(2009), Y(2020)], US: [A0, A0 + 365 * DAY] }; const VER = { or: [Y(2020), Infinity], US: [A0 + 365 * DAY, Infinity] };
  const allIntra = [...new Map([...accts.ftmo.list, ...accts.lucid.list].filter((t) => t.intraday).map((t) => [key(t), t])).values()];
  const mulOf = {};
  for (const g of ['or', 'US']) {
    const sel = allIntra.filter((t) => grp(t) === g && t.entryT >= SEL[g][0] && t.entryT < SEL[g][1]);
    const by = {}; for (const t of sel) (by[nyHour(t.entryT)] ||= []).push(R(t));
    const ver = allIntra.filter((t) => grp(t) === g && t.entryT >= VER[g][0] && t.entryT < VER[g][1]);
    const vby = {}; for (const t of ver) (vby[nyHour(t.entryT)] ||= []).push(R(t));
    const out = [];
    for (const [h, xs] of Object.entries(by).sort((a, b) => a[0] - b[0])) {
      const avg = xs.reduce((a, b) => a + b, 0) / xs.length;
      const m = xs.length < 30 ? 1 : avg > 0.1 ? 1.5 : avg < 0 ? 0.5 : 1;
      mulOf[`${g}:${h}`] = m;
      const v = vby[h] || []; const vavg = v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
      out.push(`${h} h ${sgn(avg)} → ${Number.isFinite(vavg) ? sgn(vavg) : '—'} (×${m})`);
    }
    console.log(`   ${g} (heure de New York ; choix → vérification) : ${out.join(' · ')}`);
    const w = ver.map((t) => R(t) * (mulOf[`${g}:${nyHour(t.entryT)}`] ?? 1)); const wsum = ver.reduce((a, t) => a + (mulOf[`${g}:${nyHour(t.entryT)}`] ?? 1), 0);
    console.log(`     vérification : ${sgn(ver.reduce((a, t) => a + R(t), 0) / ver.length)} R/trade à risque égal → ${sgn(w.reduce((a, b) => a + b, 0) / wsum)} R par unité de risque avec les poids`);
  }
  for (const id of ['ftmo', 'lucid']) line(id, 'risque intraday selon l’heure', evaluate(id, accts[id].list.map((t) => (t.intraday ? { ...t, riskPct: t.riskPct * (mulOf[`${grp(t)}:${nyHour(t.entryT)}`] ?? 1) } : t))));
  console.log('   (2009–19 : choix pour l’or, donc flatteur ; regarder 2020–26 et nov. 24–26)\n');
  }

  /* ---------- 6. Résultats d'entreprises (actions intraday FTMO) ---------- */
  if (want(6)) {
  console.log('=== 6. Pas de trade intraday sur une action le jour de ses résultats ===');
  const earn = {};
  for (const [m, tk] of Object.entries(STOCKS)) {
    if (m === 'tlt') continue; // ETF obligataire : pas de résultats
    const d = await cachedYahoo(CACHE, tk, '1d'); const days = new Set(); const gaps = [];
    for (let i = 1; i < d.length; i++) {
      const g = Math.abs(d[i].o / d[i - 1].c - 1); const med = gaps.length >= 20 ? [...gaps.slice(-60)].sort((a, b) => a - b)[Math.floor(Math.min(60, gaps.length) / 2)] : 0.01;
      if (g > Math.max(0.03, 4 * med)) days.add(nyDay(d[i].t + 14 * 3600));
      gaps.push(g);
    }
    earn[m] = days;
  }
  const stockT = accts.ftmo.list.filter((t) => STOCKS[t.market] && t.intraday);
  const hit = stockT.filter((t) => earn[t.market]?.has(nyDay(t.entryT)));
  console.log(`   ${stockT.length} trades d’actions, dont ${hit.length} un jour de résultats : ${rs(hit.length ? hit : [{ pnlPct: 0, entry: 1, initSl: 0.99 }])} (autres jours : ${rs(stockT.filter((t) => !hit.includes(t)))})`);
  line('ftmo', 'sans les jours de résultats', evaluate('ftmo', accts.ftmo.list.filter((t) => !hit.includes(t))));
  console.log('');
  }

  /* ---------- 7. Or : entrée 1 min au lieu de 5 min (Binance XAUUSDT) ---------- */
  if (!want(7)) return;
  console.log('=== 7. Cassures de l’or : entrée sur la clôture 1 min au lieu de 5 min (XAUUSDT, Binance) ===');
  const bdir = path.join(CACHE, 'binance-xau'); fs.mkdirSync(bdir, { recursive: true });
  const m1 = [];
  for (let y = 2025, mo = 12; y < 2026 || (y === 2026 && mo <= 10); mo === 12 ? (y++, mo = 1) : mo++) {
    const tag = `${y}-${String(mo).padStart(2, '0')}`; const f = path.join(bdir, `XAUUSDT-1m-${tag}.csv`);
    if (!fs.existsSync(f)) {
      const z = path.join(bdir, `${tag}.zip`);
      execSync(`curl -sf -o ${z} https://data.binance.vision/data/futures/um/monthly/klines/XAUUSDT/1m/XAUUSDT-1m-${tag}.zip && unzip -p ${z} > ${f} && rm ${z}`);
    }
    for (const ln of fs.readFileSync(f, 'utf8').split('\n')) { const p = ln.split(','); if (!/^\d/.test(p[0] || '')) continue; m1.push({ t: Math.floor(+p[0] / 1000), o: +p[1], h: +p[2], l: +p[3], c: +p[4], v: +p[5] }); }
  }
  const b1 = metalsOpen(m1.sort((a, b) => a.t - b.t)); const b5 = aggregate(b1, 300, 60);
  console.log(`   ${b1.length.toLocaleString('fr-FR')} bougies 1 min (marché ouvert), ${new Date(b1[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(b1[b1.length - 1].t * 1000).toISOString().slice(0, 10)}`);
  for (const id of ['g_orb30', 'g_orb60', 'g_asiabrk', 'g_nypdl', 'g_gap', 'g_mom8']) {
    const s = selectStrategies([id])[0]; if (!s) continue;
    const run = (bars, sec) => { try { return backtest(s, bars, { size: 1000, feePct: 0.005, financingPct: 4, barSec: sec, ind: s.compute(bars, sec, 'gold'), market: 'gold' }).list; } catch (e) { return null; } };
    const l5 = run(b5, 300), l1 = run(b1, 60);
    if (!l5 || !l1) { console.log(`   ${id} : non testable en 1 min`); continue; }
    const tot = (l) => l.reduce((a, t) => a + t.pnlPct, 0);
    console.log(`   ${id.padEnd(10)} 5 min : ${String(l5.length).padStart(3)} trades, ${rs(l5)}, total ${sgn(tot(l5), 1)} %  ·  1 min : ${String(l1.length).padStart(3)} trades, ${rs(l1)}, total ${sgn(tot(l1), 1)} %`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
