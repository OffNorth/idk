#!/usr/bin/env node
/**
 * 2e recherche « séances » : NOUVELLES familles de stratégies sur l'or et le Nasdaq 100 pour les séances de New York
 * et d'Asie (la 1re recherche, `npm run sessions`, a testé les cassures d'ouverture, le fixing, la nuit…).
 *   Or (comptant réel 5 min 2009–2026) : cassure du plus haut / plus bas de la veille pendant New York ; passage
 *     Londres → New York (sens de la matinée à l'ouverture de New York) ; sens de la séance de New York → nuit
 *     asiatique ; écart d'ouverture du lundi (Asie) comblé.
 *   Nasdaq New York (QQQ 1 min → 5 min, avec pré-ouverture, nov. 2024 → nov. 2026) : cassure du range de
 *     pré-ouverture ; écart d'ouverture comblé ; cassure du range du midi ; dernière heure ; plus haut / plus bas de
 *     la veille ; range de la 1re heure.
 *   Nasdaq Asie (future NQ=F 1 h, 2 ans) : sens de la nuit asiatique → séance de New York ; dérive de nuit ; cassure
 *     du début de la nuit asiatique.
 * Sélection : positive sur les 3 tranches (or : 2009–14 / 2015–20 / 2021–26 ; Nasdaq : 3 × 8 mois) avec assez de
 * trades, puis rejouée dans le challenge FTMO et l'évaluation Lucid avec les stratégies actuelles.
 *
 *   npm run sessions2
 */
const fs = require('fs');
const path = require('path');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const S = require('./src/sessions');
const { nyOffset } = require('./src/scalp2');

const { breakout, momentum, hm } = S;
const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;

/** Fuseau « nuit de New York » : heure de New York + 6 h (la journée commence à 18 h NY, réouverture des futures). */
function withNyx(x) {
  S.withTz(x);
  if (x.tz.nyx) return x;
  const n = x.candles.length;
  const min = new Array(n); const day = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = x.candles[i].t;
    const l = t - nyOffset(t) * 60 + 6 * 3600;
    min[i] = Math.floor((l % 86400) / 60); day[i] = Math.floor(l / 86400);
  }
  x.tz.nyx = { min, day };
  return x;
}
const wk = (x, i) => { const d = new Date(x.candles[i].t * 1000).getUTCDay(); return d >= 1 && d <= 5; };
const base = (id, name, market, evaluate) => ({ id, name, tf: '5m', scalp: true, warmup: 300, markets: [market], compute: S.compute, evaluate: (x, i) => evaluate(withNyx(x), i) });
const flat = (exit) => ({ entry: null, exitLong: exit, exitShort: exit, sl: 0, tp: null });

/** Cassure du plus haut / plus bas de la séance précédente [s, e) (minutes locales du fuseau). */
function levelBreak({ id, name, market, tz, s, e, entryStart, entryEnd, exitAt, stopAtr = 2 }) {
  return base(id, name, market, (x, i) => {
    const k = `lb:${tz}:${s}:${e}`;
    if (!x.cache[k]) {
      const { min, day } = x.tz[tz];
      const n = x.candles.length;
      const ph = new Array(n).fill(null); const pl = new Array(n).fill(null);
      let dd = null; let h = -Infinity; let l = Infinity; let H = null; let L = null;
      for (let j = 0; j < n; j++) {
        if (day[j] !== dd) { if (dd !== null && h > -Infinity) { H = h; L = l; } dd = day[j]; h = -Infinity; l = Infinity; }
        if (min[j] >= s && min[j] < e) { h = Math.max(h, x.candles[j].h); l = Math.min(l, x.candles[j].l); }
        ph[j] = H; pl[j] = L;
      }
      x.cache[k] = { ph, pl };
    }
    const { ph, pl } = x.cache[k];
    const m = x.tz[tz].min[i];
    const out = flat(!wk(x, i) || m >= exitAt || m < entryStart);
    if (out.exitLong) return out;
    const cl = x.closes;
    const up = S.firstOfDay(x, tz, `${id}u`, (j) => ph[j] !== null && cl[j] > ph[j] && x.tz[tz].min[j] >= entryStart && x.tz[tz].min[j] < entryEnd);
    const dn = S.firstOfDay(x, tz, `${id}d`, (j) => pl[j] !== null && cl[j] < pl[j] && x.tz[tz].min[j] >= entryStart && x.tz[tz].min[j] < entryEnd);
    if (up[i]) return { ...out, entry: 'long', sl: stopAtr * x.atr[i] };
    if (dn[i]) return { ...out, entry: 'short', sl: stopAtr * x.atr[i] };
    return out;
  });
}

