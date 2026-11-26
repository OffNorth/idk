#!/usr/bin/env node
/**
 * Améliorations Lucid (npm run lucid-improve), règles officielles du compte financé (centre d'aide Lucid, oct. 2026) :
 *   1. Moment du retrait (compte financé) : retrait seulement s'il reste au moins X $ au-dessus de capital + 100 $ après
 *      le retrait (la perte max se bloque à capital + 100 $ dès le 1er retrait), ou seulement le retrait maximum.
 *   2. Réglages propres à chaque évaluation (LUCID_SPLIT) : risque et gestion de la journée de l'évaluation intraday et
 *      de l'évaluation journalière.
 *   3. Trois évaluations (intraday Nasdaq | intraday argent, Dow, S&P | journalières) au lieu de deux.
 *   4. Stratégies du compte financé : tout, intraday seulement, journalières seulement.
 *   5. Autres formules Lucid (LucidPro, LucidDaily, LucidMaxx) avec leurs règles 50K.
 *   6. Option « régularité 50 % » de l'évaluation.
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
    sizer: require('./src/sizing').ruleFor(cfg, 'FTMO'), dayProfitCapUsd: (cfg.ftmoDayProfitCapPct / 100) * 10_000, maxLossesPerDay: cfg.ftmoMaxLossesDay || Infinity };
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
  const LIST = (id) => accts[id].list;
  const lucidOpen = (l, a) => l.filter((t) => t.entryT >= a).sort((x, y) => x.entryT - y.entryT);
  const starts = (a, b, step = DAY) => { const out = []; for (let s = a; s < b; s += step) { const wd = new Date(s * 1000).getUTCDay(); if (wd !== 0 && wd !== 6) out.push(s); } return out; };
  const pc = (x) => `${(x * 100).toFixed(0).padStart(3)} %`;
  const usd = (x) => (Number.isFinite(x) ? `${Math.round(x).toLocaleString('fr-FR')} $` : '—');
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  // Périodes Lucid : nov. 24–26 (tout, départ chaque jour ouvré) ; 2009–19 et 2020–26 (journalières, départ chaque semaine)
  const LP = { 'nov. 24–26': [A0, Infinity, DAY, true], '2009–19': [Y(2009) + 60 * DAY, Y(2020), 7 * DAY, false], '2020–26': [Y(2020), Infinity, 7 * DAY, false] };
  const sub = (l, withIntra) => l.filter((t) => withIntra || !(t.intraday && t.market !== 'gold'));
  const PRICE50 = 136, PRICE100 = 230; // LucidFlex 50K / 100K (prix catalogue ; 100K estimé, à vérifier)

  /* ---------- 3 et 4. Lucid 100K, objectifs plus longs une fois financé ---------- */
  const lucidPayout = (minDay, cap) => {
    let good = 0; let nPay = 0; let cycleStart = -Infinity;
    return ({ day, balance, capital, dayPnl }) => {
      if ((dayPnl.get(day) || 0) >= minDay) good++;
      const gain = balance - capital;
      if (nPay >= 5 || good < 5 || gain <= 0 || balance <= cycleStart) return 0; // 5 retraits au plus, gain net positif sur le cycle
      const amt = Math.min(gain * 0.5, cap);
      if (amt < 500) return 0;
      good = 0; nPay++; cycleStart = balance - amt;
      return amt;
    };
  };
  // Compte financé Lucid (règles officielles, oct. 2026) : contrats selon le gain, perte max bloquée dès le 1er retrait
  const RLF = { ...RL, target: Infinity, bestDayPct: 0, minDays: 0, dayProfitCapUsd: Infinity, maxLossesPerDay: Infinity, scaling: [[0, 20], [1000, 30], [2000, 40]], lockOnPayout: true };
  const cushionLucid = (t, st) => (RULES[cfg.ftmoSizing] || RULES.fixe)(t, st) * require('./src/sizing').cushionMul(st.room);
  const fundedLucid = (l, o = {}, { minDay = 150, cap = 2000 } = {}) => {
    const xs = l.filter((t) => t.entryT >= A0).sort((x, y) => x.entryT - y.entryT);
    const end = xs[xs.length - 1].entryT - 365 * DAY; let n = 0, paid = 0, lost = 0, p60 = 0;
    for (const s of starts(A0, end > A0 ? end : xs[xs.length - 1].entryT - 200 * DAY)) {
      n++;
      const r = runPhase(xs, { ...RLF, ...o, from: s, until: s + 365 * DAY, payout: lucidPayout(minDay, cap) });
      paid += r.paid.reduce((a, p) => a + p.amount, 0) * 0.9;
      if (r.paid.length && r.paid[0].t - s <= 60 * DAY) p60++;
      if (r.outcome === 'maxloss') lost++;
    }
    return { paid: paid / n, lost: lost / n, p60: p60 / n };
  };
  const fundedRisk = (l) => l.map((t) => ({ ...t, riskPct: accts.lucid.A.riskOf(...strat(t.sid), 'funded') }));

  const RLE = RL; // évaluation Lucid (réglages actuels)
  const L = LIST('lucid');
  const isNas = (t) => t.intraday && t.market === 'nas100';
  const INTRA = L.filter((t) => t.intraday), DAILY = L.filter((t) => !t.intraday);
  const EV_MUL = cfg.lucidEvalIntradayMul ?? 3;

  /* Compte financé : départ chaque jour ouvré (nov. 24–25, tout) et chaque semaine (2020–24, journalières seules) */
  const FP = { 'nov. 24–26': [A0, true, DAY], '2020–24': [Y(2020), false, 7 * DAY] };
  const payoutWith = ({ buffer = 0, maxOnly = false, minDay = 150, cap = 2000 } = {}) => {
    let good = 0, nPay = 0, cycleStart = -Infinity;
    return ({ day, balance, capital, dayPnl }) => {
      if ((dayPnl.get(day) || 0) >= minDay) good++;
      const gain = balance - capital;
      if (nPay >= 5 || good < 5 || gain <= 0 || balance <= cycleStart) return 0;
      const amt = Math.min(gain * 0.5, cap);
      if (amt < 500 || (maxOnly && amt < cap)) return 0;
      if (balance - amt < capital + 100 + buffer) return 0; // marge gardée au-dessus de la perte max bloquée
      good = 0; nPay++; cycleStart = balance - amt;
      return amt;
    };
  };
  const funded = (l, o = {}, pay = {}) => Object.fromEntries(Object.entries(FP).map(([k, [a, intra, step]]) => {
    const xs = l.filter((t) => (intra || !t.intraday) && t.entryT >= a).sort((x, y) => x.entryT - y.entryT);
    if (!xs.length) return [k, null];
    const b = intra ? xs[xs.length - 1].entryT - 365 * DAY : Y(2025);
    let n = 0, paid = 0, lost = 0, p60 = 0, nPays = 0;
    for (const s of starts(a, b > a ? b : xs[xs.length - 1].entryT - 200 * DAY, step)) {
      n++;
      const r = runPhase(xs, { ...RLF, ...o, from: s, until: s + 365 * DAY, payout: payoutWith(pay) });
      paid += r.paid.reduce((x, p) => x + p.amount, 0) * 0.9; nPays += r.paid.length;
      if (r.paid.length && r.paid[0].t - s <= 60 * DAY) p60++;
      if (r.outcome === 'maxloss') lost++;
    }
    return [k, { paid: paid / n, p60: p60 / n, lost: lost / n, nPays: nPays / n }];
  }));
  const fline = (name, f) => console.log(`   ${name.padEnd(44)} ${Object.entries(f).map(([k, v]) => (v ? `${k} : retraits 12 mois ${usd(v.paid).padStart(7)} (${v.nPays.toFixed(1)} retraits) · 1er ≤ 60 j ${pc(v.p60)} · perdus ${pc(v.lost)}` : `${k} : —`)).join('  |  ')}`);
  const FL = fundedRisk(L); // risque « financé » actuel (× LUCID_FUNDED_RISK_MUL)

  /* ---------- 1. Moment du retrait ---------- */
  if (want(1)) {
    console.log('=== 1. Compte financé : moment du retrait (perte max bloquée à capital + 100 $ dès le 1er retrait) ===');
    for (const [name, pay] of [['dès que possible (actuel)', {}], ['marge ≥ 500 $ après le retrait', { buffer: 500 }], ['marge ≥ 1 000 $', { buffer: 1000 }],
      ['marge ≥ 1 500 $', { buffer: 1500 }], ['marge ≥ 2 000 $ (= une perte max entière)', { buffer: 2000 }], ['seulement le retrait maximum (2 000 $)', { maxOnly: true }],
      ['retrait max + marge ≥ 1 000 $', { maxOnly: true, buffer: 1000 }]]) fline(name, funded(FL, {}, pay));
    console.log('');
  }

  /* ---------- 2. Réglages propres à chaque évaluation ---------- */
  const evalStats = (l, o = {}, windows = ['B', 'C', 'A']) => {
    const r = evaluate('lucid', l, o);
    return { per: r.per, p14: r.p14, p30: r.p30, f14: r.f14 };
  };
  const scale = (l, m) => (m === 1 ? l : l.map((t) => ({ ...t, riskPct: t.riskPct * m })));
  const fmtE = (r, intraOnly) => (intraOnly ? `nov. 24–26 ${r.per[2].toFixed(0).padStart(3)} %` : `${r.per.map((p) => `${p.toFixed(0).padStart(3)} %`).join(' |')}`) + ` · ≤14 j ${pc(r.p14 / 100)} · ≤30 j ${pc(r.p30 / 100)} · échec ≤14 j ${pc(r.f14 / 100)}`;
  const DM = { 'journée : +750 $ ou 1 perte (actuel)': {}, 'sans gestion de la journée': { dayProfitCapUsd: Infinity, maxLossesPerDay: Infinity },
    'arrêt après 1 perte seulement': { dayProfitCapUsd: Infinity }, 'arrêt à +750 $ seulement': { maxLossesPerDay: Infinity }, 'arrêt après 2 pertes': { maxLossesPerDay: 2 } };
  if (want(2)) {
    console.log('=== 2a. Évaluation intraday seule : risque et gestion de la journée (nov. 24–26) ===');
    for (const m of [2 / 3, 1, 4 / 3]) for (const [dn, o] of Object.entries(DM)) {
      if (m !== 1 && dn !== Object.keys(DM)[0]) continue;
      console.log(`   × ${(EV_MUL * m).toFixed(0)} (risque intraday ${(0.45 * EV_MUL * m).toFixed(2)} %), ${dn.padEnd(38)} ${fmtE(evalStats(scale(INTRA, m), o), true)}`);
    }
    console.log('=== 2b. Évaluation journalière seule : risque et gestion de la journée (2009–19 | 2020–26 | nov. 24–26) ===');
    for (const m of [0.75, 1, 1.5, 2]) for (const [dn, o] of Object.entries(DM)) {
      if (m !== 1 && dn !== Object.keys(DM)[0]) continue;
      console.log(`   journalières × ${String(m).padEnd(4)} ${dn.padEnd(38)} ${fmtE(evalStats(scale(DAILY, m), o), false)}`);
    }
    console.log('');
  }

  /* ---------- 3. Trois évaluations au lieu de deux ---------- */
  const multi = (lists, price = PRICE50, o = {}) => {
    const end = L[L.length - 1].entryT - 120 * DAY; let n = 0, any30 = 0, any365 = 0, fundedN = 0, bought = 0; const firsts = [];
    for (const s of starts(A0, end)) {
      n++; bought += lists.length; let first = Infinity;
      for (const x of lists) {
        const r = runPhase(x.filter((t) => t.entryT >= s && t.entryT < s + 365 * DAY), { ...RLE, ...o, from: s });
        if (r.outcome === 'target') { fundedN++; first = Math.min(first, (r.at - s) / DAY); }
      }
      if (first <= 30) any30++; if (Number.isFinite(first)) { any365++; firsts.push(first); }
    }
    return `au moins une réussie ≤ 30 j ${pc(any30 / n)} · < 1 an ${pc(any365 / n)} (${median(firsts).toFixed(0)} j) · financés par départ ${(fundedN / n).toFixed(2)} · coût par compte financé ${usd((bought * price) / fundedN)}`;
  };
  if (want(3)) {
    console.log('=== 3. Deux ou trois évaluations (nov. 24–26, départ chaque jour ouvré) ===');
    console.log(`   deux (intraday | journalières, actuel)            ${multi([INTRA, DAILY])}`);
    console.log(`   trois (intraday Nasdaq | autre intraday | journ.) ${multi([L.filter(isNas), L.filter((t) => t.intraday && !isNas(t)), DAILY])}`);
    console.log(`   trois (intraday | journ. S&P | autres journ.)     ${multi([INTRA, DAILY.filter((t) => t.market === 'spx'), DAILY.filter((t) => t.market !== 'spx')])}`);
    console.log('');
  }

  /* ---------- 4. Stratégies du compte financé ---------- */
  if (want(4)) {
    console.log('=== 4. Compte financé : quelles stratégies ===');
    fline('tout (actuel)', funded(FL));
    fline('intraday seulement', funded(FL.filter((t) => t.intraday)));
    fline('journalières seulement', funded(FL.filter((t) => !t.intraday)));
    fline('intraday Nasdaq + journalières', funded(FL.filter((t) => !t.intraday || isNas(t))));
    console.log('');
  }

  /* ---------- 5 et 6. Autres formules Lucid, option régularité 50 % ---------- */
  // PLANS : règles 50K des formules Lucid (centre d'aide Lucid), à compléter : [nom, évaluation (options runPhase), prix, financé (options), retraits]
  const PLANS = require('./data/research/lucid-plans.json');
  if (want(5) || want(6)) {
    console.log('=== 5 et 6. Formules Lucid (50K) et option régularité 50 % ===');
    for (const P of PLANS) {
      const intraR = evalStats(INTRA, P.eval), dailyR = evalStats(DAILY, P.eval);
      const both = multi([INTRA, DAILY], P.price, P.eval);
      const f = funded(FL, P.funded || {}, P.payout || {});
      console.log(`   ${P.name} (${P.price} $ l’évaluation)\n     évaluation intraday ${fmtE(intraR, true)}\n     évaluation journalière ${fmtE(dailyR, false)}\n     deux évaluations : ${both}`);
      fline('     financé', f);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
