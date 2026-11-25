#!/usr/bin/env node
/**
 * Autres marchés et actions (npm run world-research) : des positions à d'autres heures que New York, ou qui bougent
 * autrement que le Nasdaq, pour avoir plus de trades sans empiler les mêmes paris.
 *   Marchés : DAX (séance de Francfort) et Nikkei (séance de Tokyo) en bougies 1 h Yahoo sur 2 ans (les 5 min ne
 *     remontent qu'à 60 jours ; Dukascopy limite trop le débit), GBP/USD et USD/JPY (ouverture de Londres, Polygon 5 min),
 *     obligations US (ETF TLT, séance de New York, Polygon 5 min), nov. 2024 → nov. 2026.
 *   Actions (Polygon 5 min nov. 2024 → nov. 2026 + Yahoo journalier depuis 2000) : CFD actions FTMO (levier 1:5),
 *     séance de New York ; Lucid ne propose pas d'actions (futures CME seulement).
 *   1. Stratégies intraday : R moyen 1re / 2e année (> +0,02 R les deux), ≥ 25 trades par année, pire série
 *      (≤ 12 FTMO, ≤ 8 Lucid).
 *   2. Stratégies journalières : 3 tranches (2000–09 | 2010–17 | 2018–26), positives sur les trois.
 *   3. Les retenues ajoutées aux comptes : réussite < 1 an (2009–19 | 2020–26 | nov. 24–26), délai médian.
 *      Ajout seulement si la réussite ne baisse sur aucune période.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { cachedYahoo } = require('./src/yahoo');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { breakout, crabelNR, williamsVB, withTp, hm } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

// Stratégies de séance construites pour un fuseau : cassure d'ouverture 15 / 30 / 60 min, Crabel NR4 / NR7, Williams
function sessionSet(pfx, { tz, open, close, entryEnd, exitAt, lens = [15, 30, 60], nrLen = 30 }) {
  const S = { market: 'gold', tz, s: open, e: close, entryEnd, exitAt };
  return [
    ...lens.map((len) => breakout({ id: `${pfx}_orb${len}`, name: `${pfx} cassure ${len} min`, tz, start: open, len, entryEnd, exitAt })),
    crabelNR({ ...S, id: `${pfx}_crabel4`, name: `${pfx} Crabel NR4`, nr: 4, len: nrLen }),
    crabelNR({ ...S, id: `${pfx}_crabel7`, name: `${pfx} Crabel NR7`, nr: 7, len: nrLen }),
    williamsVB({ ...S, id: `${pfx}_wvb05`, name: `${pfx} Williams 0,5`, k: 0.5 }),
    williamsVB({ ...S, id: `${pfx}_wvb07`, name: `${pfx} Williams 0,7`, k: 0.7 }),
  ];
}
// Lucid : variantes avec objectif (0,5 / 0,75 R), comme sur le Nasdaq
const withTps = (list) => list.flatMap((s) => [withTp(s, 0.5, `${s.id}_t05`, `${s.name} (0,5 R)`), withTp(s, 0.75, `${s.id}_t075`, `${s.name} (0,75 R)`)]);
const NY_FTMO = ['n_noise', 'n_orb5s', 'n_orb15', 'n_mom10', 'n_crabel7_15', 'n_crabel7_30', 'n_crabel4_30', 'n_wvb05'];
const NY_LUCID = ['n_noise_t05', 'n_orb5s_t05', 'n_orb15_t05', 'n_mom10_t05', 'n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05', 'n_crabel4_t05', 'n_wvb05_t075', 'n_wvb07_t05'];
const nyTimed = (ids) => ids.map((id) => { const s = selectStrategies([id])[0]; return s && { ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }; }).filter(Boolean);
const LDN_GOLD = ['g_orb30', 'g_orb60', 'g_gap', 'g_asiabrk'].map((id) => selectStrategies([id])[0]).filter(Boolean);

// Francfort = Londres + 1 h toute l'année (mêmes changements d'heure) : 9 h → 17 h 30 Francfort = 8 h → 16 h 30 Londres
// (bougies 1 h : cassure de la 1re heure seulement, sortie à la clôture de la dernière bougie de la séance)
const DAX = sessionSet('dax', { tz: 'lon', open: hm(8), close: hm(16, 30), entryEnd: hm(12), exitAt: hm(16), lens: [60], nrLen: 60 });
// Tokyo (pas d'heure d'été) : 9 h → 15 h 30 = 0 h → 6 h 30 UTC
const NIK = sessionSet('nik', { tz: 'utc', open: 0, close: hm(6, 30), entryEnd: hm(3), exitAt: hm(6), lens: [60], nrLen: 60 });
// Devises : ouverture de Londres 8 h → 16 h 30 Londres
const FXL = (p) => sessionSet(p, { tz: 'lon', open: hm(8), close: hm(16, 30), entryEnd: hm(12), exitAt: hm(16, 25) });

// micro : valeur d'un contrat Lucid en $ (fonction du prix) et frais ; null = pas de micro-future CME tradable chez Lucid
const MARKETS = {
  dax: { name: 'DAX (Allemagne)', file: 'yahoo1h-GDAXI.json', bar: 3600, yahoo: '^GDAXI', fin: 5, ftmo: DAX, lucid: [], micro: null },
  nikkei: { name: 'Nikkei (Japon)', file: 'yahoo1h-N225.json', bar: 3600, yahoo: '^N225', fin: 5, ftmo: NIK, lucid: [], micro: null },
  gbpusd: { name: 'GBP/USD', poly: 'C:GBPUSD', yahoo: 'GBPUSD=X', fin: 2, ftmo: [...FXL('gbp'), ...LDN_GOLD], lucid: withTps([...FXL('gbp'), ...LDN_GOLD]), micro: { usd: (p) => 6250 * p, fee: 4, name: 'M6B' } },
  usdjpy: { name: 'USD/JPY', poly: 'C:USDJPY', yahoo: 'JPY=X', fin: 2, ftmo: [...FXL('jpy'), ...LDN_GOLD], lucid: withTps([...FXL('jpy'), ...LDN_GOLD]), micro: { usd: (p) => 12_500_000 / p, fee: 4, name: 'MJY' } },
  bond: { name: 'Obligations US (TLT)', poly: 'TLT', yahoo: 'TLT', fin: 3, ny: true, ftmo: nyTimed(NY_FTMO), lucid: [], micro: null },
};
const STOCKS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'AVGO', 'PLTR', 'COIN', 'JPM', 'XOM', 'LLY', 'UNH', 'MSTR', 'BA'];
const DAILY = ['rsi2', 'ibs', 'down3', 'double7'];

const corr = (a, b) => {
  const n = a.length; const ma = a.reduce((x, y) => x + y, 0) / n; const mb = b.reduce((x, y) => x + y, 0) / n;
  let s = 0; let sa = 0; let sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return s / Math.sqrt(sa * sb);
};
const dailyRet = (d) => { const m = new Map(); for (let i = 1; i < d.length; i++) m.set(Math.floor(d[i].t / 86400), d[i].c / d[i - 1].c - 1); return m; };
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

(async () => {
  const y = (s) => cachedYahoo(CACHE, s, '1d', {}, 72).then((d) => d.filter((k) => k.c > 0)).catch(() => null);
  const ndx = await y('^NDX'); const vix = await y('^VIX');
  const rN = dailyRet(ndx);
  const from2y = Date.now() / 1000 - 730 * 86400;
  const report = [];

  const study = async (id, M, bars, { ftmo, lucid, micro, fin, yahoo, stock, bar }) => {
    const d = await y(yahoo);
    let cN = null;
    if (d) {
      const r = dailyRet(d.filter((k) => k.t >= from2y));
      const ks = [...r.keys()].filter((k) => rN.has(k));
      cN = corr(ks.map((k) => r.get(k)), ks.map((k) => rN.get(k)));
    }
    const intra = [];
    if (bars?.length) {
      const t0 = bars[0].t + 30 * 86400; const t1 = bars[bars.length - 1].t; const mid = (t0 + t1) / 2;
      const days = ((t1 - t0) / 86400) * (5 / 7);
      for (const [acct, list] of [['FTMO', ftmo], ['Lucid', micro ? lucid : []]]) {
        for (const s of list) {
          let l;
          try { l = backtest(s, bars, { size: 1000, feePct: stock ? 0.005 : 0.003, financingPct: fin, barSec: bar || 300, market: 'gold' }).list.filter((t) => t.entryT >= t0); } catch { continue; }
          const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const st = rStats(l);
          const ok = a.expR > 0.02 && b.expR > 0.02 && a.n >= 25 && b.n >= 25 && st.worstRun <= (acct === 'Lucid' ? 8 : 12);
          intra.push({ acct, sid: s.id, a, b, st, ok, perDay: l.length / days,
            l: l.map((t) => ({ ...t, sid: `${id}:${s.id}`, market: id, intraday: true, ...(micro ? { contractUsd: micro.usd(t.entry), contractFee: micro.fee } : {}) })) });
        }
      }
    }
    const daily = [];
    if (d && d.length > 1500) {
      const ind = computeAll(d, d, 86400, null, vix, {});
      const sl = [[Y(2000), Y(2010)], [Y(2010), Y(2018)], [Y(2018), Infinity]];
      for (const sid of DAILY) {
        const s = selectStrategies([sid])[0];
        const l = backtest(s, d, { size: 1000, feePct: stock ? 0.02 : 0.01, financingPct: fin, barSec: 86400, ind, daily: d, vix }).list;
        const per = sl.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
        daily.push({ sid, per, ok: per.every((p) => p.expR > 0.02 && p.n >= 15),
          l: l.map((t) => ({ ...t, sid: `${id}:${sid}`, market: id, intraday: false, ...(micro ? { contractUsd: micro.usd(t.entry), contractFee: micro.fee } : {}) })) });
      }
    }
    report.push({ id, name: M.name || id, stock, cN, intra, daily, micro });
  };

  for (const [id, M] of Object.entries(MARKETS)) {
    if (ONLY && !ONLY.includes(id)) continue;
    let bars = null;
    try {
      bars = M.file ? JSON.parse(fs.readFileSync(path.join(CACHE, M.file), 'utf8')).filter((k) => k.c > 0 && k.t >= Date.UTC(2024, 10, 18) / 1000)
        : await polygonBars(CACHE, M.poly, 5, '2024-11-18', { maxAgeH: Infinity });
    } catch { console.log(`(${M.name} : pas de données)`); continue; }
    if (M.ny) bars = nySession(bars);
    await study(id, M, bars, M);
  }
  for (const T of STOCKS) {
    if (ONLY && !ONLY.includes(T) && !ONLY.includes('stocks')) continue;
    let bars = null;
    try { bars = nySession(await polygonBars(CACHE, T, 5, '2024-11-18', { maxAgeH: Infinity })); } catch { /* pas de données */ }
    await study(`stk_${T}`, { name: T }, bars, { ftmo: nyTimed(NY_FTMO), lucid: [], micro: null, fin: 6, yahoo: T, stock: true });
  }

  for (const r of report) {
    console.log(`\n=== ${r.name}${r.micro ? ` (Lucid ${r.micro.name})` : r.stock ? ' (FTMO seulement)' : ' (FTMO seulement : pas de micro-future chez Lucid)'} · corrélation avec le Nasdaq ${r.cN === null ? '—' : r.cN.toFixed(2)} ===`);
    for (const x of r.intra.filter((q) => q.ok)) console.log(`  ✅ intraday ${x.acct.padEnd(5)} ${x.sid.padEnd(18)} ${sgn(x.a.expR)} / ${sgn(x.b.expR)} R · ${x.st.win.toFixed(0)} % · série ${x.st.worstRun} · ${x.perDay.toFixed(2)} /j`);
    console.log(`  intraday : ${r.intra.filter((q) => q.ok).length} / ${r.intra.length} stables`);
    if (process.env.VERBOSE) for (const x of r.intra.filter((q) => !q.ok)) console.log(`     ${x.acct.padEnd(5)} ${x.sid.padEnd(18)} ${sgn(x.a.expR)} (${x.a.n}) / ${sgn(x.b.expR)} (${x.b.n}) R · série ${x.st.worstRun}`);
    for (const x of r.daily) console.log(`  ${x.ok ? '✅' : '  '} journalier ${x.sid.padEnd(8)} ${x.per.map((p) => `${sgn(p.expR)} (${p.n})`).join(' | ')} R`);
  }

  if (process.env.NO_ACCOUNTS) return;
  // Comptes
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const nasCache = {};
  const nasTrades = (sid) => (nasCache[sid] ??= backtest(selectStrategies([sid.split(':')[1]])[0], qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: 'nas100', intraday: true, contractUsd: t.entry * 82, contractFee: 2.5 })));
  // Argent et Dow (compte Lucid actuel), comme en direct
  const lucidNew = [];
  for (const [poly, mk, sid, mult, fee] of [['SLV', 'silver', 'n_wvb05_t075', 1075, 3.5], ['DIA', 'dow', 'n_mom10_t05', 50, 2.5]]) {
    const s = selectStrategies([sid])[0];
    const b = nySession(await polygonBars(CACHE, poly, 5, '2024-11-18', { maxAgeH: Infinity }));
    lucidNew.push(...backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, b, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid: `${mk}:${sid}`, market: mk, intraday: true, contractUsd: t.entry * mult, contractFee: fee })));
  }
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const sizer = RULES[cfg.ftmoSizing];
  const A0 = q5[0].t + 30 * 86400;
  const P = { B: [Y(2009) + 60 * 86400, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const levCap = Object.fromEntries(STOCKS.map((T) => [`stk_${T}`, 5]));
  const R = {
    gold: { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop, levCap },
    lucid: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop },
  };
  const ir = { gold: cfg.ftmoIntradayRisk * (cfg.ftmoRiskMul ?? 1), lucid: cfg.lucidIntradayRisk };
  const dr = { gold: cfg.ftmoRisk * (cfg.ftmoRiskMul ?? 1), lucid: cfg.ftmoRisk * cfg.lucidRiskMul };
  const evalAcc = (id, extra) => {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id);
    const sids = A.strategies.filter((k) => { const [m, s] = strat(k); return A.riskOf(m, s) > 0; });
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100'));
    const nas = sids.filter((k) => k.startsWith('nas100:') && strat(k)[1].tf && strat(k)[1].tf !== '1d').flatMap(nasTrades);
    const list = [...[...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) })), ...(id === 'lucid' ? lucidNew.map((t) => ({ ...t, riskPct: ir.lucid })) : []),
      ...extra.map((t) => ({ ...t, riskPct: t.intraday ? ir[id] : dr[id] }))];
    return Object.entries(P).map(([k, [a, b]]) => {
      // périodes longues : pas d'intraday hors or (données intraday seulement sur 2 ans)
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      const c = challengeStats(l, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...R[id] });
      return { k, pass: c.passRate, days: c.medianDays };
    });
  };
  const fmt = (r) => r.map((p) => `${p.pass.toFixed(0).padStart(3)} % (${p.days ? p.days.toFixed(0) : '—'} j)`).join(' | ');
  const worse = (r, ref) => r.some((p, i) => p.pass < ref[i].pass - 0.5);
  for (const acct of ['gold', 'lucid']) {
    const ref = evalAcc(acct, []);
    console.log(`\n=== Compte ${acct === 'gold' ? 'FTMO' : 'Lucid'} : réussite < 1 an (délai médian) · 2009–19 | 2020–26 | nov. 24–26 ===`);
    console.log(`${'actuel'.padEnd(30)} ${fmt(ref)}`);
    const keep = [];
    for (const r of report) {
      const tag = acct === 'gold' ? 'FTMO' : 'Lucid';
      const intra = r.intra.filter((q) => q.ok && q.acct === tag).flatMap((q) => q.l);
      const daily = acct === 'lucid' && !r.micro ? [] : r.daily.filter((q) => q.ok).flatMap((q) => q.l);
      for (const [what, ex] of [['intraday', intra], ['journalier', daily]]) {
        if (!ex.length) continue;
        const res = evalAcc(acct, ex);
        const good = !worse(res, ref);
        console.log(`${good ? '✅' : '  '} ${(r.name + ' ' + what).padEnd(28)} ${fmt(res)}`);
        if (good) keep.push(...ex);
      }
    }
    if (keep.length) console.log(`${'→ tous les ✅ ensemble'.padEnd(30)} ${fmt(evalAcc(acct, keep))}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
