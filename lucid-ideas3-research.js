#!/usr/bin/env node
/**
 * Idées Lucid, 3e série (npm run lucid-ideas3, 27/11/2026), réglages actuels : évaluation intraday (risque × 3, journée
 * finie à +750 $ ou après 1 perte), évaluation journalière (sans gestion de la journée), évaluation combinée, compte
 * financé journalières seulement à risque × 2, règles officielles du financé.
 *   1. Financé : journée finie dès +150 $ (jour gagnant qui compte pour le retrait), +200 / +300 $.
 *   2. Financé : risque × 2 jusqu'au 1er retrait puis × 1 (et l'inverse).
 *   3. Évaluations : risque × la marge restante avant la perte max (coussin, plancher 0,25 / 0,5).
 *   4. Évaluations : plafond du jour 30 / 35 / 40 % de l'objectif, ou calculé avec la règle des 40 %.
 *   5. Évaluations : dernière ligne droite, risque réduit à ce qu'il faut pour finir.
 *   6. Pause d'une stratégie qui décroche (N pertes de suite, ou sous sa moyenne récente), reprise après un gain fictif.
 *   7. Risque selon la volatilité (distance du stop, basée sur l'ATR, comparée aux 20 trades précédents).
 *   8. Rachat d'une évaluation différé après un échec (pause fixe, ou attendre que les stratégies repartent).
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
    const res = { per: cs.map((c) => c?.passRate ?? NaN), days: cs.map((c) => c?.medianDays), p14: 0, p30: 0, f14: 0 };
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
  const payoutWith = ({ buffer = 0, maxOnly = false, minDay = 150, cap = 2000, mode = 'flex' } = {}) => {
    let good = 0, nPay = 0, cycleStart = -Infinity, cycleDays = [];
    return ({ day, balance, capital, dayPnl }) => {
      if (mode === 'pro' || mode === 'daily') {
        // LucidPro : gain du cycle ≥ 500 $, meilleur jour ≤ 40 % du gain du cycle, solde gardé au-dessus de capital + 2 100 $,
        // 2 000 $ au 1er retrait puis 2 500 $ ; LucidDaily : chaque jour, tout ce qui dépasse capital + 2 100 $ (≥ 500 $)
        cycleDays.push(dayPnl.get(day) || 0);
        const above = balance - (capital + 2100);
        if (above < 500 || balance <= cycleStart) return 0;
        let amt = above;
        if (mode === 'pro') {
          const cyc = cycleDays.reduce((a, b) => a + b, 0);
          if (cyc < 500 || Math.max(...cycleDays) > 0.4 * cyc) return 0;
          amt = Math.min(above, nPay ? 2500 : 2000);
        }
        nPay++; cycleStart = balance - amt; cycleDays = [];
        return amt;
      }
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

  const evalStats = (l, o = {}) => { const r = evaluate('lucid', l, o); return { per: r.per, p14: r.p14, p30: r.p30, f14: r.f14 }; };
  const fmtE = (r, intraOnly) => (intraOnly ? `nov. 24–26 ${r.per[2].toFixed(0).padStart(3)} %` : `${r.per.map((p) => `${p.toFixed(0).padStart(3)} %`).join(' |')}`) + ` · ≤14 j ${pc(r.p14 / 100)} · ≤30 j ${pc(r.p30 / 100)} · échec ≤14 j ${pc(r.f14 / 100)}`;
  /* ---------- Réglages actuels ---------- */
  const NODM = { dayProfitCapUsd: Infinity, maxLossesPerDay: Infinity };
  const EVALS = { intraday: [INTRA, {}, true], daily: [DAILY, NODM, false], combined: [L, {}, false] };
  const FLD = FL.filter((t) => !t.intraday); // financé : journalières seulement, risque × 2
  const baseSizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const evRef = Object.fromEntries(Object.entries(EVALS).map(([k, [l, o]]) => [k, evalStats(l, o)]));
  const fRef = funded(FLD);
  const evBetter = (r, ref, intraOnly) => {
    const idx = intraOnly ? [2] : [0, 1, 2];
    const noWorse = idx.every((i) => !(r.per[i] < ref.per[i] - 0.5)) && r.p14 >= ref.p14 - 0.5 && r.f14 <= ref.f14 + 0.5 && r.p30 >= ref.p30 - 0.5;
    const some = idx.some((i) => r.per[i] > ref.per[i] + 0.5) || r.p14 > ref.p14 + 0.5 || r.p30 > ref.p30 + 0.5 || r.f14 < ref.f14 - 0.5;
    return noWorse && some;
  };
  const fBetter = (f) => Object.keys(fRef).every((k) => !fRef[k] || (f[k].paid >= fRef[k].paid - 25 && f[k].lost <= fRef[k].lost + 0.005))
    && Object.keys(fRef).some((k) => fRef[k] && (f[k].paid > fRef[k].paid + 25 || f[k].lost < fRef[k].lost - 0.005));
  const evLine = (name, mk) => {
    for (const [k, [l, o, intraOnly]] of Object.entries(EVALS)) {
      const [l2, o2] = mk(l, o, k);
      const r = evalStats(l2, o2);
      console.log(`${evBetter(r, evRef[k], intraOnly) ? '✅' : '  '} ${k.padEnd(9)} ${name.padEnd(44)} ${fmtE(r, intraOnly)}`);
    }
  };
  const fLine = (name, f) => { process.stdout.write(fBetter(f) ? '✅' : '  '); fline(name, f); };
  console.log('Référence (réglages actuels)');
  for (const [k, [, , intraOnly]] of Object.entries(EVALS)) console.log(`   ${k.padEnd(9)} ${fmtE(evRef[k], intraOnly)}`);
  fline('financé (journalières, × 2)', fRef);
  console.log('');

  /* ---------- 1. Financé : journée finie à +X $ ---------- */
  if (want(1)) {
    console.log('=== 1. Financé : plus de nouveau trade dès que la journée a fait +X $ ===');
    for (const cap of [150, 200, 300, 500]) fLine(`journée finie à +${cap} $`, funded(FLD, { dayProfitCapUsd: cap }));
    fLine('journée finie à +150 $ (toutes les stratégies)', funded(FL, { dayProfitCapUsd: 150 }));
    console.log('');
  }

  /* ---------- 2. Financé : risque selon les retraits ---------- */
  if (want(2)) {
    console.log('=== 2. Financé : risque avant / après le 1er retrait ===');
    fLine('× 2 puis × 1 après le 1er retrait', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 0.5 : 1) }));
    fLine('× 2 puis × 1,5 après le 1er retrait', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 0.75 : 1) }));
    fLine('× 1 puis × 2 après le 1er retrait', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 : 0.5) }));
    fLine('× 3 puis × 1 après le 1er retrait', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 0.5 : 1.5) }));
    console.log('');
  }

  /* ---------- 3. Évaluations : coussin avant la perte max ---------- */
  const cush = (lo) => (t, st) => baseSizer(t, st) * Math.min(1, Math.max(lo, st.room));
  if (want(3)) {
    console.log('=== 3. Évaluations : risque × marge restante avant la perte max ===');
    for (const lo of [0.25, 0.5, 0.75]) evLine(`coussin, plancher × ${lo}`, (l, o) => [l, { ...o, sizer: cush(lo) }]);
    fLine('financé : coussin plancher × 0,5 (rappel : × 0,25 refusé)', funded(FLD, { sizer: cush(0.5) }));
    console.log('');
  }

  /* ---------- 4. Évaluations : plafond du jour ---------- */
  if (want(4)) {
    console.log('=== 4. Évaluations : plafond de gain du jour (objectif 3 000 $, meilleur jour ≤ 40 %) ===');
    const TG = 50_000 * 0.06;
    for (const p of [30, 35, 40]) evLine(`plafond ${p} % de l'objectif (${(TG * p) / 100} $)`, (l, o) => [l, { ...o, dayProfitCapUsd: (TG * p) / 100 }]);
    // Règle des 40 % : un jour peut monter jusqu'à 40 % de l'objectif, ou plus si le gain déjà fait le permet (g ≤ 0,4 (G + g))
    const dyn = ({ capital, dayStart }) => Math.max(0.4 * TG, (0.4 / 0.6) * Math.max(0, dayStart - capital));
    evLine('plafond calculé (règle des 40 %)', (l, o) => [l, { ...o, dayProfitCapUsd: Infinity, dayCapFn: dyn }]);
    const dyn25 = ({ capital, dayStart }) => Math.max(0.25 * TG, (0.4 / 0.6) * Math.max(0, dayStart - capital));
    evLine('plafond calculé, au moins 750 $', (l, o) => [l, { ...o, dayProfitCapUsd: Infinity, dayCapFn: dyn25 }]);
    console.log('');
  }

  /* ---------- 5. Dernière ligne droite ---------- */
  const stretch = (k, lo) => (t, st) => {
    const need = st.capital * (1 + st.target / 100) - st.balance;
    const planned = (st.balance * (t.riskPct ?? 1)) / 100;
    return baseSizer(t, st) * (need > 0 ? Math.min(1, Math.max(lo, need / (k * planned))) : lo);
  };
  if (want(5)) {
    console.log('=== 5. Évaluations : près de l\'objectif, risque réduit à ce qu\'il faut pour finir ===');
    for (const [k, lo] of [[1, 0.25], [1, 0.5], [2, 0.25], [0.5, 0.25]]) evLine(`risque ≤ reste ÷ ${k} R (plancher × ${lo})`, (l, o) => [l, { ...o, sizer: stretch(k, lo) }]);
    console.log('');
  }

  /* ---------- 6. Pause d'une stratégie qui décroche ---------- */
  // Causal : on ne regarde que les trades (fictifs, tous pris) de la stratégie clôturés avant l'entrée
  const pauseFilter = (l, rule) => {
    const by = new Map();
    for (const t of [...l].sort((a, b) => a.exitT - b.exitT)) { if (!by.has(t.sid)) by.set(t.sid, []); by.get(t.sid).push(t); }
    return l.filter((t) => {
      const h = by.get(t.sid); let lo = 0, hi = h.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (h[m].exitT < t.entryT) lo = m + 1; else hi = m; }
      return rule(h.slice(Math.max(0, lo - 40), lo).map(R));
    });
  };
  const streakRule = (n) => (rs) => rs.length < n || rs.slice(-n).some((r) => r > 0);
  const maRule = (n) => (rs) => { if (rs.length < 2 * n) return true; let c = 0; const cum = rs.map((r) => (c += r)); const ma = cum.slice(-n).reduce((a, b) => a + b, 0) / n; return cum[cum.length - 1] >= ma; };
  if (want(6)) {
    console.log('=== 6. Pause d\'une stratégie qui décroche (reprise après un gain fictif) ===');
    for (const n of [3, 4, 5]) evLine(`pause après ${n} pertes de suite`, (l, o) => [pauseFilter(l, streakRule(n)), o]);
    for (const n of [10, 20]) evLine(`pause sous la moyenne de ses ${n} derniers trades`, (l, o) => [pauseFilter(l, maRule(n)), o]);
    for (const n of [3, 4]) fLine(`financé : pause après ${n} pertes de suite`, funded(pauseFilter(FLD, streakRule(n))));
    fLine('financé : pause sous la moyenne de 20 trades', funded(pauseFilter(FLD, maRule(20))));
    console.log('');
  }

  /* ---------- 7. Risque selon la volatilité ---------- */
  // Distance du stop (en %, basée sur l'ATR pour la plupart des stratégies) comparée à la médiane des 20 trades précédents
  const volScale = (l, lo, hi) => {
    const by = new Map();
    for (const t of [...l].sort((a, b) => a.entryT - b.entryT)) { if (!by.has(t.sid)) by.set(t.sid, []); by.get(t.sid).push(t); }
    const out = [];
    for (const h of by.values()) h.forEach((t, i) => {
      const prev = h.slice(Math.max(0, i - 20), i).map(stopPct).filter((x) => x > 0);
      const m = prev.length >= 10 ? median(prev) : NaN;
      const mul = Number.isFinite(m) && stopPct(t) > 0 ? Math.min(hi, Math.max(lo, m / stopPct(t))) : 1;
      out.push({ ...t, riskPct: t.riskPct * mul });
    });
    return out;
  };
  if (want(7)) {
    console.log('=== 7. Risque selon la volatilité (stop plus large que d\'habitude → moins de risque) ===');
    for (const [lo, hi] of [[0.5, 1], [0.5, 1.5], [0.25, 1], [0.75, 1.25]]) evLine(`risque × médiane ÷ stop, entre × ${lo} et × ${hi}`, (l, o) => [volScale(l, lo, hi), o]);
    for (const [lo, hi] of [[0.5, 1], [0.5, 1.5]]) fLine(`financé : entre × ${lo} et × ${hi}`, funded(volScale(FLD, lo, hi)));
    console.log('');
  }

  /* ---------- 8. Rachat différé après un échec ---------- */
  // Évaluations enchaînées pendant 1 an à partir de chaque départ : après un échec, rachat le lendemain (actuel) ou plus tard.
  const chain = (l, o, wait, a, step) => {
    const xs = [...l].sort((x, y) => x.entryT - y.entryT);
    const dayR = new Map(); for (const t of xs) { const d = cmeDay(t.exitT); dayR.set(d, (dayR.get(d) || 0) + R(t) * (t.riskPct || 1)); }
    const dayKeys = [...dayR.keys()].sort();
    const last = xs[xs.length - 1].entryT - 365 * DAY;
    let n = 0, bought = 0, fundedN = 0; const firsts = [];
    for (const s of starts(a, last, step)) {
      n++; let t = s, first = Infinity;
      while (t < s + 365 * DAY) {
        bought++;
        const r = runPhase(xs.filter((x) => x.entryT >= t && x.entryT < s + 365 * DAY), { ...RLE, ...o, from: t });
        if (r.outcome === 'target') { fundedN++; first = (r.at - s) / DAY; break; }
        if (r.outcome === 'open') { bought--; break; }
        t = wait(r.at, dayR, dayKeys);
      }
      if (Number.isFinite(first)) firsts.push(first);
    }
    return { cost: fundedN ? (bought * PRICE50) / fundedN : Infinity, rate: firsts.length / n, med: median(firsts), perStart: bought / n };
  };
  const nextDay = (at) => at + DAY;
  const pauseDays = (k) => (at) => at + k * DAY;
  const untilGood = (k) => (at, dayR, keys) => { // attendre que la somme des k derniers jours (fictifs) soit positive
    const d0 = cmeDay(at); const i0 = keys.findIndex((d) => d > d0); if (i0 < 0) return Infinity;
    for (let i = i0 + k - 1; i < keys.length; i++) {
      if (keys.slice(i - k + 1, i + 1).reduce((x, d) => x + dayR.get(d), 0) > 0) return Date.parse(`${keys[i]}T23:00:00Z`) / 1000 + 3600;
    }
    return Infinity;
  };
  if (want(8)) {
    console.log('=== 8. Rachat après un échec (évaluations enchaînées 1 an, 136 $ l\'évaluation) ===');
    const PER8 = { 'nov. 24–26': [A0, DAY, true], '2009–19': [Y(2009) + 60 * DAY, 7 * DAY, false], '2020–25': [Y(2020), 7 * DAY, false] };
    for (const [k, [l, o, intraOnly]] of Object.entries(EVALS)) {
      for (const [name, w] of [['rachat le lendemain (actuel)', nextDay], ['pause 5 jours', pauseDays(7)], ['pause 2 semaines', pauseDays(14)],
        ['attendre 3 jours fictifs positifs (somme)', untilGood(3)], ['attendre 5 jours fictifs positifs (somme)', untilGood(5)]]) {
        const parts = Object.entries(PER8).filter(([, [, , intra]]) => !intraOnly || intra).map(([pk, [a, step, intra]]) => {
          const xs = l.filter((t) => (intra || !t.intraday) && (pk !== '2009–19' || t.entryT < Y(2020)));
          if (!xs.length) return `${pk} —`;
          const c = chain(xs, o, w, a, step);
          return `${pk} : financé < 1 an ${pc(c.rate)} (${Number.isFinite(c.med) ? c.med.toFixed(0) : '—'} j) · ${c.perStart.toFixed(1)} éval. · ${usd(c.cost)}/financé`;
        });
        console.log(`   ${k.padEnd(9)} ${name.padEnd(42)} ${parts.join('  |  ')}`);
      }
    }
  }
  /* ---------- 9. Suite de l'idée 2 : risque avant / après le 1er retrait (risque de base = × 1 du financé) ---------- */
  if (want(9)) {
    console.log('=== 9. Financé : risque avant → après le 1er retrait (multiplicateurs du risque des journalières) ===');
    const F1 = FLD.map((t) => ({ ...t, riskPct: t.riskPct / (cfg.lucidFundedRiskMul || 2) }));
    for (const [b, a2] of [[2, 2], [2, 1], [3, 1], [3, 1.5], [3, 0.75], [4, 1], [4, 0.75], [5, 1], [3, 1, 2]]) {
      const after2 = a2;
      fLine(`× ${b} puis × ${after2}${b === 2 && after2 === 2 ? ' (actuel)' : ''}`, funded(F1, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? after2 : b) }));
    }
    fLine('× 3 puis × 1 après le 2e retrait', funded(F1, { sizer: (t, st) => baseSizer(t, st) * (st.paid >= 2 ? 1 : 3) }));
    console.log('');
  }
  /* ---------- 10. LucidFlex 150K au lieu de 50K ---------- */
  // Sources secondaires (nov. 2026, à vérifier) : objectif 9 000 $, perte max 4 500 $ suiveuse fin de journée bloquée à
  // capital + 100 $, 100 micros, régularité 40 %, retrait ≤ 3 000 $ (5 jours ≥ 250 $), ≈ 295 $ ; plan de scaling du
  // financé non publié : supposé 50 / 75 / 100 micros (0 / +1 500 / +3 000 $) ou 100 d'emblée.
  if (want(10)) {
    console.log('=== 10. LucidFlex 150K au lieu de 50K (réglages actuels) ===');
    const E150 = { capital: 150_000, maxLossUsd: 4500, maxContracts: 100, dayProfitCapUsd: 0.25 * 9000 };
    const F150 = { capital: 150_000, maxLossUsd: 4500, maxContracts: 100 };
    for (const [rn, rk] of [['même risque en %', 1], ['risque × 0,75 (même part de la perte max)', 0.75]]) {
      const sc = (l) => scale(l, rk);
      console.log(`  150K, ${rn}`);
      for (const [k, [l, o, intraOnly]] of Object.entries(EVALS)) {
        const o2 = { ...o, ...E150, ...(o.dayProfitCapUsd === Infinity ? { dayProfitCapUsd: Infinity } : {}) };
        console.log(`     ${k.padEnd(9)} ${fmtE(evalStats(sc(l), o2), intraOnly)}   (50K : ${fmtE(evRef[k], intraOnly)})`);
      }
      console.log(`     deux évaluations 150K : ${multi([sc(INTRA), sc(DAILY)], 295, E150)}`);
      for (const [sn, scaling] of [['scaling supposé 50/75/100', [[0, 50], [1500, 75], [3000, 100]]], ['100 micros d\'emblée', [[0, 100]]]]) {
        fline(`financé 150K, ${sn}`, funded(sc(FLD), { ...F150, scaling, sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1) }, { minDay: 250, cap: 3000 }));
      }
    }
    console.log(`  50K (actuel) : deux évaluations ${multi([INTRA, DAILY], PRICE50)}`);
    fline('financé 50K (actuel, × 3 puis × 1)', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1) }));
    console.log('');
  }
  console.log('\n✅ = rien ne baisse et au moins un chiffre monte (évaluations : réussite, ≤ 14 j, ≤ 30 j, échecs ≤ 14 j ; financé : retraits, comptes perdus)');
})().catch((e) => { console.error(e); process.exit(1); });