/**
 * Mouvement mesuré entre refMin et measureMin (fuseau tz, peut enjamber minuit avec « nyx »), entrée à entryMin
 * (suivre / contrer si |mouvement| > th %), sortie à exitMin ; stop k ATR.
 */
function crossMove({ id, name, market, tz, refMin, measureMin, entryMin, exitMin, th, mode = 'follow', stopAtr = 2 }) {
  return base(id, name, market, (x, i) => {
    const k = `cm:${tz}:${refMin}:${measureMin}`;
    const bm = x.barMin;
    if (!x.cache[k]) {
      const { min } = x.tz[tz];
      const n = x.candles.length;
      const r = new Array(n).fill(null);
      let ref = null; let last = null;
      for (let j = 0; j < n; j++) {
        if (min[j] + bm === refMin || (refMin === 0 && min[j] + bm === 1440)) ref = x.closes[j];
        if (min[j] + bm === measureMin && ref) { last = (x.closes[j] / ref - 1) * 100; ref = null; }
        r[j] = last;
      }
      x.cache[k] = r;
    }
    const m = x.tz[tz].min[i];
    const inWin = entryMin < exitMin ? m + bm >= entryMin && m < exitMin : m + bm >= entryMin || m < exitMin;
    const out = flat(!inWin);
    if (out.exitLong) return out;
    if (m + bm !== entryMin) return out;
    const r = x.cache[k][i];
    if (r === null || Math.abs(r) <= th) return out;
    const side = (mode === 'follow') === (r > 0) ? 'long' : 'short';
    return { ...out, entry: side, sl: stopAtr * x.atr[i] };
  });
}

/** Écart d'ouverture comblé : ouverture (openMin) vs clôture précédente (closeMin) > th % → contrer, objectif = l'écart. */
function gapFade({ id, name, market, tz, closeMin, openMin, exitAt, th, stopMul = 1 }) {
  return base(id, name, market, (x, i) => {
    const k = `gf:${tz}:${closeMin}:${openMin}`;
    const bm = x.barMin;
    if (!x.cache[k]) {
      const { min } = x.tz[tz];
      const n = x.candles.length;
      const g = new Array(n).fill(null);
      let pc = null;
      for (let j = 0; j < n; j++) {
        if (min[j] + bm === closeMin) pc = x.closes[j];
        g[j] = min[j] === openMin && pc ? { gap: x.candles[j].o / pc - 1, pc } : null;
      }
      x.cache[k] = g;
    }
    const m = x.tz[tz].min[i];
    const out = flat(!wk(x, i) || m >= exitAt || m < openMin);
    if (out.exitLong) return out;
    const g = x.cache[k][i];
    if (!g || Math.abs(g.gap) * 100 <= th) return out;
    const dist = Math.abs(x.closes[i] - g.pc);
    if (!(dist > 0)) return out;
    return { ...out, entry: g.gap > 0 ? 'short' : 'long', sl: dist * stopMul, tp: dist };
  });
}

/** Dérive de nuit : achat à inMin, revente à outMin (fuseau tz, lundi → jeudi à l'achat). */
function drift({ id, name, market, tz, inMin, outMin, stopAtr = 4 }) {
  return base(id, name, market, (x, i) => {
    const m = x.tz[tz].min[i];
    const bm = x.barMin;
    const exit = outMin < inMin ? m >= outMin && m < inMin : m >= outMin || m < inMin;
    const d = new Date((x.candles[i].t - nyOffset(x.candles[i].t) * 60) * 1000).getUTCDay();
    const entry = (m + bm) % 1440 === inMin % 1440 && d >= 1 && d <= 4 ? 'long' : null;
    return { entry, exitLong: exit, exitShort: true, sl: stopAtr * x.atr[i], tp: null };
  });
}

