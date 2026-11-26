#!/usr/bin/env node
/**
 * Nouvelles idées de stratégies (npm run ideas), jamais testées dans le bot :
 *   1. Annonces (inflation / emploi à 8 h 30 New York, Fed à 14 h) : jouer contre le 1er mouvement (« fade ») ou le suivre
 *      (cassure), et filtre « pas de trade autour des annonces » sur les stratégies intraday actuelles. Jours d'annonce
 *      repérés dans les données (bougie de 8 h 30 ou de 14 h ≥ 3 × l'amplitude habituelle) : QQQ / SPY 1 min avec
 *      pré-ouverture (nov. 2024 → nov. 2026) et or 5 min (2009 → 2026).
 *   2. Dérive de nuit : acheter l'indice à la clôture, revendre à l'ouverture suivante (^NDX, ^GSPC 2000 → 2026).
 *   3. Paires : ratio or / argent et écart Nasdaq / S&P, retour à la moyenne (z-score 50 j), journalier 2000 → 2026.
 *   4. Rebond après panique (Connors « VIX stretch ») : VIX ≥ 5 % au-dessus de sa moyenne 10 j trois jours de suite,
 *      indice au-dessus de sa moyenne 200 j → achat ; sortie RSI 2 > 65 ou 10 jours.
 *   5. Mardi de retournement : lundi en baisse de plus de 1 % → achat à la clôture, vente le mardi à la clôture.
 * Filtre habituel : positive sur CHAQUE période, frais compris ; puis effet sur la réussite FTMO et Lucid (réglages
 * actuels) : ajoutée seulement si aucune période ne baisse et qu'au moins une monte (Lucid : aussi ≤ 14 j).
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
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id === 'ftmo' ? 'gold' : 'lucid');
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

  /* ---------- Candidats ---------- */
  const ndx = load('yahoo-_NDX-1d-all.json').filter((k) => k.t >= Y(2000)), spxD = load('yahoo-_GSPC-1d-all.json').filter((k) => k.t >= Y(2000));
  const gc = load('yahoo-GC_F-1d-all.json'), si = load('yahoo-SI_F-1d-all.json'), vix = load('yahoo-_VIX-1d-all.json');
  const cands = [];
  for (const [m, d] of [['nas100', ndx], ['spx', spxD]]) {
    for (const v of [{ tag: '' }, { tag: '_nw', noWeekend: true }, { tag: '_tr', trend: true }, { tag: '_dn', afterDown: true }]) cands.push({ name: `Nuit ${m}${v.tag}`, kind: 'daily', trades: overnight(d, m, v) });
    cands.push({ name: `VIX stretch ${m}`, kind: 'daily', trades: vixStretch(d, vix, m) });
    cands.push({ name: `Mardi de retournement ${m}`, kind: 'daily', trades: turnaroundTuesday(d, m) });
  }
  cands.push({ name: 'Paire or / argent', kind: 'daily', ftmoOnly: true, trades: pairs(gc, si, 'gold', 'gs') });
  cands.push({ name: 'Paire Nasdaq / S&P', kind: 'daily', ftmoOnly: true, trades: pairs(ndx, spxD, 'nas100', 'ns') });
  // Annonces : QQQ / SPY 1 min avec pré-ouverture → 5 min
  // 5 min sans écarter les bougies incomplètes (la pré-ouverture a des minutes sans échange)
  const raw = (tk) => { const out = []; for (const k of JSON.parse(fs.readFileSync(path.join(CACHE, `polygon-${tk}-1m-2024-11-18.json`), 'utf8'))) { const t = Math.floor(k.t / 300) * 300; const c = out[out.length - 1];
    if (!c || c.t !== t) out.push({ t, o: k.o, h: k.h, l: k.l, c: k.c }); else { c.h = Math.max(c.h, k.h); c.l = Math.min(c.l, k.l); c.c = k.c; } } return out; };
  const news = {};
  for (const [m, tk] of [['nas100', 'QQQ'], ['spx', 'SPY']]) {
    const b5 = raw(tk);
    const d830 = newsDays(b5, 510), dfomc = newsDays(b5, 840);
    news[m] = { d830, dfomc };
    console.log(`${m} : ${d830.size} jours d'annonce à 8 h 30, ${dfomc.size} jours d'annonce à 14 h (repérés dans les données)`);
    for (const mode of ['fade', 'cassure']) {
      cands.push({ name: `Annonce 8 h 30 ${mode} ${m}`, kind: 'intra', trades: newsTrades(b5, d830, { from: 510, at: 575, until: 720, mode, market: m, tag: `830${mode[0]}`, fee: 0.01 }) });
      cands.push({ name: `Fed 14 h ${mode} ${m}`, kind: 'intra', trades: newsTrades(b5, dfomc, { from: 840, at: 855, until: 955, mode, market: m, tag: `fomc${mode[0]}`, fee: 0.01 }) });
    }
  }
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
  const gd830 = newsDays(g5, 510);
  console.log(`or : ${gd830.size} jours d'annonce à 8 h 30 (2009–2026)\n`);
  for (const mode of ['fade', 'cassure']) cands.push({ name: `Annonce 8 h 30 ${mode} or`, kind: 'gold', ftmoOnly: true, trades: newsTrades(g5, gd830, { from: 510, at: 540, until: 660, mode, market: 'gold', tag: `830${mode[0]}g`, fee: 0.01 }) });

  /* ---------- 1. Seules : stables sur chaque période ? ---------- */
  const PER = {
    daily: [['2000–09', Y(2000), Y(2010)], ['2010–19', Y(2010), Y(2020)], ['2020–26', Y(2020), Infinity]],
    gold: [['2009–14', Y(2009), Y(2015)], ['2015–19', Y(2015), Y(2020)], ['2020–26', Y(2020), Infinity]],
    intra: [['nov. 24–juil. 25', Y(2024, 11), Y(2025, 7)], ['juil. 25–mars 26', Y(2025, 7), Y(2026, 3)], ['mars–nov. 26', Y(2026, 3), Infinity]],
  };
  console.log('=== Seules (R moyen par trade, frais compris, par période) ===');
  const keep = [];
  for (const c of cands) {
    const per = PER[c.kind].map(([, a, b]) => rStats(c.trades.filter((t) => t.entryT >= a && t.entryT < b)));
    const minN = c.kind === 'intra' ? 8 : 20;
    const ok = per.every((p) => p.n >= minN && p.expR > 0.02);
    console.log(`${ok ? '✅' : '  '} ${c.name.padEnd(32)} ${per.map((p) => `${sgn(p.expR)} R (${String(p.n).padStart(4)})`).join(' / ')}`);
    if (ok) keep.push(c);
  }

  /* ---------- 2. Effet sur les comptes ---------- */
  console.log('\n=== Effet sur la réussite (ajoutée seule au compte, risque des journalières / de l’intraday du compte) ===');
  const added = { ftmo: [], lucid: [] };
  const CONTRACT = { nas100: [2, 2.5], spx: [5, 4], gold: [10, 3.5] };
  const withRisk = (id, c) => {
    const A = accts[id].A;
    const tf = c.kind === 'daily' ? '1d' : '5m';
    const st = { id: 'x', tf };
    let r = id === 'lucid' && tf !== '1d' ? (cfg.lucidIntradayRisk ?? 0.45) * (cfg.lucidEvalIntradayMul ?? 1) : A.riskOf(c.trades[0]?.market || 'gold', tf === '1d' ? { id: 'x', tf: '1d' } : null, 'eval');
    if (id === 'ftmo' && tf !== '1d') r = (cfg.ftmoIntradayRisk || 0.15) * (cfg.ftmoRiskMul ?? 1) * (cfg.ftmoEvalIntradayMul ?? 1);
    void st;
    const [mult, fee] = CONTRACT[c.trades[0]?.market] || [2, 2.5];
    // Contrat Lucid : la valeur du point × le cours (QQQ / SPY ≈ indice / 41 et / 10 pour les annonces intraday)
    const scale = c.kind === 'intra' ? (c.trades[0]?.market === 'nas100' ? 41 : 10) : 1;
    return c.trades.map((t) => ({ ...t, riskPct: r, contractUsd: t.entry * mult * scale, contractFee: fee }));
  };
  for (const c of keep) {
    for (const id of ['ftmo', 'lucid']) {
      if (id === 'lucid' && c.ftmoOnly) continue;
      const r = evaluate(id, [...accts[id].list, ...withRisk(id, c)]);
      const good = better(r, ref[id], id);
      console.log(`${good ? '✅' : '  '} ${id.padEnd(5)} + ${c.name.padEnd(30)} ${fmt(r)}`);
      if (good) added[id].push(c);
    }
  }
  // Filtre « pas de trade autour des annonces » sur l'intraday Nasdaq / S&P actuel (fenêtre nov. 24–26)
  console.log('\n=== Filtre : pas de nouvelle position intraday Nasdaq / S&P autour des annonces ===');
  const inNews = (t) => { const n = news[t.market]; if (!n || !t.intraday) return false; const d = nyDay(t.entryT); const m = nyMin(t.entryT); return (n.d830.has(d) && m < 600) || (n.dfomc.has(d) && m >= 810 && m < 900); };
  for (const id of ['ftmo', 'lucid']) {
    const r = evaluate(id, accts[id].list.filter((t) => !inNews(t)));
    console.log(`${better(r, ref[id], id) ? '✅' : '  '} ${id.padEnd(5)} sans les entrées 9 h 30–10 h les jours d’annonce de 8 h 30 et 13 h 30–15 h les jours de Fed : ${fmt(r)}`);
  }
  // Ensemble des idées retenues
  for (const id of ['ftmo', 'lucid']) {
    if (added[id].length < 2) continue;
    const r = evaluate(id, [...accts[id].list, ...added[id].flatMap((c) => withRisk(id, c))]);
    console.log(`\n${id} + toutes les idées retenues (${added[id].map((c) => c.name).join(', ')}) : ${fmt(r)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
