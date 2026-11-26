#!/usr/bin/env node
/**
 * Séance de New York, idées jamais testées (npm run ny) — le reste de la séance (cassures d'ouverture, Crabel, Williams,
 * momentum de fin de journée, ICT, annonces) est déjà couvert :
 *   1. Contre l'élan d'ouverture : mouvement 9 h 30 → 10 h ≥ k × sa moyenne (20 j) → contre-tendance jusqu'à 12 h.
 *   2. Retournement de la mi-journée : matinée 9 h 30 → 12 h ≥ k × sa moyenne → contre-tendance jusqu'à 15 h 30.
 *   3. Retournement à la clôture de Londres : tendance 9 h 30 → 11 h 30 → contre-tendance jusqu'à 13 h 30.
 *   4. Cassure du range de midi (12 h → 13 h 30) entre 13 h 30 et 15 h : on suit, stop de l'autre côté, objectif 2 R.
 * Heures de New York. QQQ / SPY 5 min (séance, nov. 2024 → nov. 2026, ≈ MNQ / MES), or au comptant 5 min 2009 → 2026.
 * Frais : indices 0,01 %, or 0,015 % aller-retour. Puis effet sur la réussite FTMO et Lucid.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, runPhase, cmeDay, rStats } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y, m = 1) => Date.UTC(y, m - 1, 1) / 1000;
const DAY = 86400;
const sgn = (x, d = 2) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;
const load = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')).filter((k) => k.c > 0);

/* ---------- Heure de New York ---------- */
const offC = new Map();
const nyOff = (t) => { const d = Math.floor(t / DAY); if (!offC.has(d)) { const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date((d * DAY + 61200) * 1000)).find((p) => p.type === 'timeZoneName').value; offC.set(d, (Number((s.match(/GMT([+-]\d+)/) || [])[1]) || -5) * 3600); } return offC.get(d); };
const nyMin = (t) => Math.floor(((t + nyOff(t)) % DAY) / 60);
const nyDay = (t) => Math.floor((t + nyOff(t)) / DAY);

/* ---------- Indicateurs journaliers ---------- */
const sma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
function atrPct(d, n = 14) { const out = []; let a = null; for (let i = 0; i < d.length; i++) { const tr = i ? Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c), Math.abs(d[i].l - d[i - 1].c)) : d[i].h - d[i].l; a = a === null ? tr : (a * (n - 1) + tr) / n; out.push((a / d[i].c) * 100); } return out; }
function rsi2(c) { const out = [null]; let up = 0, dn = 0; for (let i = 1; i < c.length; i++) { const ch = c[i] - c[i - 1]; up = (up + Math.max(ch, 0)) / 2; dn = (dn + Math.max(-ch, 0)) / 2; out.push(dn === 0 ? 100 : 100 - 100 / (1 + up / dn)); } return out; }

// Trade au format des simulateurs de comptes : entry, initSl (stop), pnlPct, temps
const mk = (o) => ({ ...o, initSl: o.side === 'long' ? o.entry * (1 - o.stopPct / 100) : o.entry * (1 + o.stopPct / 100) });