function goldCandidates() {
  const C = [];
  for (const [ws, we] of [[hm(8, 20), hm(12)], [hm(9, 30), hm(11)]]) for (const stopAtr of [1.5, 3]) {
    C.push(levelBreak({ id: `gx_pdl_${ws / 60 | 0}_${stopAtr}`, name: `Or : cassure du plus haut / plus bas de la veille pendant New York (${Math.floor(ws / 60)} h ${String(ws % 60).padStart(2, '0')} → ${we / 60} h NY), sortie 16 h 55, stop ${stopAtr} ATR`, market: 'gold', tz: 'nyx', s: 0, e: hm(23), entryStart: ws + 360, entryEnd: we + 360, exitAt: hm(16, 55) + 360, stopAtr }));
  }
  for (const th of [0.3, 0.6]) for (const mode of ['follow', 'fade']) {
    C.push(crossMove({ id: `gx_lonny_${th}_${mode}`, name: `Or : sens de la matinée de Londres (3 h → 9 h 30 NY) > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} de l'ouverture de NY à 16 h 55`, market: 'gold', tz: 'ny', refMin: hm(3), measureMin: hm(9, 30), entryMin: hm(9, 35), exitMin: hm(16, 55), th, mode }));
  }
  for (const th of [0.3, 0.6]) for (const mode of ['follow', 'fade']) for (const exitMin of [hm(2, 55), hm(6, 55)]) {
    C.push(crossMove({ id: `gx_nyasia_${th}_${mode}_${exitMin / 60 | 0}`, name: `Or : sens de la séance de New York (9 h 30 → 16 h 55) > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} pendant la nuit asiatique (18 h 05 → ${Math.floor(exitMin / 60)} h 55 NY)`, market: 'gold', tz: 'ny', refMin: hm(9, 30), measureMin: hm(16, 55), entryMin: hm(18, 5), exitMin, th, mode }));
  }
  for (const th of [0.2, 0.5]) {
    C.push(gapFade({ id: `gx_mongap_${th}`, name: `Or : écart d'ouverture du lundi (Asie, 18 h NY dimanche) > ${th} % → comblé avant 3 h NY`, market: 'gold', tz: 'ny', closeMin: hm(16, 55), openMin: hm(18), exitAt: hm(23, 55), th }));
  }
  return C;
}

function nasCandidates() {
  const C = [];
  for (const end of [hm(10, 30), hm(11, 30)]) {
    C.push(breakout({ id: `nx_pre_${end / 60 | 0}`, name: `Nasdaq : cassure du range de pré-ouverture (4 h → 9 h 30 NY) avant ${Math.floor(end / 60)} h ${end % 60 || ''}, sortie 15 h 55`, tz: 'ny', start: hm(4), len: hm(5, 30), entryEnd: end, exitAt: hm(15, 55), stopAtr: 2 }));
  }
  for (const th of [0.3, 0.6]) for (const exitAt of [hm(12), hm(15, 55)]) {
    C.push(gapFade({ id: `nx_gap_${th}_${exitAt / 60 | 0}`, name: `Nasdaq : écart d'ouverture > ${th} % comblé (objectif : clôture de la veille), sortie ${Math.floor(exitAt / 60)} h`, market: 'nas100', tz: 'ny', closeMin: hm(16), openMin: hm(9, 30), exitAt, th }));
  }
  for (const stopAtr of [0, 2]) {
    C.push(breakout({ id: `nx_lunch_${stopAtr}`, name: `Nasdaq : cassure du range du midi (12 h → 13 h 30 NY), sortie 15 h 55${stopAtr ? `, stop ≤ ${stopAtr} ATR` : ''}`, tz: 'ny', start: hm(12), len: 90, entryEnd: hm(15), exitAt: hm(15, 55), stopAtr }));
    C.push(breakout({ id: `nx_or60_${stopAtr}`, name: `Nasdaq : cassure du range de la 1re heure (9 h 30 → 10 h 30) l'après-midi, sortie 15 h 55${stopAtr ? `, stop ≤ ${stopAtr} ATR` : ''}`, tz: 'ny', start: hm(9, 30), len: 60, entryEnd: hm(15), exitAt: hm(15, 55), stopAtr }));
  }
  for (const th of [0.5, 1]) for (const mode of ['follow', 'fade']) {
    C.push(momentum({ id: `nx_power_${th}_${mode}`, name: `Nasdaq : dernière heure (15 h), mouvement depuis l'ouverture > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} jusqu'à 15 h 55`, tz: 'ny', ref: hm(9, 35), at: hm(15), exitAt: hm(15, 55), th, mode }));
  }
  for (const stopAtr of [1.5, 3]) {
    C.push(levelBreak({ id: `nx_pdl_${stopAtr}`, name: `Nasdaq : cassure du plus haut / plus bas de la veille (9 h 35 → 12 h), sortie 15 h 55, stop ${stopAtr} ATR`, market: 'nas100', tz: 'ny', s: hm(9, 30), e: hm(16), entryStart: hm(9, 35), entryEnd: hm(12), exitAt: hm(15, 55), stopAtr }));
  }
  return C;
}

