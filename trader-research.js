#!/usr/bin/env node
/**
 * Stratégies publiées par des traders connus, en règles testables avec des bougies (pas encore dans le bot) :
 *   Toby Crabel   : cassure du range d'ouverture seulement après une journée étroite (NR4 / NR7).
 *   Larry Williams : cassure de volatilité (ouverture ± k × range de la veille) ; « Oops » (écart au-delà de la veille puis retour).
 *   Linda Raschke : « 80-20 » (veille ouverte dans un extrême, close à l'autre → retournement) ; « Turtle Soup » (fausse cassure
 *                   du plus bas / plus haut de 20 jours) ; « Holy Grail » (ADX > 30, repli sur l'EMA 20, journalier).
 * Or au comptant réel 5 min 2009–2026 (journées UTC, séance 7 h → 20 h) et Nasdaq (QQQ 5 min séance seule, 2 ans ;
 * Holy Grail sur ^NDX / GC=F journaliers). Sélection : positive sur toutes les tranches ; puis challenge FTMO et Lucid.
 *
 *   npm run traders
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
const { cachedYahoo } = require('./src/yahoo');
const S = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const hm = S.hm;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const MK = {
  gold: { tz: 'utc', open: hm(7), entryEnd: hm(16), exit: hm(19, 55), fee: 0.005, fin: 0 },
  nas100: { tz: 'ny', open: hm(9, 30), entryEnd: hm(15), exit: hm(15, 55), fee: 0.003, fin: 6 },
};

/** Niveaux journaliers pour chaque bougie : veille (o, h, l, c, NR4 / NR7, plus haut / bas 20 j), ouverture et extrêmes du jour. */
function levels(x, market) {
  const k = `lv:${market}`;
  if (x.cache[k]) return x.cache[k];
  const M = MK[market];
  const { min, day } = x.tz[M.tz];
  const c = x.candles; const n = c.length;
  const days = []; // { d, o, h, l, c } des séances finies
  const out = new Array(n).fill(null);
  let dd = null; let cur = null;
  for (let i = 0; i < n; i++) {
    if (day[i] !== dd) { if (cur && cur.o !== null) days.push(cur); dd = day[i]; cur = { d: dd, o: null, h: -Infinity, l: Infinity, c: null }; }
    const inS = market === 'gold' ? true : min[i] >= M.open && min[i] < hm(16);
    const prev = days[days.length - 1];
    if (prev && days.length >= 21) {
      const rg = (q) => q.h - q.l;
      const last = days.slice(-7);
      const nr = (m) => last.slice(-m).every((q) => rg(q) >= rg(prev));
      const w = days.slice(-21, -1); // 20 séances avant la veille
      const lo20 = Math.min(...days.slice(-20).map((q) => q.l)); const hi20 = Math.max(...days.slice(-20).map((q) => q.h));
      const loAgo = 20 - days.slice(-20).findIndex((q) => q.l === lo20); const hiAgo = 20 - days.slice(-20).findIndex((q) => q.h === hi20);
      out[i] = { p: prev, nr4: nr(4), nr7: nr(7), lo20, hi20, loAgo, hiAgo, o: cur.o, h: cur.h, l: cur.l, w };
    }
    if (inS) { if (cur.o === null) cur.o = c[i].o; cur.h = Math.max(cur.h, c[i].h); cur.l = Math.min(cur.l, c[i].l); cur.c = c[i].c; }
  }
  return (x.cache[k] = out);
}

const base = (market, id, name, evaluate) => ({
  id: `${id}_${market === 'gold' ? 'g' : 'n'}`, name: `${market === 'gold' ? 'Or' : 'Nasdaq'} : ${name}`, tf: '5m', scalp: true, warmup: 300, markets: [market],
  compute: (cd) => S.computeFor(cd, market),
  evaluate(x0, i) {
    const x = S.withNyx(x0); const M = MK[market];
    const m = x.tz[M.tz].min[i];
    const wd = new Date(x.candles[i].t * 1000).getUTCDay();
    const flat = wd === 0 || wd === 6 || m >= M.exit || m < M.open;
    const out = { entry: null, exitLong: flat, exitShort: flat, sl: 0, tp: null };
    if (flat || !(x.atr[i] > 0) || m >= M.entryEnd) return out;
    const L = levels(x, market)[i];
    if (!L || L.o === null) return out;
    const r = evaluate(x, i, m, L, M);
    return r ? { ...out, ...r } : out;
  },
});
const once = (x, M, key, i, cond) => S.firstOfDay(x, M.tz, key, cond)[i];

