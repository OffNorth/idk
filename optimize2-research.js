#!/usr/bin/env node
/**
 * Sept autres idées pour optimiser le rendement (npm run optimize2) :
 *   1. Deux évaluations Lucid différentes en même temps (intraday Nasdaq / le reste) : chance qu'au moins une réussisse,
 *      coût par compte financé, contre une évaluation (ou deux identiques).
 *   2. Abandonner une évaluation Lucid mal partie (solde sous 50 000 − X $) et en racheter une neuve.
 *   3. LucidFlex 100K au lieu de 50K (réglages actuels) : coût par compte financé, retraits sur 12 mois.
 *   4. Compte Lucid financé : objectifs plus longs (1 R, 1,5 R, sans objectif) au lieu de 0,5 / 0,75 R.
 *   5. Compte financé (FTMO et Lucid) : risque selon la marge restante avant la perte max.
 *   6. Cassures : ordre limite sur un repli (¼ ou ½ du risque) au lieu d'entrer à la clôture de cassure.
 *   7. Journalières fermées le vendredi soir (pas de position pendant le week-end).
 * Règle habituelle : retenue seulement si aucune période ne baisse et qu'au moins une monte.
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
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id === 'ftmo' ? 'gold' : 'lucid');
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

  /* ---------- 1. Deux évaluations Lucid différentes ---------- */
  if (want(1)) {
    console.log('=== 1. Deux évaluations Lucid en même temps (nov. 24–26, départ chaque jour ouvré) ===');
    const l = lucidOpen(LIST('lucid'), A0);
    const nasI = (t) => t.intraday && t.market === 'nas100';
    const parts = { 'une évaluation (tout)': [l], 'deux identiques': [l, l], 'deux différentes (intraday Nasdaq | le reste)': [l.filter(nasI), l.filter((t) => !nasI(t))],
      'deux différentes (intraday | journalières)': [l.filter((t) => t.intraday), l.filter((t) => !t.intraday)] };
    const end = l[l.length - 1].entryT - 120 * DAY;
    for (const [name, lists] of Object.entries(parts)) {
      let n = 0, any30 = 0, any365 = 0, funded = 0, bought = 0; const firsts = [];
      for (const s of starts(A0, end)) {
        n++; bought += lists.length; let first = Infinity;
        for (const x of lists) {
          const r = runPhase(x.filter((t) => t.entryT >= s && t.entryT < s + 365 * DAY), { ...RL, from: s });
          if (r.outcome === 'target') { funded++; first = Math.min(first, (r.at - s) / DAY); }
        }
        if (first <= 30) any30++; if (Number.isFinite(first)) { any365++; firsts.push(first); }
      }
      console.log(`   ${name.padEnd(48)} au moins une réussie ≤ 30 j ${pc(any30 / n)} · < 1 an ${pc(any365 / n)} (${median(firsts).toFixed(0)} j) · comptes financés par départ ${(funded / n).toFixed(2)} · coût par compte financé ${usd((bought * PRICE50) / funded)}`);
    }
    console.log('');
  }

  /* ---------- 2. Abandonner une évaluation mal partie ---------- */
  if (want(2)) {
    console.log('=== 2. Évaluation Lucid abandonnée sous 50 000 − X $ (on en rachète une neuve le lendemain) ===');
    const chain = (l, s, X) => {
      let t = s, evals = 0;
      while (t < s + 365 * DAY) {
        evals++;
        const r = runPhase(l.filter((k) => k.entryT >= t && k.entryT < s + 365 * DAY), { ...RL, from: t, abandonBelow: X === null ? null : 50_000 - X });
        if (r.outcome === 'target') return { ok: true, days: (r.at - s) / DAY, evals };
        if (r.outcome === 'open') return { ok: false, evals };
        t = Math.floor(r.at / DAY) * DAY + DAY;
      }
      return { ok: false, evals };
    };
    for (const X of [null, 1500, 1250, 1000, 750]) {
      const cells = Object.entries(LP).map(([, [a, b, step, intra]]) => {
        const l = sub(LIST('lucid'), intra).filter((t) => t.entryT >= a && t.entryT < b).sort((x, y) => x.entryT - y.entryT);
        const end = Math.min(b, l[l.length - 1].entryT) - 365 * DAY;
        const rs = starts(a, end > a ? end : l[l.length - 1].entryT - 120 * DAY, step).map((s) => chain(l, s, X));
        const ok = rs.filter((r) => r.ok); const ev = rs.reduce((x, r) => x + r.evals, 0);
        return `financé < 1 an ${pc(ok.length / rs.length)} en ${median(ok.map((r) => r.days)).toFixed(0).padStart(3)} j · ${(ev / Math.max(1, ok.length)).toFixed(1)} éval. / compte financé`;
      });
      console.log(`   ${(X === null ? 'jamais (jusqu’à la perte max)' : `sous −${X} $`).padEnd(30)} ${cells.join(' | ')}`);
    }
    console.log('   (nov. 24–26 | 2009–19 | 2020–26)\n');
  }

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
  if (want(3)) {
    console.log('=== 3. LucidFlex 100K au lieu de 50K (réglages actuels, en % du capital) ===');
    const R100 = { capital: 100_000, maxLossUsd: 3000, maxContracts: 60, bestDayPct: 50, dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * 100_000 * 0.06 };
    const S100 = [[0, 30], [1000, 40], [2000, 50], [3000, 60]];
    for (const [name, o, price, pay] of [['50K (actuel)', {}, PRICE50, { minDay: 150, cap: 2000 }], ['100K', R100, PRICE100, { minDay: 200, cap: 2500 }]]) {
      const ev = evaluate('lucid', LIST('lucid'), o);
      const runs = starts(A0, LIST('lucid')[LIST('lucid').length - 1]?.entryT || A0).length;
      void runs;
      const pA = ev.per[2] / 100;
      const f = fundedLucid(fundedRisk(LIST('lucid')), { sizer: cushionLucid, ...(o.capital ? { capital: o.capital, maxLossUsd: o.maxLossUsd, maxContracts: o.maxContracts, scaling: S100 } : {}) }, pay);
      console.log(`   ${name.padEnd(14)} évaluation ${fmt(ev)}\n                  coût par compte financé (nov. 24–26) ${usd(price / pA)} · financé 12 mois : retraits ${usd(f.paid)} · 1er retrait ≤ 60 j ${pc(f.p60)} · perdus ${pc(f.lost)} · net ≈ ${usd(f.paid - price / pA)} par compte financé`);
    }
    console.log('   (prix 100K estimé à 230 $, retrait ≤ 2 500 $ et jours gagnants ≥ 200 $ : sources secondaires, à vérifier)\n');
  }
  if (want(4)) {
    console.log('=== 4. Lucid financé : objectifs plus longs (intraday) ===');
    const retarget = (k) => (s) => ({ ...s, evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 && (r.tp || k === 'keep') ? { ...r, tp: k === 'keep' ? r.tp : k === null ? null : k * r.sl } : r; } });
    const intraSids = accts.lucid.sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; });
    const listWith = (k) => {
      const intra = intraSids.flatMap((sid) => { const [m, s] = strat(sid); const [b, mult, fee, fp] = NYB[m]; const s2 = k === 'keep' ? s : retarget(k)(s); return nyRun(b, s2, sid, m, mult, fee, fp); });
      return fundedRisk([...LIST('lucid').filter((t) => !(t.intraday && NYB[t.market])), ...intra]);
    };
    for (const [name, k] of [['objectifs actuels (0,5 / 0,75 / 1 R)', 'keep'], ['objectif 1 R', 1], ['objectif 1,5 R', 1.5], ['objectif 2 R', 2], ['sans objectif (sortie du soir)', null]]) {
      const f = fundedLucid(listWith(k), { sizer: cushionLucid });
      console.log(`   ${name.padEnd(38)} retraits 12 mois ${usd(f.paid).padStart(8)} · 1er retrait ≤ 60 j ${pc(f.p60)} · perdus en 12 mois ${pc(f.lost)}`);
    }
    console.log('   (départ chaque jour ouvré, nov. 2024 → nov. 2025, risque « financé » actuel)\n');
  }

  /* ---------- 5. Risque selon la marge restante (comptes financés) ---------- */
  if (want(5)) {
    console.log('=== 5. Compte financé : risque selon la marge restante avant la perte max ===');
    const baseL = RULES[cfg.ftmoSizing] || RULES.fixe; const baseF = require('./src/sizing').ruleFor(cfg, 'FTMO');
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    const CU = { 'actuel': () => 1, 'marge (× 0,25 à × 1)': (r) => clamp(r, 0.25, 1), 'marge (× 0,25 à × 1,5)': (r) => clamp(r, 0.25, 1.5), 'marge² (× 0,1 à × 1)': (r) => clamp(r * r, 0.1, 1) };
    const fx = LIST('ftmo').filter((t) => !(t.intraday && t.market !== 'gold'));
    for (const [name, f] of Object.entries(CU)) {
      let n = 0, paid = 0, lost = 0;
      const FD = Number(process.env.FUND_DAYS || 365);
      for (let s = Y(2009) + 60 * DAY; s < Y(2026) - FD * DAY; s += 7 * DAY) {
        const r = fundedRun(fx, { ...RF, riskMul: cfg.ftmoFundedRiskMul ?? 0.75, dayProfitCapUsd: Infinity, maxLossesPerDay: Infinity, sizer: (t, st) => baseF(t, st) * f(st.room ?? 1), funded: { rule: 'ftmo', every: 14, days: FD } }, s);
        n++; paid += r.paid * 0.8; if (r.lost) lost++;
      }
      const L = fundedLucid(fundedRisk(LIST('lucid')), { sizer: (t, st) => baseL(t, st) * f(st.room ?? 1) });
      console.log(`   ${name.padEnd(26)} FTMO financé 12 mois (2009–24) : retraits ${usd(paid / n).padStart(8)} · perdus ${pc(lost / n)}  ||  Lucid financé (nov. 24–25) : retraits ${usd(L.paid).padStart(7)} · perdus ${pc(L.lost)}`);
    }
    console.log('');
  }

  /* ---------- 6. Cassures : ordre limite sur un repli ---------- */
  if (want(6)) {
    console.log('=== 6. Cassures : ordre limite sur un repli (30 min pour être exécuté) au lieu de la clôture de cassure ===');
    const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    const BARS = { gold: g5, ...Object.fromEntries(Object.entries(NYB).map(([m, v]) => [m, v[0]])) };
    const isBreak = (sid) => /orb|crabel|wvb|asiabrk|nypdl/.test(sid);
    const firstAt = (bars, t) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; };
    const withLimit = (l, f) => l.flatMap((t) => {
      if (!t.intraday || !isBreak(t.sid) || !BARS[t.market]) return [t];
      const bars = BARS[t.market]; const long = t.side === 'long'; const risk = Math.abs(t.entry - t.initSl);
      const lim = long ? t.entry - f * risk : t.entry + f * risk;
      let i = firstAt(bars, t.entryT + 1); let fillT = null; // bougies APRÈS la bougie de cassure (entryT = son début)
      for (let k = 0; k < 6 && i < bars.length; k++, i++) {
        if (bars[i].t >= t.exitT) break;
        if (long ? bars[i].l <= lim : bars[i].h >= lim) { fillT = bars[i].t + 300; break; }
      }
      if (fillT === null) return [];
      const exit = t.entry * (1 + ((long ? 1 : -1) * (t.pnlPct + 0.01)) / 100); // cours de sortie du trade d'origine (frais retirés)
      const pnl = (long ? exit / lim - 1 : 1 - exit / lim) * 100 - 0.01;
      return [{ ...t, entry: lim, entryT: Math.min(fillT, t.exitT - 1), pnlPct: pnl }];
    });
    const nB = LIST('lucid').filter((t) => t.intraday && isBreak(t.sid)).length;
    for (const f of [0.25, 0.5]) {
      for (const id of ['ftmo', 'lucid']) {
        const l = withLimit(LIST(id), f);
        line(id, `limite à ${f === 0.25 ? '¼' : '½'} du risque (${l.filter((t) => t.intraday && isBreak(t.sid)).length} / ${LIST(id).filter((t) => t.intraday && isBreak(t.sid)).length} exécutés)`, evaluate(id, l));
      }
    }
    void nB;
    console.log('');
  }

  /* ---------- 7. Journalières fermées le vendredi soir ---------- */
  if (want(7)) {
    console.log('=== 7. Journalières fermées le vendredi soir (pas de week-end) ===');
    const SYM = { gold: 'GC=F', nas100: '^NDX', spx: '^GSPC', eurusd: 'EURUSD=X', russell: '^RUT', silver: 'SI=F', dow: '^DJI' };
    const D = {}; for (const [m, s] of Object.entries(SYM)) D[m] = (await cachedYahoo(CACHE, s, '1d')).filter((k) => k.c > 0);
    const noWeekend = (l, skipFriday) => l.flatMap((t) => {
      if (t.intraday || !D[t.market]) return [t];
      const d = D[t.market]; const long = t.side === 'long';
      let i = 0; while (i < d.length && d[i].t < t.entryT - DAY) i++;
      for (; i < d.length - 1; i++) {
        if (d[i].t + DAY > t.exitT) break;
        if (d[i + 1].t - d[i].t > 2.5 * DAY && d[i].t + DAY > t.entryT) {
          if (skipFriday && d[i].t <= t.entryT && t.entryT < d[i].t + DAY) return [];
          const pnl = (long ? d[i].c / t.entry - 1 : 1 - d[i].c / t.entry) * 100 - 0.02;
          return [{ ...t, pnlPct: pnl, exitT: Math.max(t.entryT + 60, d[i].t + 20 * 3600) }];
        }
      }
      return [t];
    });
    for (const [name, sk] of [['fermées le vendredi soir', false], ['fermées le vendredi, pas d’entrée le vendredi', true]]) {
      for (const id of ['ftmo', 'lucid']) line(id, name, evaluate(id, noWeekend(LIST(id), sk)));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