function nqAsiaCandidates() {
  const C = [];
  for (const th of [0.3, 0.6]) for (const mode of ['follow', 'fade']) {
    C.push(crossMove({ id: `qa_asia_ny_${th}_${mode}`, name: `Nasdaq (NQ 1 h) : sens de la nuit asiatique (18 h → 9 h NY) > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} de 10 h à 16 h`, market: 'nas100', tz: 'nyx', refMin: 0, measureMin: hm(15), entryMin: hm(16), exitMin: hm(22), th, mode }));
  }
  for (const [inMin, outMin, lbl] of [[hm(1), hm(15, 0), '19 h → 9 h NY'], [hm(0), hm(9), '18 h → 3 h NY (nuit asiatique seule)']]) {
    C.push(drift({ id: `qa_drift_${inMin / 60}_${outMin / 60}`, name: `Nasdaq (NQ 1 h) : dérive de nuit, achat → revente (${lbl})`, market: 'nas100', tz: 'nyx', inMin, outMin }));
  }
  for (const stopAtr of [0, 2]) {
    C.push(breakout({ id: `qa_asiabrk_${stopAtr}`, name: `Nasdaq (NQ 1 h) : cassure du début de nuit (18 h → 20 h NY) jusqu'à 3 h NY${stopAtr ? `, stop ≤ ${stopAtr} ATR` : ''}`, tz: 'nyx', start: 0, len: 120, entryEnd: hm(7), exitAt: hm(9), stopAtr }));
  }
  return C;
}