function crabel(market, nrN, len) {
  const id = `t_crabel${nrN}_${len}`;
  return base(market, id, `Crabel : cassure des ${len} premières min après une journée NR${nrN}`, (x, i, m, L, M) => {
    const R = S.rangeOf(x, M.tz, M.open, len);
    const ok = (j) => { const l = levels(x, market)[j]; return l && l[`nr${nrN}`] && R.hi[j] !== null; };
    const up = once(x, M, `${id}${market}u`, i, (j) => ok(j) && x.closes[j] > R.hi[j] && x.tz[M.tz].min[j] < M.entryEnd);
    const dn = once(x, M, `${id}${market}d`, i, (j) => ok(j) && x.closes[j] < R.lo[j] && x.tz[M.tz].min[j] < M.entryEnd);
    if (up) return { entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - R.lo[i]) };
    if (dn) return { entry: 'short', sl: Math.max(0.2 * x.atr[i], R.hi[i] - x.closes[i]) };
    return null;
  });
}
function williamsVB(market, kf) {
  const id = `t_wvb${String(kf).replace('.', '')}`;
  return base(market, id, `Williams : cassure de volatilité (ouverture ± ${kf} × range de la veille)`, (x, i, m, L, M) => {
    const cond = (s) => (j) => { const l = levels(x, market)[j]; if (!l || l.o === null) return false; const rg = l.p.h - l.p.l; return s > 0 ? x.closes[j] > l.o + kf * rg : x.closes[j] < l.o - kf * rg; };
    const up = once(x, M, `${id}${market}u`, i, cond(1)); const dn = once(x, M, `${id}${market}d`, i, cond(-1));
    if (up) return { entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - L.o) };
    if (dn) return { entry: 'short', sl: Math.max(0.2 * x.atr[i], L.o - x.closes[i]) };
    return null;
  });
}
function oops(market) {
  const id = 't_oops';
  return base(market, id, 'Williams « Oops » : ouverture au-delà de la veille puis retour dans son range', (x, i, m, L, M) => {
    const up = once(x, M, `${id}${market}u`, i, (j) => { const l = levels(x, market)[j]; return l && l.o !== null && l.o < l.p.l && x.closes[j] > l.p.l; });
    const dn = once(x, M, `${id}${market}d`, i, (j) => { const l = levels(x, market)[j]; return l && l.o !== null && l.o > l.p.h && x.closes[j] < l.p.h; });
    if (up) return { entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - L.l) };
    if (dn) return { entry: 'short', sl: Math.max(0.2 * x.atr[i], L.h - x.closes[i]) };
    return null;
  });
}
function r8020(market) {
  const id = 't_8020';
  return base(market, id, 'Raschke « 80-20 » : veille ouverte dans un extrême et close à l’autre, fausse cassure → retour', (x, i, m, L, M) => {
    const pos = (q, v) => (v - q.l) / Math.max(1e-9, q.h - q.l);
    const bull = (l) => pos(l.p, l.p.o) >= 0.8 && pos(l.p, l.p.c) <= 0.2; // ouverte en haut, close en bas → achat sous le plus bas puis retour
    const bear = (l) => pos(l.p, l.p.o) <= 0.2 && pos(l.p, l.p.c) >= 0.8;
    const up = once(x, M, `${id}${market}u`, i, (j) => { const l = levels(x, market)[j]; return l && bull(l) && l.l < l.p.l && x.closes[j] > l.p.l; });
    const dn = once(x, M, `${id}${market}d`, i, (j) => { const l = levels(x, market)[j]; return l && bear(l) && l.h > l.p.h && x.closes[j] < l.p.h; });
    if (up) return { entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - L.l) };
    if (dn) return { entry: 'short', sl: Math.max(0.2 * x.atr[i], L.h - x.closes[i]) };
    return null;
  });
}
function turtleSoup(market) {
  const id = 't_soup';
  return base(market, id, 'Raschke « Turtle Soup » : fausse cassure du plus bas / plus haut de 20 jours (vieux d’au moins 4 j)', (x, i, m, L, M) => {
    const up = once(x, M, `${id}${market}u`, i, (j) => { const l = levels(x, market)[j]; return l && l.loAgo >= 4 && l.l < l.lo20 && x.closes[j] > l.lo20; });
    const dn = once(x, M, `${id}${market}d`, i, (j) => { const l = levels(x, market)[j]; return l && l.hiAgo >= 4 && l.h > l.hi20 && x.closes[j] < l.hi20; });
    if (up) return { entry: 'long', sl: Math.max(0.2 * x.atr[i], x.closes[i] - L.l) };
    if (dn) return { entry: 'short', sl: Math.max(0.2 * x.atr[i], L.h - x.closes[i]) };
    return null;
  });
}