/* ---------- 2. Dérive de nuit ---------- */
function overnight(d, market, variant, fee = 0.02) {
  const c = d.map((k) => k.c); const atr = atrPct(d); const out = [];
  for (let i = 200; i < d.length - 1; i++) {
    const gapDays = (d[i + 1].t - d[i].t) / DAY;
    if (variant.noWeekend && gapDays > 1.5) continue;
    if (variant.trend && !(c[i] > sma(c, 200, i))) continue;
    if (variant.afterDown && !(d[i].c < d[i].o)) continue;
    const stopPct = atr[i] * 0.75;
    let pnl = (d[i + 1].o / c[i] - 1) * 100;
    if (pnl < -stopPct) pnl = -stopPct; // stop touché pendant la nuit (futures)
    out.push(mk({ market, sid: `${market}:x_night${variant.tag}`, side: 'long', entry: c[i], stopPct, pnlPct: pnl - fee, entryT: d[i].t + 20.5 * 3600, exitT: d[i + 1].t + 14.5 * 3600, intraday: false }));
  }
  return out;
}
/* ---------- 4. VIX stretch ---------- */
function vixStretch(d, vix, market, fee = 0.02) {
  const vm = new Map(vix.map((k) => [k.t, k.c])); const c = d.map((k) => k.c); const r2 = rsi2(c); const atr = atrPct(d, 10); const out = [];
  const vs = d.map((k) => vm.get(k.t) ?? null);
  for (let i = 210; i < d.length - 1; i++) {
    let ok = c[i] > sma(c, 200, i);
    for (let k = 0; k < 3 && ok; k++) { const j = i - k; const w = vs.slice(j - 9, j + 1); if (w.some((x) => x == null)) { ok = false; break; } ok = vs[j] >= 1.05 * (w.reduce((a, b) => a + b, 0) / 10); }
    if (!ok) continue;
    const e = c[i]; const stopPct = 2.5 * atr[i]; let j = i + 1; let pnl = null;
    for (; j < Math.min(d.length, i + 11); j++) {
      if ((d[j].l / e - 1) * 100 <= -stopPct) { pnl = -stopPct; break; }
      if (r2[j] > 65 || j === i + 10) { pnl = (c[j] / e - 1) * 100; break; }
    }
    if (pnl === null) continue;
    out.push(mk({ market, sid: `${market}:x_vixstretch`, side: 'long', entry: e, stopPct, pnlPct: pnl - fee, entryT: d[i].t + 20.5 * 3600, exitT: d[j].t + 20.5 * 3600, intraday: false }));
    i = j;
  }
  return out;
}
/* ---------- 5. Mardi de retournement ---------- */
function turnaroundTuesday(d, market, fee = 0.02) {
  const atr = atrPct(d); const out = [];
  for (let i = 1; i < d.length - 1; i++) {
    if (new Date(d[i].t * 1000).getUTCDay() !== 1 || !(d[i].c < d[i - 1].c * 0.99)) continue;
    const e = d[i].c; const stopPct = 2 * atr[i];
    const pnl = (d[i + 1].l / e - 1) * 100 <= -stopPct ? -stopPct : (d[i + 1].c / e - 1) * 100;
    out.push(mk({ market, sid: `${market}:x_turntue`, side: 'long', entry: e, stopPct, pnlPct: pnl - fee, entryT: d[i].t + 20.5 * 3600, exitT: d[i + 1].t + 20.5 * 3600, intraday: false }));
  }
  return out;
}
/* ---------- 3. Paires (z-score du log-ratio, 50 j) ---------- */
function pairs(a, b, market, tag, fee = 0.04) {
  const mb = new Map(b.map((k) => [k.t, k.c])); const rows = a.filter((k) => mb.has(k.t)).map((k) => ({ t: k.t, a: k.c, b: mb.get(k.t) }));
  const lr = rows.map((r) => Math.log(r.a / r.b)); const out = [];
  const z = (i) => { const w = lr.slice(i - 49, i + 1); const m = w.reduce((x, y) => x + y, 0) / 50; const sd = Math.sqrt(w.reduce((x, y) => x + (y - m) ** 2, 0) / 50); return sd ? (lr[i] - m) / sd : 0; };
  // Volatilité de l'écart (pour le stop) : écart-type des variations quotidiennes du log-ratio sur 50 j
  const vol = (i) => { const ch = []; for (let k = i - 49; k <= i; k++) ch.push(lr[k] - lr[k - 1]); const m = ch.reduce((x, y) => x + y, 0) / ch.length; return Math.sqrt(ch.reduce((x, y) => x + (y - m) ** 2, 0) / ch.length); };
  for (let i = 60; i < rows.length - 1; i++) {
    const zi = z(i); if (Math.abs(zi) < 2) continue;
    const dir = zi > 0 ? -1 : 1; // ratio haut : on vend a, on achète b (rendement de l'écart = dir × variation du log-ratio)
    const stopPct = 3 * vol(i) * 100 * Math.sqrt(5) / 2; // demi-position par jambe
    let j = i + 1; let pnl = null;
    for (; j < Math.min(rows.length, i + 21); j++) {
      const p = (dir * (lr[j] - lr[i]) * 100) / 2;
      if (p <= -stopPct) { pnl = -stopPct; break; }
      if (Math.abs(z(j)) < 0.5 || j === i + 20) { pnl = p; break; }
    }
    if (pnl === null) continue;
    out.push(mk({ market, sid: `${market}:x_pair${tag}`, side: 'long', entry: 100, stopPct, pnlPct: pnl - fee, entryT: rows[i].t + 20.5 * 3600, exitT: rows[j].t + 20.5 * 3600, intraday: false }));
    i = j;
  }
  return out;
}
/* ---------- 1. Annonces (intraday) ---------- */
// Jours d'annonce : bougie 5 min de l'heure H ≥ 3 × la médiane des bougies 5 min de l'heure qui précède
function newsDays(b5, hm) {
  const byDay = new Map();
  for (const k of b5) { const d = nyDay(k.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(k); }
  const out = new Set();
  for (const [d, list] of byDay) {
    const at = list.find((k) => nyMin(k.t) === hm); if (!at) continue;
    const before = list.filter((k) => nyMin(k.t) >= hm - 60 && nyMin(k.t) < hm).map((k) => k.h - k.l).sort((x, y) => x - y);
    if (before.length < 6) continue;
    const med = before[Math.floor(before.length / 2)];
    if (med > 0 && at.h - at.l >= 3 * med) out.add(d);
  }
  return out;
}
// Fade ou cassure du mouvement d'annonce : mesure entre `from` et `at` (minutes NY), entrée à `at`, sortie `until`
function newsTrades(b5, days, { from, at, until, mode, market, tag, fee }) {
  const byDay = new Map();
  for (const k of b5) { const d = nyDay(k.t); if (!days.has(d)) continue; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(k); }
  const out = [];
  for (const [, list] of byDay) {
    const pre = list.find((k) => nyMin(k.t) === from - 5); const e = list.find((k) => nyMin(k.t) === at - 5);
    if (!pre || !e) continue;
    const win = list.filter((k) => nyMin(k.t) >= from && nyMin(k.t) < at);
    if (!win.length) continue;
    const move = e.c - pre.c; if (!move) continue;
    const hi = Math.max(...win.map((k) => k.h)), lo = Math.min(...win.map((k) => k.l));
    const dir = mode === 'fade' ? -Math.sign(move) : Math.sign(move);
    const entry = e.c;
    const sl = dir > 0 ? lo - 0.0002 * entry : hi + 0.0002 * entry;
    const risk = Math.abs(entry - sl); if (!(risk > 0)) continue;
    const tp = mode === 'fade' ? entry + dir * Math.max(risk, Math.abs(move) / 2) : entry + dir * 2 * risk;
    let exit = null, exitT = null;
    for (const k of list.filter((x) => nyMin(x.t) >= at && nyMin(x.t) < until)) {
      if (dir > 0 ? k.l <= sl : k.h >= sl) { exit = sl; exitT = k.t + 300; break; }
      if (dir > 0 ? k.h >= tp : k.l <= tp) { exit = tp; exitT = k.t + 300; break; }
      exit = k.c; exitT = k.t + 300;
    }
    if (exit === null) continue;
    const stopPct = (risk / entry) * 100;
    out.push(mk({ market, sid: `${market}:x_news${tag}`, side: dir > 0 ? 'long' : 'short', entry, stopPct, pnlPct: dir * (exit / entry - 1) * 100 - fee, entryT: e.t + 300, exitT, intraday: true }));
  }
  return out;
}

(async () => {
  /* ---------- Comptes actuels (comme npm run ai-research) ---------- */
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const nyRun = (bars, s, sid, m, mult, fee) => backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, bars, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  const NYB = {
    nas100: [qs, 82, 2.5], silver: [nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity })), 1075, 3.5],
    dow: [nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    russell: [nySession(await polygonBars(CACHE, 'IWM', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    spx: [nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60)), 50, 4],
  };
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const accts = {};
  for (const id of ['ftmo', 'lucid']) {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true, lucidSplit: false }, id === 'ftmo' ? 'gold' : 'lucid');
    const sids = A.strategies.filter((k) => A.riskOf(...strat(k), 'eval') > 0);
    const intra = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; })
      .flatMap((k) => { const [b, mult, fee] = NYB[k.split(':')[0]]; return nyRun(b, strat(k)[1], k, k.split(':')[0], mult, fee); });
    const list = [...all.filter((t) => sids.includes(t.sid) && !(t.intraday && NYB[t.market])), ...intra].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid), 'eval') }));
    accts[id] = { A, list };
  }
  const RF = { steps: 1, capital: 100_000, target: 10, target1: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, riskPct: 1,
    sizer: RULES[cfg.ftmoSizing], dayProfitCapUsd: (cfg.ftmoDayProfitCapPct / 100) * 10_000, maxLossesPerDay: cfg.ftmoMaxLossesDay || Infinity };
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2,
    contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer: RULES[cfg.ftmoSizing],
    dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * 50_000 * 0.06, maxLossesPerDay: cfg.lucidMaxLossesDay || Infinity };
  const evaluate = (id, list) => {
    const o = id === 'ftmo' ? RF : RL;
    const per = Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      return challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...o }).passRate;
    });
    const res = { per, p14: 0, p30: 0, f14: 0 };
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
  const fmt = (r) => `${r.per.map((p) => `${p.toFixed(0).padStart(3)} %`).join(' |')}${r.p14 || r.p30 ? ` || ≤14 j ${r.p14.toFixed(0).padStart(2)} % · ≤30 j ${r.p30.toFixed(0).padStart(2)} % · échec ≤14 j ${r.f14.toFixed(0).padStart(2)} %` : ''}`;
  const better = (r, ref, id) => r.per.every((p, i) => p >= ref.per[i] - 0.5) && (id !== 'lucid' || (r.p14 >= ref.p14 - 0.5 && r.f14 <= ref.f14 + 0.5))
    && (r.per.some((p, i) => p > ref.per[i] + 0.5) || (id === 'lucid' && (r.p14 > ref.p14 + 0.5 || r.p30 > ref.p30 + 0.5)));
  const ref = { ftmo: evaluate('ftmo', accts.ftmo.list), lucid: evaluate('lucid', accts.lucid.list) };
  console.log(`Référence · FTMO ${fmt(ref.ftmo)}\n            Lucid ${fmt(ref.lucid)}  (réussite < 1 an 2009–19 | 2020–26 | nov. 24–26)\n`);



  /* ---------- Données (heure de New York) ---------- */
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const ix = (tk) => { const out = []; for (const k of JSON.parse(fs.readFileSync(path.join(CACHE, `polygon-${tk}-1m-2024-11-18.json`), 'utf8'))) { const m = nyMin(k.t); if (m < 570 || m >= 960) continue; const t = Math.floor(k.t / 300) * 300; const c = out[out.length - 1];
    if (!c || c.t !== t) out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c }); else { c.h = Math.max(c.h, k.h); c.l = Math.min(c.l, k.l); c.c = k.c; } } return out; };
  const byDay = (bars) => { const m = new Map(); for (const b of bars) { const d = nyDay(b.t); if (!m.has(d)) m.set(d, []); m.get(d).push(b); } return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l); };
  const win = (list, a, b) => list.filter((x) => { const m = nyMin(x.t); return m >= a && m < b; });
  const barAt = (list, m) => list.find((x) => nyMin(x.t) === m);
  const tradeOf = (o) => mk({ ...o, stopPct: (Math.abs(o.entry - o.sl) / o.entry) * 100, pnlPct: (o.side === 'long' ? 1 : -1) * (o.exit / o.entry - 1) * 100 - o.fee });
  const walk = (bars, side, sl, tp) => { let exit = null, exitT = null; for (const b of bars) { if (side === 'long' ? b.l <= sl : b.h >= sl) return [sl, b.t + 300]; if (tp != null && (side === 'long' ? b.h >= tp : b.l <= tp)) return [tp, b.t + 300]; exit = b.c; exitT = b.t + 300; } return [exit, exitT]; };

  // Contre-tendance d'un mouvement (a → b) au-delà de k × sa moyenne sur 20 jours ; entrée à b, sortie à `until`
  function fadeMove(bars, market, { a, b, until, k, fee, tag, tp = 'half' }) {
    const out = []; const hist = [];
    for (const list of byDay(bars)) {
      const o = barAt(list, a), e = barAt(list, b - 5); const w = win(list, a, b);
      if (!o || !e || w.length < 3) continue;
      const mv = e.c - o.o; const avg = hist.length >= 20 ? hist.slice(-20).reduce((x, y) => x + Math.abs(y), 0) / 20 : null; hist.push(mv);
      if (!avg || Math.abs(mv) < k * avg) continue;
      const side = mv > 0 ? 'short' : 'long'; const entry = e.c;
      const ext = side === 'short' ? Math.max(...w.map((x) => x.h)) : Math.min(...w.map((x) => x.l));
      const sl = side === 'short' ? ext + 0.1 * Math.abs(mv) : ext - 0.1 * Math.abs(mv); const risk = Math.abs(entry - sl); if (!(risk > 0)) continue;
      const tpx = tp === 'half' ? entry + (side === 'long' ? 1 : -1) * Math.max(risk, Math.abs(mv) / 2) : entry + (side === 'long' ? 1 : -1) * risk;
      const [exit, exitT] = walk(win(list, b, until), side, sl, tpx);
      if (exit != null) out.push(tradeOf({ market, sid: `${market}:x_ny_${tag}`, side, entry, sl, exit, entryT: e.t + 300, exitT, fee, intraday: true }));
    }
    return out;
  }
  // Cassure du range de midi : range [a, b), cassure entre b et c → on suit, stop de l'autre côté, objectif 2 R ; sortie `until`
  function middayBreak(bars, market, { a = 720, b = 810, c = 900, until = 955, fee, tag }) {
    const out = [];
    for (const list of byDay(bars)) {
      const r = win(list, a, b); if (r.length < 6) continue;
      const hi = Math.max(...r.map((x) => x.h)), lo = Math.min(...r.map((x) => x.l));
      const w = win(list, b, c);
      for (const x of w) {
        let side = null; if (x.c > hi) side = 'long'; else if (x.c < lo) side = 'short'; if (!side) continue;
        const entry = x.c; const sl = side === 'long' ? lo : hi; const risk = Math.abs(entry - sl); if (!(risk > 0)) break;
        const [exit, exitT] = walk(win(list, nyMin(x.t) + 5, until), side, sl, entry + (side === 'long' ? 2 : -2) * risk);
        if (exit != null) out.push(tradeOf({ market, sid: `${market}:x_ny_${tag}`, side, entry, sl, exit, entryT: x.t + 300, exitT, fee, intraday: true }));
        break;
      }
    }
    return out;
  }

  /* ---------- Candidats ---------- */
  const cands = [];
  const sets = [['nas100', ix('QQQ'), 'intra', 0.01], ['spx', ix('SPY'), 'intra', 0.01], ['gold', g5, 'gold', 0.015]];
  for (const [m, bars, kind, fee] of sets) {
    for (const k of [1.5, 2]) {
      cands.push({ name: `${m} contre l'élan d'ouverture (≥ ${k} ×)`, kind, trades: fadeMove(bars, m, { a: 570, b: 600, until: 720, k, fee, tag: `odf${k}` }) });
      cands.push({ name: `${m} retournement de mi-journée (≥ ${k} ×)`, kind, trades: fadeMove(bars, m, { a: 570, b: 720, until: 930, k, fee, tag: `mid${k}` }) });
      cands.push({ name: `${m} retournement clôture de Londres (≥ ${k} ×)`, kind, trades: fadeMove(bars, m, { a: 570, b: 690, until: 810, k, fee, tag: `ldn${k}` }) });
    }
    cands.push({ name: `${m} cassure du range de midi`, kind, trades: middayBreak(bars, m, { fee, tag: 'midbrk' }) });
  }

  /* ---------- 1. Seules ---------- */
  const PER = {
    gold: [['2009–12', Y(2009), Y(2013)], ['2013–16', Y(2013), Y(2017)], ['2017–19', Y(2017), Y(2020)], ['2020–26', Y(2020), Infinity]],
    intra: [['nov. 24–juil. 25', Y(2024, 11), Y(2025, 7)], ['juil. 25–mars 26', Y(2025, 7), Y(2026, 3)], ['mars–nov. 26', Y(2026, 3), Infinity]],
  };
  console.log('=== Seules (R moyen par trade, frais compris, par période) ===');
  const keep = [];
  for (const c of cands) {
    const per = PER[c.kind].map(([, a, b]) => rStats(c.trades.filter((t) => t.entryT >= a && t.entryT < b)));
    const ok = per.every((p) => p.n >= (c.kind === 'gold' ? 30 : 12) && p.expR > 0.02);
    console.log(`${ok ? '✅' : '  '} ${c.name.padEnd(48)} ${per.map((p) => `${sgn(p.expR)} R (${String(p.n).padStart(4)})`).join(' / ')}`);
    if (ok) keep.push(c);
  }

  /* ---------- 2. Effet sur les comptes ---------- */
  console.log('\n=== Effet sur la réussite (ajoutée seule au compte, risque intraday du compte) ===');
  const added = { ftmo: [], lucid: [] };
  const CT = { nas100: [2 * 41, 2.5], spx: [5 * 10, 4], gold: [10, 3.5] };
  const withRisk = (id, c) => {
    const r = id === 'lucid' ? (cfg.lucidIntradayRisk ?? 0.45) * (cfg.lucidEvalIntradayMul ?? 1) : (cfg.ftmoIntradayRisk || 0.15) * (cfg.ftmoRiskMul ?? 1) * (cfg.ftmoEvalIntradayMul ?? 1);
    return c.trades.map((t) => ({ ...t, riskPct: r, contractUsd: t.entry * CT[t.market][0], contractFee: CT[t.market][1] }));
  };
  for (const c of keep) {
    for (const id of ['ftmo', 'lucid']) {
      const r = evaluate(id, [...accts[id].list, ...withRisk(id, c)]);
      const good = better(r, ref[id], id);
      console.log(`${good ? '✅' : '  '} ${id.padEnd(5)} + ${c.name.padEnd(46)} ${fmt(r)}`);
      if (good) added[id].push(c);
    }
  }
  if (!keep.length) console.log('  (aucune stratégie stable sur toutes les périodes)');
  for (const id of ['ftmo', 'lucid']) {
    if (added[id].length < 2) continue;
    const r = evaluate(id, [...accts[id].list, ...added[id].flatMap((c) => withRisk(id, c))]);
    console.log(`\n${id} + toutes les retenues (${added[id].map((c) => c.name).join(', ')}) : ${fmt(r)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