function evaluate(C, candles, slices, { fee, fin, barSec, minTrades }) {
  const rows = [];
  for (const s of C) {
    s.compute = S.compute;
    const r = backtest(s, candles, { size: 1000, feePct: fee, financingPct: fin, barSec, market: s.markets?.[0] || 'gold', ind: S.compute(candles) });
    const sl = slices.map(([a, b]) => r.list.filter((t) => t.entryT >= a && t.entryT < b));
    const sum = (l) => l.reduce((a, t) => a + t.pnlPct, 0);
    const R = (t) => t.pnlPct / Math.max(1e-9, (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100);
    const row = { s, list: r.list, g: sl.map(sum), n: sl.map((l) => l.length), win: r.list.length ? (r.list.filter((t) => t.pnlPct > 0).length / r.list.length) * 100 : 0, avgR: r.list.length ? r.list.reduce((a, t) => a + R(t), 0) / r.list.length : 0 };
    row.ok = row.g.every((v) => v > 0) && row.n.every((v) => v >= minTrades);
    rows.push(row);
  }
  rows.sort((a, b) => Math.min(...b.g) - Math.min(...a.g));
  for (const r of rows) console.log(`${r.ok ? '✅' : '  '} ${r.s.id.padEnd(22)} ${r.g.map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`.padStart(9)).join(' |')} · ${String(r.list.length).padStart(5)} trades · ${r.win.toFixed(0)} % · ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)} R  ${r.s.name}`);
  return rows;
}

(async () => {
  const kept = [];
  // ---- Or
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  console.log('=== Or (comptant réel 5 min 2009–2026) · tranches 2009–14 | 2015–20 | 2021–26 · frais 0,005 % ===');
  const gr = evaluate(goldCandidates(), g5, [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]], { fee: 0.005, fin: 0, barSec: 300, minTrades: 50 });
  kept.push(...gr.filter((r) => r.ok).map((r) => ({ ...r, market: 'gold', mult: 10, cfee: 3.5 })));
  // ---- Nasdaq New York (QQQ 5 min avec pré-ouverture)
  const q5 = aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60);
  const a0 = q5[0].t + 30 * 86400; const a1 = q5[q5.length - 1].t; const third = (a1 - a0) / 3;
  const nasSlices = [[a0, a0 + third], [a0 + third, a0 + 2 * third], [a0 + 2 * third, Infinity]];
  console.log('\n=== Nasdaq New York (QQQ 5 min, pré-ouverture comprise, nov. 2024 → nov. 2026) · 3 tranches de 8 mois · frais 0,003 % + financement ===');
  const nr = evaluate(nasCandidates().map((s) => ({ ...s, markets: ['nas100'] })), q5, nasSlices, { fee: 0.003, fin: 6, barSec: 300, minTrades: 20 });
  kept.push(...nr.filter((r) => r.ok).map((r) => ({ ...r, market: 'nas100', mult: 82, cfee: 2.5 })));
  // ---- Nasdaq Asie (NQ=F 1 h, 2 ans)
  const nq = JSON.parse(fs.readFileSync(path.join(CACHE, 'yahoo-NQ_F-1h-730d.json'), 'utf8'));
  const b0 = nq[0].t + 30 * 86400; const b1 = nq[nq.length - 1].t; const tq = (b1 - b0) / 3;
  console.log(`\n=== Nasdaq Asie (future NQ=F 1 h, ${new Date(nq[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(b1 * 1000).toISOString().slice(0, 10)}) · 3 tranches · frais 0,003 % + financement ===`);
  const qr = evaluate(nqAsiaCandidates().map((s) => ({ ...s, tf: '1h', markets: ['nas100'] })), nq, [[b0, b0 + tq], [b0 + tq, b0 + 2 * tq], [b0 + 2 * tq, Infinity]], { fee: 0.003, fin: 6, barSec: 3600, minTrades: 20 });
  kept.push(...qr.filter((r) => r.ok).map((r) => ({ ...r, market: 'nas100', mult: 2, cfee: 2.5 })));
  console.log(`\n${kept.length} variante(s) positive(s) sur les 3 tranches.`);
  if (!kept.length) return;

  // ---- Challenges FTMO / Lucid
  const cfg = require('./src/config');
  const { challengeStats, cmeDay } = require('./src/ftmo');
  const { RULES } = require('./src/sizing');
  const { buildTrades } = require('./src/ftmoTrades');
  const { programOf } = require('./src/ftmoAccount');
  const { all, q5: qq } = await buildTrades(cfg, CACHE);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const F = programOf(cfg);
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')] };
  if (qq) P.A = [qq[0].t + 30 * 86400, Infinity, () => true];
  const lucidRisk = (t) => (t.intraday ? ((cfg.lucidIntradayStrategies || []).includes(t.sid) || (t.extra && t.market === 'nas100') ? cfg.lucidIntradayRisk : 0) : cfg.ftmoRisk * cfg.lucidRiskMul);
  const RS = {
    FTMO: { R: { steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, dayStopPct: cfg.ftmoDayStop }, risk: (t) => t.riskPct },
    Lucid: { R: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency ?? 40, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop }, risk: lucidRisk },
  };
  const run = (extra) => Object.entries(RS).map(([name, R]) => `${name} ${Object.entries(P).map(([k, [a, b, f]]) => {
    const list = [...all, ...extra].filter((t) => t.entryT >= a && t.entryT < b && f(t)).map((t) => ({ ...t, riskPct: R.risk(t) })).filter((t) => t.riskPct > 0);
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...R.R });
    return `${k} ${c.passRate.toFixed(0)} %`;
  }).join(' | ')}`).join('  ·  ');
  console.log('\n=== Challenges (réussite < 1 an : 2009–19 | 2020–26 | nov. 24–26) ; Nasdaq intraday seulement dans la dernière période ===');
  console.log(`actuel                   ${run([])}`);
  for (const r of kept) {
    const extra = r.list.map((t) => ({ ...t, sid: `${r.market}:${r.s.id}`, market: r.market, intraday: true, extra: true, riskPct: cfg.ftmoIntradayRisk, contractUsd: t.entry * r.mult, contractFee: r.cfee }));
    console.log(`+ ${r.s.id.padEnd(22)} ${run(extra)}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
