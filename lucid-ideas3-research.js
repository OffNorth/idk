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
  const { all, q5, daily: DLY } = await buildTrades(cfg, CACHE, { withLucid: true });
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

  const scale = (l, m) => (m === 1 ? l : l.map((t) => ({ ...t, riskPct: t.riskPct * m })));
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
  /* ---------- 11. Pas de position inverse d'un compte Lucid à l'autre ---------- */
  // Approximation : chaque compte est supposé prendre tous ses signaux ; un trade est retiré si, à son entrée, un autre
  // compte Lucid tient une position inverse sur le même marché (le premier entré garde la main ; à égalité, l'ordre du bot :
  // financé, intraday, journalières, combinée). Le compte financé est supposé actif tout le temps (cas le plus serré).
  if (want(11)) {
    console.log('=== 11. Pas de position inverse d\'un compte Lucid à l\'autre (hedging entre comptes interdit) ===');
    const crossFilter = (books) => {
      const evs = [];
      books.forEach((b, bi) => b.list.forEach((t) => evs.push({ t, bi })));
      evs.sort((x, y) => x.t.entryT - y.t.entryT || x.bi - y.bi);
      const open = []; const keep = books.map(() => new Set());
      for (const { t, bi } of evs) {
        for (let i = open.length - 1; i >= 0; i--) if (open[i].t.exitT <= t.entryT) open.splice(i, 1);
        if (open.some((o) => o.bi !== bi && o.t.market === t.market && o.t.side !== t.side)) continue;
        keep[bi].add(t); open.push({ t, bi });
      }
      return books.map((b, bi) => b.list.filter((t) => keep[bi].has(t)));
    };
    const sets = { 'deux évaluations + financé': ['funded', 'intraday', 'daily'], 'trois évaluations + financé': ['funded', 'intraday', 'daily', 'combined'] };
    const LISTS = { funded: FLD, intraday: INTRA, daily: DAILY, combined: L };
    for (const [sn, ids] of Object.entries(sets)) {
      const out = crossFilter(ids.map((id) => ({ id, list: LISTS[id] })));
      console.log(`  ${sn}`);
      ids.forEach((id, i) => {
        const removed = LISTS[id].length - out[i].length;
        if (id === 'funded') { process.stdout.write(`     trades retirés ${removed} / ${LISTS[id].length}`); fline('financé', funded(out[i])); return; }
        const [, o, intraOnly] = EVALS[id];
        console.log(`     ${id.padEnd(9)} trades retirés ${String(removed).padStart(4)} / ${LISTS[id].length} · ${fmtE(evalStats(out[i], o), intraOnly)}   (sans : ${fmtE(evRef[id], intraOnly)})`);
      });
    }
    console.log('');
  }
  /* ---------- 12. Intraday or sur les évaluations Lucid (LUCID_EVAL_GOLD) ---------- */
  if (want(12)) {
    console.log('=== 12. Intraday or (MGC) ajouté aux évaluations intraday et combinée ===');
    const goldIds = cfg.lucidEvalGold.length ? cfg.lucidEvalGold : ['gold:g_orb30', 'gold:g_orb60', 'gold:g_mom8', 'gold:g_gap', 'gold:g_asiabrk', 'gold:g_nypdl'];
    const G = all.filter((t) => goldIds.includes(t.sid) && t.intraday).map((t) => ({ ...t, riskPct: (cfg.lucidIntradayRisk ?? 0.45) * (cfg.lucidEvalIntradayMul ?? 3) }));
    const noG = (l) => l.filter((t) => !goldIds.includes(t.sid));
    console.log(`   ${G.length} trades or (2009–2026)`);
    const one = (ids, risk) => all.filter((t) => ids.includes(t.sid) && t.intraday).map((t) => ({ ...t, riskPct: risk }));
    for (const [nm, ids] of [['les 6', goldIds], ['g_asiabrk + g_nypdl', ['gold:g_asiabrk', 'gold:g_nypdl']], ['g_orb30 seule', ['gold:g_orb30']], ['g_nypdl seule', ['gold:g_nypdl']]]) {
      for (const risk of [0.45, 0.2, 0.1]) {
        const r1 = evalStats([...noG(INTRA), ...one(ids, risk)].sort((x, y) => x.entryT - y.entryT), {});
        console.log(`   intraday + or ${nm.padEnd(20)} à ${String(risk).padEnd(4)} % ${fmtE(r1, true)}`);
      }
    }
    for (const [k, base, o, intraOnly] of [['intraday', noG(INTRA), {}, true], ['combined', noG(L), {}, false]]) {
      const r0 = evalStats(base, o), r1 = evalStats([...base, ...G].sort((x, y) => x.entryT - y.entryT), o);
      console.log(`   ${k.padEnd(9)} sans or ${fmtE(r0, intraOnly)}\n   ${''.padEnd(9)} avec or ${fmtE(r1, intraOnly)}`);
    }
    console.log('');
  }
  /* ---------- 13. Rendement Lucid avec les réglages actuels (×3 → ×1 financé, anti-hedging, or g_nypdl) ---------- */
  if (want(13)) {
    console.log('=== 13. Rendement Lucid, réglages actuels ===');
    const after = (k) => ({ sizer: (t, st) => baseSizer(t, st) * (st.paid ? k : 1) });
    const CUR = after(1 / 3);
    console.log('  a. Compte financé');
    fline('journalières, × 3 → × 1 (actuel)', funded(FLD, CUR));
    fline('+ intraday Nasdaq', funded(FL.filter((t) => !t.intraday || isNas(t)), CUR));
    fline('+ tout l\'intraday', funded(FL, CUR));
    for (const [nm, pay] of [['retrait si marge ≥ 1 000 $', { buffer: 1000 }], ['retrait si marge ≥ 1 500 $', { buffer: 1500 }], ['seulement le retrait max', { maxOnly: true }]]) fline(nm, funded(FLD, CUR, pay));
    console.log('  b. Séparer les marchés (anti-hedging entre comptes, approximation section 11)');
    const xf = (books) => { // même filtre que la section 11
      const evs = []; books.forEach((l, bi) => l.forEach((t) => evs.push({ t, bi })));
      evs.sort((x, y) => x.t.entryT - y.t.entryT || x.bi - y.bi);
      const open = []; const keep = books.map(() => new Set());
      for (const { t, bi } of evs) {
        for (let i = open.length - 1; i >= 0; i--) if (open[i].t.exitT <= t.entryT) open.splice(i, 1);
        if (open.some((o) => o.bi !== bi && o.t.market === t.market && o.t.side !== t.side)) continue;
        keep[bi].add(t); open.push({ t, bi });
      }
      return books.map((l, bi) => l.filter((t) => keep[bi].has(t)));
    };
    const intraMk = new Set(INTRA.map((t) => t.market));
    const ONLY13 = process.env.SEP ? process.env.SEP.split(',') : null;
    for (const [nm, drop, fDrop] of [['aucune séparation (actuel)', new Set(), new Set()], ['journalières sans Nasdaq', new Set(['nas100']), new Set(['nas100'])],
      ['journalières sans les marchés intraday', intraMk, intraMk], ['éval. journalière sans Nasdaq, financé inchangé', new Set(['nas100']), new Set()],
      ['éval. journalière sans Nasdaq ni Dow, financé inchangé', new Set(['nas100', 'dow']), new Set()]].filter((x, i) => !ONLY13 || ONLY13.includes(String(i)))) {
      const D = DAILY.filter((t) => !drop.has(t.market)), F = FLD.filter((t) => !fDrop.has(t.market));
      const [f2, i2, d2] = xf([F, INTRA, D]);
      console.log(`   ${nm}`);
      console.log(`      intraday  ${fmtE(evalStats(i2, {}), true)}`);
      console.log(`      daily     ${fmtE(evalStats(d2, NODM), false)}`);
      fline('      financé', funded(f2, CUR));
      console.log(`      deux évaluations : ${multi([i2, d2])}`);
    }
    console.log('  c. Évaluation intraday (avec or g_nypdl 0,2 %)');
    for (const [nm, l, o] of [['× 3 (actuel)', INTRA, {}], ['× 2', INTRA.map((t) => (t.market === 'gold' ? t : { ...t, riskPct: t.riskPct * 2 / 3 })), {}],
      ['× 3 + coussin plancher 0,5', INTRA, { sizer: cush(0.5) }], ['× 2 + coussin plancher 0,5', INTRA.map((t) => (t.market === 'gold' ? t : { ...t, riskPct: t.riskPct * 2 / 3 })), { sizer: cush(0.5) }]]) {
      console.log(`      ${nm.padEnd(30)} ${fmtE(evalStats(l, o), true)}`);
    }
    console.log('');
  }
  /* ---------- 14. Nouvelles stratégies Lucid (journalières hors Nasdaq, argent intraday) ---------- */
  if (want(14)) {
    console.log('=== 14. Nouvelles stratégies pour Lucid ===');
    const { computeAll } = require('./src/indicators');
    const CUR = { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1) };
    const DR = accts.lucid.A.riskOf('spx', selectStrategies(['double7'])[0], 'eval'); // risque des journalières Lucid (évaluation)
    const FMUL = cfg.lucidFundedRiskMul ?? 3;
    const MK = { spx: ['^GSPC', 5, 4], dow: ['^DJI', 0.5, 2.5], russell: ['^RUT', 5, 2.5], silver: ['SI=F', 1000, 3.5] };
    const vix = (await cachedYahoo(CACHE, '^VIX', '1d', {}, 72)).filter((k) => k.c > 0);
    const D = {}; for (const [m, [sym]] of Object.entries(MK)) D[m] = (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0);
    const goldD = (await cachedYahoo(CACHE, 'GC=F', '1d', {}, 72)).filter((k) => k.c > 0);
    const tag = (l, m, sid) => l.map((t) => ({ ...t, sid, market: m, intraday: false, contractUsd: t.entry * MK[m][1], contractFee: MK[m][2] }));
    const per3 = (l) => [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]].map(([a2, b]) => rStats(l.filter((t) => t.entryT >= a2 && t.entryT < b)));
    const cands = [];
    const have = new Set([...DAILY, ...FLD].map((t) => t.sid));
    // 1, 2, 5 : stratégies existantes sur S&P, Dow, Russell, argent
    for (const [m] of Object.entries(MK)) {
      const ind = computeAll(D[m], D[m], 86400, null, vix, {});
      for (const id of ['tom', 'rsi2', 'ibs', 'down3', 'double7', 'cumrsi', 'n_low10', 'dip5', 'n_drop', 'n_2down', 'n_weekrev']) {
        const sid = `${m}:${id}`; if (have.has(sid)) continue;
        const st = selectStrategies([id])[0]; if (!st) continue;
        let l; try { l = backtest(st, D[m], { size: 1000, feePct: 0.01, financingPct: 5, barSec: 86400, ind, daily: D[m], vix }).list; } catch (e) { console.log(`   ${sid} : erreur ${e.message}`); continue; }
        cands.push({ sid, fam: id === 'tom' ? 'fin de mois' : id === 'n_weekrev' ? 'semaine' : 'portage', l: tag(l, m, sid) });
      }
    }
    // Simulateur journalier simple (achat à la clôture, stop 3 ATR touché par le plus bas, sortie à la clôture)
    const atr = (d) => { const out = []; let a2 = 0; d.forEach((k, i) => { const tr = i ? Math.max(k.h - k.l, Math.abs(k.h - d[i - 1].c), Math.abs(k.l - d[i - 1].c)) : k.h - k.l; a2 = i < 14 ? (a2 * i + tr) / (i + 1) : (a2 * 13 + tr) / 14; out.push(a2); }); return out; };
    const simLong = (d, enter, exit, maxHold = 10) => {
      const A2 = atr(d), out = []; let pos = null;
      for (let i = 30; i < d.length; i++) {
        const k = d[i];
        if (pos) {
          const held = i - pos.i;
          let px = null;
          if (k.l <= pos.sl) px = Math.min(k.o, pos.sl); else if (exit(i, pos) || held >= maxHold) px = k.c;
          if (px !== null) { out.push({ side: 'long', entry: pos.entry, sl: pos.sl, initSl: pos.sl, entryT: pos.t, exit: px, exitT: k.t + 86400 - 3600, pnlPct: (px / pos.entry - 1) * 100 - 0.02, worstPct: (Math.min(pos.low, k.l) / pos.entry - 1) * 100 }); pos = null; continue; }
          pos.low = Math.min(pos.low, k.l);
        } else if (enter(i)) pos = { i, entry: k.c, sl: k.c - 3 * A2[i], t: k.t + 86400 - 3600, low: k.c };
      }
      return out;
    };
    const byDate = (d) => new Map(d.map((k) => [new Date(k.t * 1000).toISOString().slice(0, 10), k.c]));
    // 3. Russell en retard sur le S&P (5 jours) → achat du Russell
    { const R = D.russell, S = byDate(D.spx); const sc = R.map((k) => S.get(new Date(k.t * 1000).toISOString().slice(0, 10)));
      const ret = (i, n) => (R[i].c / R[i - n].c) - (sc[i] && sc[i - n] ? sc[i] / sc[i - n] : 1);
      for (const thr of [0.02, 0.03]) {
        const l = simLong(R, (i) => sc[i] && sc[i - 5] && ret(i, 5) < -thr, (i) => sc[i] && sc[i - 5] && ret(i, 5) > 0, 10);
        cands.push({ sid: `russell:x_rutspx${thr * 100}`, fam: 'Russell / S&P', l: tag(l, 'russell', `russell:x_rutspx${thr * 100}`) });
      } }
    // 4. Ratio or / argent au plus haut sur 20 jours → achat de l'argent
    { const Sv = D.silver, G = byDate(goldD); const r = Sv.map((k) => { const g = G.get(new Date(k.t * 1000).toISOString().slice(0, 10)); return g ? g / k.c : null; });
      for (const n of [20, 60]) {
        const l = simLong(Sv, (i) => r[i] && r.slice(i - n, i).every((x) => x && x < r[i]), (i, p) => r[i] && r.slice(i - 10, i).filter(Boolean).reduce((a2, x, _, arr) => a2 + x / arr.length, 0) > r[i], 10);
        cands.push({ sid: `silver:x_gsratio${n}`, fam: 'ratio or / argent', l: tag(l, 'silver', `silver:x_gsratio${n}`) });
      } }
    // 6. Argent intraday : panoplie « objectif 0,5 R » du Nasdaq
    const IR = (cfg.lucidIntradayRisk ?? 0.45) * (cfg.lucidEvalIntradayMul ?? 3);
    const intraC = [];
    for (const id of ['n_mom10_t05', 'n_orb15_t05', 'n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05', 'n_crabel4_t05', 'n_crabel7_15_t075', 'n_wvb07_t05']) {
      const sid = `silver:${id}`; const [b, mult, fee, fp] = NYB.silver;
      const l = nyRun(b, selectStrategies([id])[0], sid, 'silver', mult, fee, fp);
      const y = [[0, A0 + 335 * DAY], [A0 + 335 * DAY, Infinity]].map(([a2, b2]) => rStats(l.filter((t) => t.entryT >= a2 && t.entryT < b2)));
      const ok = y.every((p) => p.expR > 0.02 && p.n >= 15);
      console.log(`   ${ok ? '✓' : '·'} ${sid.padEnd(28)} ${y.map((p) => `${sgn(p.expR)} R (${p.n})`).join(' / ')}`);
      if (ok) intraC.push({ sid, l: l.map((t) => ({ ...t, riskPct: IR })) });
    }
    // Sélection seule (journalières) : > +0,02 R sur 2009–14, 2015–20, 2021–26, ≥ 15 trades chacune
    const dailyOk = [];
    for (const c of cands) {
      const p = per3(c.l); const ok = p.every((x) => x.expR > 0.02 && x.n >= 15);
      console.log(`   ${ok ? '✓' : '·'} ${c.sid.padEnd(28)} ${c.fam.padEnd(18)} ${p.map((x) => `${sgn(x.expR)} R (${x.n})`).join(' / ')}`);
      if (ok) dailyOk.push(c);
    }
    // Système (évaluations intraday + journalière, financé), anti-hedging entre comptes
    const xf = (books) => {
      const evs = []; books.forEach((l, bi) => l.forEach((t) => evs.push({ t, bi })));
      evs.sort((x, y) => x.t.entryT - y.t.entryT || x.bi - y.bi);
      const open = []; const keep = books.map(() => new Set());
      for (const { t, bi } of evs) {
        for (let i = open.length - 1; i >= 0; i--) if (open[i].t.exitT <= t.entryT) open.splice(i, 1);
        if (open.some((o) => o.bi !== bi && o.t.market === t.market && o.t.side !== t.side)) continue;
        keep[bi].add(t); open.push({ t, bi });
      }
      return books.map((l, bi) => l.filter((t) => keep[bi].has(t)));
    };
    const multiN = (lists) => {
      const end = L[L.length - 1].entryT - 120 * DAY; let n = 0, any30 = 0, fundedN = 0, bought = 0; const firsts = [];
      for (const s0 of starts(A0, end)) {
        n++; bought += lists.length; let first = Infinity;
        for (const [x, o] of lists) { const r = runPhase(x.filter((t) => t.entryT >= s0 && t.entryT < s0 + 365 * DAY), { ...RLE, ...o, from: s0 }); if (r.outcome === 'target') { fundedN++; first = Math.min(first, (r.at - s0) / DAY); } }
        if (first <= 30) any30++; if (Number.isFinite(first)) firsts.push(first);
      }
      return { any30: any30 / n, med: median(firsts), cost: (bought * PRICE50) / fundedN };
    };
    const sysEval = (dAdd, iAdd) => {
      const sortT = (l) => l.sort((x, y) => x.entryT - y.entryT);
      const Dd = sortT([...DAILY, ...(process.env.FONLY ? [] : dAdd).map((t) => ({ ...t, riskPct: DR }))]); // FONLY=1 : compte financé seulement
      const Ff = sortT([...FLD, ...dAdd.map((t) => ({ ...t, riskPct: DR * FMUL }))]);
      const Ii = sortT([...INTRA, ...iAdd]);
      const [f2, i2, d2] = xf([Ff, Ii, Dd]);
      return { i: evalStats(i2, {}), d: evalStats(d2, NODM), f: funded(f2, CUR), m: multiN([[i2, {}], [d2, NODM]]) };
    };
    const sysFmt = (r) => `intraday ${fmtE(r.i, true)}\n         daily ${fmtE(r.d, false)}\n         2 éval. : ≥1 réussie ≤ 30 j ${pc(r.m.any30)} · médiane ${r.m.med.toFixed(0)} j · ${usd(r.m.cost)}/financé · financé ${Object.entries(r.f).map(([k, v]) => `${k} ${usd(v.paid)} (perdus ${pc(v.lost)})`).join(' | ')}`;
    const sysBetter = (r, b) => {
      const no = r.m.cost <= b.m.cost + 2 && r.m.any30 >= b.m.any30 - 0.005 && r.m.med <= b.m.med + 2
        && Object.keys(b.f).every((k) => r.f[k].paid >= b.f[k].paid - 25 && r.f[k].lost <= b.f[k].lost + 0.005)
        && r.d.per.every((p, i) => !(p < b.d.per[i] - 0.5)) && !(r.i.per[2] < b.i.per[2] - 0.5);
      const up = r.m.cost < b.m.cost - 2 || r.m.any30 > b.m.any30 + 0.005 || r.m.med < b.m.med - 2 || Object.keys(b.f).some((k) => r.f[k].paid > b.f[k].paid + 25)
        || r.d.per.some((p, i) => p > b.d.per[i] + 0.5) || r.i.per[2] > b.i.per[2] + 0.5;
      return no && up;
    };
    let accD = [], accI = []; let best = sysEval([], []);
    console.log(`\n   Système actuel\n         ${sysFmt(best)}`);
    const CANDS = process.env.CANDS ? process.env.CANDS.split(',') : null;
    const all14 = [...dailyOk.map((c) => ({ ...c, kind: 'd' })), ...intraC.map((c) => ({ ...c, kind: 'i' }))].filter((c) => !CANDS || CANDS.includes(c.sid));
    // classement : chaque candidate seule sur le système
    const scored = all14.map((c) => { const r = sysEval(c.kind === 'd' ? c.l : [], c.kind === 'i' ? c.l : []); return { c, r, ok: sysBetter(r, best) }; });
    for (const { c, r, ok } of scored) console.log(`${ok ? '✅' : '  '} + ${c.sid}\n         ${sysFmt(r)}`);
    const kept = [];
    for (const { c } of scored.filter((x) => x.ok).sort((x, y) => x.r.m.cost - y.r.m.cost)) {
      const nd = c.kind === 'd' ? [...accD, ...c.l] : accD, ni = c.kind === 'i' ? [...accI, ...c.l] : accI;
      const r = sysEval(nd, ni);
      const ok = sysBetter(r, best);
      console.log(`${ok ? '✅' : '  '} ensemble + ${c.sid}\n         ${sysFmt(r)}`);
      if (ok) { accD = nd; accI = ni; best = r; kept.push(c.sid); }
    }
    console.log(`\n   Retenues : ${kept.join(', ') || 'aucune'}`);
  }
  /* ---------- 15. Une seule position par idée (plusieurs stratégies qui entrent ensemble sur le même marché) ---------- */
  if (want(15)) {
    console.log('=== 15. Entrées groupées : même marché, même sens, à moins de N minutes ===');
    // mode 'first' : une seule position (la première) ; 'split' : toutes, risque partagé ; 'cap' : risque total ≤ 1,5 × une
    const cluster = (l, win, mode) => {
      const xs = [...l].sort((a, b) => a.entryT - b.entryT); const out = []; const groups = [];
      for (const t of xs) {
        const g = groups.find((g2) => g2.m === t.market && g2.side === t.side && t.entryT - g2.t0 <= win && g2.open);
        if (g) g.list.push(t); else groups.push({ m: t.market, side: t.side, t0: t.entryT, list: [t], open: true });
        for (const g2 of groups) if (t.entryT - g2.t0 > win) g2.open = false;
      }
      let merged = 0;
      for (const g of groups) {
        if (g.list.length === 1) { out.push(g.list[0]); continue; }
        merged += g.list.length - 1;
        if (mode === 'first') out.push(g.list[0]);
        else if (mode === 'split') for (const t of g.list) out.push({ ...t, riskPct: t.riskPct / g.list.length });
        else for (const t of g.list) out.push({ ...t, riskPct: t.riskPct * Math.min(1, 1.5 / g.list.length) });
      }
      return { list: out.sort((a, b) => a.entryT - b.entryT), merged };
    };
    const refF = evaluate('ftmo', LIST('ftmo'));
    console.log(`   FTMO actuel                          ${fmt(refF)}`);
    for (const win of [60, 300, 900]) for (const mode of ['first', 'split', 'cap']) {
      const c = cluster(LIST('ftmo'), win, mode);
      const r = evaluate('ftmo', c.list);
      console.log(`${better(r, refF, 'ftmo') ? '✅' : '  '} FTMO ${String(win / 60).padStart(2)} min ${mode.padEnd(5)} (${String(c.merged).padStart(4)} groupés) ${fmt(r)}`);
    }
    for (const [k, [l, o, intraOnly]] of Object.entries(EVALS)) {
      console.log(`   Lucid ${k.padEnd(9)} actuel             ${fmtE(evRef[k], intraOnly)}`);
      for (const mode of ['first', 'split', 'cap']) {
        const c = cluster(l, 300, mode); const r = evalStats(c.list, o);
        console.log(`${evBetter(r, evRef[k], intraOnly) ? '✅' : '  '} Lucid ${k.padEnd(9)} 5 min ${mode.padEnd(5)} (${String(c.merged).padStart(4)}) ${fmtE(r, intraOnly)}`);
      }
    }
    for (const mode of ['first', 'split', 'cap']) fLine(`financé 5 min ${mode}`, funded(cluster(FLD, 300, mode).list, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1) }));
    console.log('');
  }
  /* ---------- 16. Idées d'un ami : verrou du jour, filtre de tendance, stratégies faibles, poids du journalier ---------- */
  if (want(16)) {
    console.log('=== 16. Moins de dépendance aux gros jours ===');
    const refF = evaluate('ftmo', LIST('ftmo'));
    const lineF = (name, r) => console.log(`${better(r, refF, 'ftmo') ? '✅' : '  '} FTMO  ${name.padEnd(48)} ${fmt(r)}`);
    const lineL = (k, name, r) => console.log(`${evBetter(r, evRef[k], EVALS[k][2]) ? '✅' : '  '} Lucid ${k.padEnd(9)} ${name.padEnd(38)} ${fmtE(r, EVALS[k][2])}`);
    console.log(`   FTMO actuel ${fmt(refF)}`);
    // 1. Verrou du jour : positions fermées quand le gain du jour atteint X
    console.log('-- 1. Fermer les positions quand la journée atteint +X');
    for (const p of [3, 4, 5]) lineF(`verrou du jour à +${p} % (${p * 1000} $)`, evaluate('ftmo', LIST('ftmo'), { dayLockUsd: p * 1000 }));
    for (const x of [900, 1200]) for (const k of ['intraday', 'combined', 'daily']) lineL(k, `verrou du jour à +${x} $`, evalStats(EVALS[k][0], { ...EVALS[k][1], dayLockUsd: x }));
    fLine('financé : verrou du jour à +1 000 $', funded(FLD, { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1), dayLockUsd: 1000 }));
    // 2. Filtre de tendance journalière pour l'intraday
    console.log('-- 2. Intraday seulement dans le sens de la tendance journalière (veille)');
    const YS = { nas100: '^NDX', spx: '^GSPC', dow: '^DJI', russell: '^RUT', silver: 'SI=F', gold: 'GC=F', tlt: 'TLT', googl: 'GOOGL', pltr: 'PLTR', lly: 'LLY', ba: 'BA', eurusd: 'EURUSD=X' };
    const TR = {};
    const emaOf = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map((x) => (e = x * k + e * (1 - k))); };
    for (const [m, sym] of Object.entries(YS)) {
      const d = DLY?.[m]?.c?.length ? DLY[m].c : (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0);
      const c = d.map((k) => k.c), e50 = emaOf(c, 50), e200 = emaOf(c, 200);
      TR[m] = { t: d.map((k) => k.t), c, e50, e200 };
    }
    const trendAt = (m, t, mode) => {
      const T = TR[m]; if (!T) return 0;
      let lo = 0, hi = T.t.length - 1, i = -1;
      while (lo <= hi) { const md = (lo + hi) >> 1; if (T.t[md] + 86400 <= t) { i = md; lo = md + 1; } else hi = md - 1; }
      if (i < 200) return 0;
      const up = mode === '200' ? T.c[i] > T.e200[i] : mode === '50/200' ? T.e50[i] > T.e200[i] : T.c[i] > T.e50[i] && T.e50[i] > T.e200[i];
      const dn = mode === '200' ? T.c[i] < T.e200[i] : mode === '50/200' ? T.e50[i] < T.e200[i] : T.c[i] < T.e50[i] && T.e50[i] < T.e200[i];
      return up ? 1 : dn ? -1 : 0;
    };
    const trendF = (l, mode, neutral) => l.filter((t) => { if (!t.intraday) return true; const tr = trendAt(t.market, t.entryT, mode); return tr === 0 ? neutral : (tr === 1) === (t.side === 'long'); });
    for (const mode of ['200', '50/200', 'les deux']) for (const neutral of [true, false]) {
      const nm = `tendance ${mode}${neutral ? '' : ', rien si neutre'}`;
      lineF(nm, evaluate('ftmo', trendF(LIST('ftmo'), mode, neutral)));
      for (const k of ['intraday', 'combined']) lineL(k, nm, evalStats(trendF(EVALS[k][0], mode, neutral), EVALS[k][1]));
    }
    // 3. Stratégies faibles : chaque stratégie intraday retirée une à une
    console.log('-- 3. Retirer une stratégie intraday (une à une)');
    const intraIds = (l) => [...new Set(l.filter((t) => t.intraday).map((t) => t.sid))];
    for (const sid of intraIds(LIST('ftmo'))) lineF(`sans ${sid}`, evaluate('ftmo', LIST('ftmo').filter((t) => t.sid !== sid)));
    for (const sid of intraIds(INTRA)) lineL('intraday', `sans ${sid}`, evalStats(INTRA.filter((t) => t.sid !== sid), {}));
    // 4. Plus de poids sur le journalier (FTMO)
    console.log('-- 4. Journalières FTMO plus fortes');
    for (const m2 of [1.25, 1.5]) lineF(`journalières × ${m2}`, evaluate('ftmo', LIST('ftmo').map((t) => (t.intraday ? t : { ...t, riskPct: t.riskPct * m2 }))));
    for (const m2 of [1.25, 1.5]) lineF(`journalières × ${m2}, intraday × 0,75`, evaluate('ftmo', LIST('ftmo').map((t) => ({ ...t, riskPct: t.riskPct * (t.intraday ? 0.75 : m2) }))));
    console.log('');
  }
  /* ---------- 17. FTMO : combinaison des gagnants de la section 16 (ajout un à un, gardé si mieux) ---------- */
  if (want(17)) {
    console.log('=== 17. FTMO : combinaison (verrou +5 %, tendance, retraits de stratégies) ===');
    const YS = { nas100: '^NDX', spx: '^GSPC', dow: '^DJI', russell: '^RUT', silver: 'SI=F', gold: 'GC=F', tlt: 'TLT', googl: 'GOOGL', pltr: 'PLTR', lly: 'LLY', ba: 'BA', eurusd: 'EURUSD=X' };
    const TR = {}; const emaOf = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map((x) => (e = x * k + e * (1 - k))); };
    for (const [m, sym] of Object.entries(YS)) { const d = DLY?.[m]?.c?.length ? DLY[m].c : (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0); const c = d.map((k) => k.c); TR[m] = { t: d.map((k) => k.t), c, e50: emaOf(c, 50), e200: emaOf(c, 200) }; }
    const trendAt = (m, t) => { const T = TR[m]; if (!T) return 0; let lo = 0, hi = T.t.length - 1, i = -1; while (lo <= hi) { const md = (lo + hi) >> 1; if (T.t[md] + 86400 <= t) { i = md; lo = md + 1; } else hi = md - 1; }
      if (i < 200) return 0; return T.c[i] > T.e50[i] && T.e50[i] > T.e200[i] ? 1 : T.c[i] < T.e50[i] && T.e50[i] < T.e200[i] ? -1 : 0; };
    const steps = {
      'verrou +5 %': { o: { dayLockUsd: 5000 } },
      'tendance (les deux)': { f: (l) => l.filter((t) => { if (!t.intraday) return true; const tr = trendAt(t.market, t.entryT); return tr === 0 || (tr === 1) === (t.side === 'long'); }) },
      'tendance (les deux), rien si neutre': { f: (l) => l.filter((t) => { if (!t.intraday) return true; const tr = trendAt(t.market, t.entryT); return tr !== 0 && (tr === 1) === (t.side === 'long'); }) },
      ...Object.fromEntries(['gold:g_orb30', 'gold:g_nypdl', 'tlt:n_crabel7_15', 'lly:n_orb5s', 'nas100:n_orb5s'].map((sid) => [`sans ${sid}`, { f: (l) => l.filter((t) => t.sid !== sid) }])),
    };
    const apply = (keys) => { let l = LIST('ftmo'); let o = {}; for (const k of keys) { if (steps[k].f) l = steps[k].f(l); if (steps[k].o) o = { ...o, ...steps[k].o }; } return evaluate('ftmo', l, o); };
    let cur = []; let best = evaluate('ftmo', LIST('ftmo'));
    console.log(`   actuel ${fmt(best)}`);
    const score = (r) => r.per.reduce((a, b) => a + b, 0);
    for (;;) {
      const tries = Object.keys(steps).filter((k) => !cur.includes(k) && !(k.startsWith('tendance') && cur.some((c) => c.startsWith('tendance')))).map((k) => ({ k, r: apply([...cur, k]) })).filter((x) => better(x.r, best, 'ftmo'));
      if (!tries.length) break;
      tries.sort((a, b) => score(b.r) - score(a.r));
      cur = [...cur, tries[0].k]; best = tries[0].r;
      console.log(`✅ + ${tries[0].k.padEnd(40)} ${fmt(best)}`);
    }
    console.log(`   retenu : ${cur.join(' · ') || 'rien'}`);
    // Contrôle : le même ensemble sur des départs décalés (années impaires / paires), pour voir si c'est stable
    console.log('');
  }
  /* ---------- 18. Test de résistance : chaque trade perd h R (frais, glissement, avantage surestimé) ---------- */
  if (want(18)) {
    console.log('=== 18. Test de résistance : avantage réduit de h R par trade ===');
    const hc = (l, h) => (h ? l.map((t) => ({ ...t, pnlPct: t.pnlPct - h * stopPct(t) })) : l);
    const avgR = (l) => l.reduce((a2, t) => a2 + R(t), 0) / Math.max(1, l.length);
    // FTMO réglage actuel : filtre de tendance (les deux, rien si neutre) + verrou du jour à +5 %
    const YS = { nas100: '^NDX', spx: '^GSPC', dow: '^DJI', russell: '^RUT', silver: 'SI=F', gold: 'GC=F', tlt: 'TLT', googl: 'GOOGL', pltr: 'PLTR', lly: 'LLY', ba: 'BA', eurusd: 'EURUSD=X' };
    const TR = {}; const emaOf = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map((x) => (e = x * k + e * (1 - k))); };
    for (const [m, sym] of Object.entries(YS)) { const d = DLY?.[m]?.c?.length ? DLY[m].c : (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0); const c = d.map((k) => k.c); TR[m] = { t: d.map((k) => k.t), c, e50: emaOf(c, 50), e200: emaOf(c, 200) }; }
    const trendAt = (m, t) => { const T = TR[m]; if (!T) return 0; let lo = 0, hi = T.t.length - 1, i = -1; while (lo <= hi) { const md = (lo + hi) >> 1; if (T.t[md] + 86400 <= t) { i = md; lo = md + 1; } else hi = md - 1; }
      if (i < 200) return 0; return T.c[i] > T.e50[i] && T.e50[i] > T.e200[i] ? 1 : T.c[i] < T.e50[i] && T.e50[i] < T.e200[i] ? -1 : 0; };
    const FTL = LIST('ftmo').filter((t) => { if (!t.intraday) return true; const tr = trendAt(t.market, t.entryT); return tr !== 0 && (tr === 1) === (t.side === 'long'); });
    const CUR = { sizer: (t, st) => baseSizer(t, st) * (st.paid ? 1 / 3 : 1) };
    for (const h of [0, 0.02, 0.03, 0.05, 0.1]) {
      console.log(`-- h = ${h} R par trade (R moyen : Lucid intraday ${avgR(hc(INTRA, h)).toFixed(3)} · journalières ${avgR(hc(DAILY, h)).toFixed(3)} · FTMO ${avgR(hc(FTL, h)).toFixed(3)})`);
      console.log(`   FTMO (réglage actuel)         ${fmt(evaluate('ftmo', hc(FTL, h), { dayLockUsd: 5000 }))}`);
      for (const [k, [l, o, intraOnly]] of Object.entries(EVALS)) console.log(`   Lucid ${k.padEnd(9)}               ${fmtE(evalStats(hc(l, h), o), intraOnly)}`);
      console.log(`   Lucid deux évaluations        ${multi([hc(INTRA, h), hc(DAILY, h)])}`);
      fline('Lucid financé', funded(hc(FLD, h), CUR));
    }
    console.log('');
  }
  /* ---------- 19. Compte FTMO + cassure 4 h crypto (BTC, ETH : volume + vrai delta, src/crypto4h.js) ---------- */
  if (want(19)) {
    console.log('=== 19. FTMO (réglage actuel) + cassure 4 h BTC / ETH ===');
    const { loadKlines, loadFunding, backtest4h } = require('./src/crypto4h');
    const YS = { nas100: '^NDX', spx: '^GSPC', dow: '^DJI', russell: '^RUT', silver: 'SI=F', gold: 'GC=F', tlt: 'TLT', googl: 'GOOGL', pltr: 'PLTR', lly: 'LLY', ba: 'BA', eurusd: 'EURUSD=X' };
    const TR = {}; const emaOf = (c, n) => { const k = 2 / (n + 1); let e = c[0]; return c.map((x) => (e = x * k + e * (1 - k))); };
    for (const [m, sym] of Object.entries(YS)) { const d = DLY?.[m]?.c?.length ? DLY[m].c : (await cachedYahoo(CACHE, sym, '1d', {}, 72)).filter((k) => k.c > 0); const c = d.map((k) => k.c); TR[m] = { t: d.map((k) => k.t), c, e50: emaOf(c, 50), e200: emaOf(c, 200) }; }
    const trendAt = (m, t) => { const T = TR[m]; if (!T) return 0; let lo = 0, hi = T.t.length - 1, i = -1; while (lo <= hi) { const md = (lo + hi) >> 1; if (T.t[md] + 86400 <= t) { i = md; lo = md + 1; } else hi = md - 1; }
      if (i < 200) return 0; return T.c[i] > T.e50[i] && T.e50[i] > T.e200[i] ? 1 : T.c[i] < T.e50[i] && T.e50[i] < T.e200[i] ? -1 : 0; };
    const FTL = LIST('ftmo').filter((t) => { if (!t.intraday) return true; const tr = trendAt(t.market, t.entryT); return tr !== 0 && (tr === 1) === (t.side === 'long'); });
    const LEV = { ...RF.levCap, btc: 3, eth: 3 };
    const ref = evaluate('ftmo', FTL, { dayLockUsd: 5000, levCap: LEV });
    console.log(`   FTMO actuel ${fmt(ref)}`);
    const cr = (o, side) => ['BTCUSDT', 'ETHUSDT'].flatMap((s) => backtest4h(loadKlines(s), { ...o, side, funding: loadFunding(s) })
      .map((t) => ({ ...t, sid: `${s.slice(0, 3).toLowerCase()}:x_brk4h`, market: s.slice(0, 3).toLowerCase(), intraday: false })));
    const SETS = { 'N 40, volume + delta ≥ 1 σ (choisi sur 2020–23)': { n: 40, kVol: 1, kDelta: 1 }, 'N 20, volume + delta ≥ 0,5 σ (proposé)': { n: 20, kVol: 0.5, kDelta: 0.5 }, 'N 20, cassure seule': { n: 20, useVol: false, useDelta: false } };
    for (const [nm, o] of Object.entries(SETS)) for (const side of ['both', 'long']) for (const risk of [0.25, 0.5, 1]) {
      const add = cr(o, side).map((t) => ({ ...t, riskPct: risk }));
      const r = evaluate('ftmo', [...FTL, ...add].sort((a2, b) => a2.entryT - b.entryT), { dayLockUsd: 5000, levCap: LEV });
      console.log(`${better(r, ref, 'ftmo') ? '✅' : '  '} + ${nm}${side === 'long' ? ', achats seuls' : ''} à ${risk} % (${add.length} trades)`.padEnd(86) + fmt(r));
    }
    console.log('');
  }
  console.log('\n✅ = rien ne baisse et au moins un chiffre monte (évaluations : réussite, ≤ 14 j, ≤ 30 j, échecs ≤ 14 j ; financé : retraits, comptes perdus)');
})().catch((e) => { console.error(e); process.exit(1); });