/** Holy Grail (journalier) : ADX(14) > 30, repli qui touche l'EMA 20 → achat au-dessus du plus haut de la bougie du repli. */
function holyGrailTrades(daily, { fee, fin }) {
  const n = daily.length; const c = daily.map((k) => k.c);
  const ema = []; const a = 2 / 21; c.forEach((v, i) => ema.push(i ? a * v + (1 - a) * ema[i - 1] : v));
  // ADX(14) de Wilder
  const tr = []; const pdm = []; const ndm = [];
  for (let i = 1; i < n; i++) {
    const h = daily[i].h; const l = daily[i].l; const ph = daily[i - 1].h; const pl = daily[i - 1].l; const pc = daily[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))); const up = h - ph; const dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const ws = (arr) => { const o = []; let s = 0; arr.forEach((v, i) => { s = i < 14 ? s + v : s - s / 14 + v; o.push(i >= 13 ? s : null); }); return o; };
  const TR = ws(tr); const P = ws(pdm); const N = ws(ndm);
  const dx = TR.map((t, i) => (t ? (100 * Math.abs(P[i] - N[i])) / Math.max(1e-9, P[i] + N[i]) : null));
  const adx = []; let s = null; dx.forEach((v, i) => { if (v === null) { adx.push(null); return; } s = s === null ? v : (s * 13 + v) / 14; adx.push(i >= 27 ? s : null); });
  const trades = []; let pos = null;
  for (let i = 30; i < n - 1; i++) {
    const A = adx[i - 1]; // décalage : tr / adx commencent à la bougie 1
    const k = daily[i];
    if (pos) {
      // sortie : nouveau plus haut de 5 jours (objectif) ou stop
      const hit = pos.side === 'long' ? (k.l <= pos.sl ? pos.sl : k.h >= pos.tp ? pos.tp : null) : (k.h >= pos.sl ? pos.sl : k.l <= pos.tp ? pos.tp : null);
      if (hit !== null || i - pos.i > 10) {
        const exit = hit ?? k.c; const dir = pos.side === 'long' ? 1 : -1;
        trades.push({ entry: pos.entry, initSl: pos.sl, exit, entryT: pos.t, exitT: k.t, side: pos.side, pnlPct: (dir * (exit / pos.entry - 1) - 2 * fee / 100 - (fin * (k.t - pos.t) / 86400 / 365) / 100) * 100 });
        pos = null;
      }
      continue;
    }
    if (!(A > 30)) continue;
    const prev = daily[i - 1];
    const upTrend = c[i - 1] > ema[i - 1] && P[i - 1] > N[i - 1]; const dnTrend = c[i - 1] < ema[i - 1] && N[i - 1] > P[i - 1];
    if (upTrend && prev.l <= ema[i - 1] && k.h > prev.h) {
      const entry = prev.h; const sl = prev.l; pos = { side: 'long', entry, sl, tp: Math.max(...daily.slice(i - 20, i).map((q) => q.h)), t: k.t, i };
      if (!(pos.tp > entry)) pos.tp = entry + 2 * (entry - sl);
    } else if (dnTrend && prev.h >= ema[i - 1] && k.l < prev.l) {
      const entry = prev.l; const sl = prev.h; pos = { side: 'short', entry, sl, tp: Math.min(...daily.slice(i - 20, i).map((q) => q.l)), t: k.t, i };
      if (!(pos.tp < entry)) pos.tp = entry - 2 * (sl - entry);
    }
  }
  return trades;
}

(async () => {
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const qs = require('./src/oanda').nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const fams = (mk) => [crabel(mk, 4, 15), crabel(mk, 4, 30), crabel(mk, 7, 15), crabel(mk, 7, 30), williamsVB(mk, 0.3), williamsVB(mk, 0.5), williamsVB(mk, 0.7), oops(mk), r8020(mk), turtleSoup(mk)];
  const withTp = (s, k) => ({ ...s, id: `${s.id}_t${String(k).replace('.', '')}`, name: `${s.name} · objectif ${k} R`, evaluate: (x, i) => { const r = s.evaluate(x, i); return r.entry && r.sl > 0 ? { ...r, tp: k * r.sl } : r; } });
  const rows = [];
  const run = (s, cd, mk, slices) => {
    const M = MK[mk];
    const l = backtest(s, cd, { size: 1000, feePct: M.fee, financingPct: M.fin, barSec: 300, market: mk }).list;
    const per = slices.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
    const st = rStats(l.filter((t) => t.entryT >= slices[0][0]));
    return { s, mk, l, per, st, ok: per.every((p) => p.expR > 0.02 && p.n >= 25) };
  };
  const gSl = [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]];
  const q0 = qs[0].t + 30 * 86400; const q1 = qs[qs.length - 1].t; const nSl = [[q0, (q0 + q1) / 2], [(q0 + q1) / 2, Infinity]];
  for (const s of fams('gold')) rows.push(run(s, g5, 'gold', gSl));
  for (const s of fams('nas100')) for (const v of [s, withTp(s, 0.5), withTp(s, 0.75)]) rows.push(run(v, qs, 'nas100', nSl));
  // Holy Grail journalier (Nasdaq 1985–2026, or 2001–2026)
  const ndx = (await cachedYahoo(CACHE, '^NDX', '1d', {}, Infinity)).filter((k) => k.c > 0);
  const gc = (await cachedYahoo(CACHE, 'GC=F', '1d', {}, Infinity)).filter((k) => k.c > 0);
  for (const [mk, d, sl] of [['nas100', ndx, [[Y(1985), Y(2000)], [Y(2000), Y(2013)], [Y(2013), Infinity]]], ['gold', gc, [[Y(2001), Y(2010)], [Y(2010), Y(2018)], [Y(2018), Infinity]]]]) {
    const l = holyGrailTrades(d, MK[mk]).map((t) => ({ ...t, intraday: false }));
    const per = sl.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
    rows.push({ s: { id: `t_grail_${mk === 'gold' ? 'g' : 'n'}`, name: `${mk === 'gold' ? 'Or' : 'Nasdaq'} : Raschke « Holy Grail » (journalier, ADX > 30, repli sur l’EMA 20)` }, mk, l, per, st: rStats(l), ok: per.every((p) => p.expR > 0.02 && p.n >= 10), daily: true });
  }
  rows.sort((a, b) => Math.min(...b.per.map((p) => p.expR)) - Math.min(...a.per.map((p) => p.expR)));
  console.log('=== R moyen par tranche (or 2009–14 / 15–20 / 21–26 ; Nasdaq intraday 2 années ; Holy Grail : 3 tranches longues) · trades · gagnants · pire série · baisse max ===');
  for (const r of rows) console.log(`${r.ok ? '✅' : '  '} ${r.s.id.padEnd(20)} ${r.per.map((p) => `${p.expR >= 0 ? '+' : ''}${p.expR.toFixed(2)}`.padStart(6)).join(' |')} R · ${String(r.st.n).padStart(5)} tr · ${r.st.win.toFixed(0)} % · série ${String(r.st.worstRun).padStart(2)} · baisse ${r.st.maxDdR.toFixed(1).padStart(5)} R  ${r.s.name}`);
  const kept = rows.filter((r) => r.ok && !r.daily);
  console.log(`\n${rows.filter((r) => r.ok).length} retenue(s) (dont ${kept.length} intraday rejouées dans les challenges).`);
  if (!kept.length) return;

  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const G = accountOf(cfg, 'gold'); const Lc = accountOf(cfg, 'lucid');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '5m' }]; };
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')], A: [q5[0].t + 30 * 86400, Infinity, () => true] };
  const ACC = {
    FTMO: { A: G, R: { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop }, extraRisk: cfg.ftmoIntradayRisk * (cfg.ftmoRiskMul ?? 1) },
    Lucid: { A: Lc, R: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop }, extraRisk: cfg.lucidIntradayRisk },
  };
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const evalAcc = (name, extra) => { const X = ACC[name]; return Object.entries(P).map(([k, [a, b, f]]) => {
    const list = [...all.filter((t) => X.A.strategies.includes(t.sid)).map((t) => ({ ...t, riskPct: X.A.riskOf(...strat(t.sid)) })), ...extra.map((t) => ({ ...t, riskPct: X.extraRisk }))]
      .filter((t) => t.riskPct > 0 && t.entryT >= a && t.entryT < b && f(t));
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...X.R });
    return `${k} ${c.passRate.toFixed(0)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`; }).join(' | '); };
  console.log('\n=== Challenges (réussite < 1 an : 2009–19 | 2020–26 | nov. 24–26) ===');
  console.log(`${'actuel'.padEnd(24)} FTMO ${evalAcc('FTMO', [])}  ·  Lucid ${evalAcc('Lucid', [])}`);
  for (const r of kept) {
    const mult = r.mk === 'gold' ? 10 : 82; const fee = r.mk === 'gold' ? 3.5 : 2.5;
    const extra = r.l.map((t) => ({ ...t, sid: `${r.mk}:${r.s.id}`, market: r.mk, intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
    const lucidOk = r.mk === 'nas100'; // pas d'intraday or sur Lucid (1 MGC trop gros)
    console.log(`${('+ ' + r.s.id).padEnd(24)} FTMO ${evalAcc('FTMO', extra)}  ·  Lucid ${lucidOk ? evalAcc('Lucid', extra) : '— (or intraday exclu)'}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
