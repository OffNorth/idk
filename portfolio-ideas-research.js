#!/usr/bin/env node
/**
 * Portefeuille perso + nouvelles poches (npm run portfolio-ideas) : le rebond après panique (Connors « VIX stretch »)
 * et le mardi de retournement, sur le S&P 500 (SPY) et le Nasdaq 100 (QQQ), comme poches du bot (investies dans l'ETF
 * pendant le trade, en liquidités SHY sinon). Comparé au portefeuille actuel (50 % monde, 10 % or, 40 % pour
 * 5 stratégies du bot) sur déc. 2004 → nov. 2026, en euros, frais 0,1 %, rééquilibrage mensuel.
 */
const path = require('path');
const { fetchYahoo, cachedYahoo } = require('./src/yahoo');
const { selectStrategies } = require('./src/strategies');
const { backtest } = require('./src/gold');
const { computeAll } = require('./src/indicators');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;
const START = Date.UTC(2004, 11, 1) / 1000;
const COST = 0.001;

(async () => {
  const get = (s) => cachedYahoo(CACHE, s, '1d', { period1: 0, adjusted: true }, 72).then((d) => d.filter((k) => k.c > 0));
  const SYM = ['SPY', 'EFA', 'QQQ', 'GLD', 'IEF', 'TLT', 'SHY'];
  const raw = {};
  for (const s of SYM) raw[s] = await get(s);
  const fx = (await cachedYahoo(CACHE, 'EURUSD=X', '1d', { period1: 0 }, 72)).filter((k) => k.c > 0);
  const vix = (await cachedYahoo(CACHE, '^VIX', '1d', {}, 72)).filter((k) => k.c > 0);
  // Calendrier : jours de bourse du SPY depuis START ; cours reportés (ffill) pour les autres
  const days = raw.SPY.filter((k) => k.t >= START).map((k) => k.t);
  const series = (arr) => { const m = new Map(arr.map((k) => [k.t, k.c])); let last = null; return days.map((t) => (m.has(t) ? (last = m.get(t)) : last)); };
  const P = Object.fromEntries(SYM.map((s) => [s, series(raw[s])]));
  const FX = series(fx);
  // Rendements journaliers des « actifs », dont les poches gérées par le bot (courbe de capital, liquidités = SHY)
  const ret = (p) => p.map((v, i) => (i && p[i - 1] && v ? v / p[i - 1] - 1 : 0));
  const R = Object.fromEntries(SYM.map((s) => [s, ret(P[s])]));
  R.WORLD = R.SPY.map((r, i) => 0.6 * r + 0.4 * R.EFA[i]);
  const botCurve = (sym, id) => {
    const d = raw[sym];
    const s = selectStrategies([id])[0];
    const ind = computeAll(d, d, 86400, null, vix, {});
    const out = backtest(s, d, { size: 1000, capital: 1000, compound: true, positionPct: 100, feePct: COST * 100 / 2, barSec: 86400, ind, daily: d, vix, curveEvery: 1 });
    // État (en position ou non) jour par jour → rendement de l'actif quand investi, de SHY sinon
    const inPos = new Map();
    for (const tr of out.list) for (let t = tr.entryT; t < tr.exitT; t += DAY) inPos.set(t, true);
    const pa = P[sym];
    return days.map((t, i) => (i === 0 ? 0 : inPos.get(days[i - 1]) ? pa[i] / pa[i - 1] - 1 : R.SHY[i]));
  };
  const BOT = {
    'SPY rsi2': botCurve('SPY', 'rsi2'), 'SPY double7': botCurve('SPY', 'double7'),
    'QQQ golden': botCurve('QQQ', 'golden'), 'GLD trendmix': botCurve('GLD', 'trendmix'), 'GLD season': botCurve('GLD', 'season'),
  };
  R.BOT = days.map((_, i) => Object.values(BOT).reduce((a, r) => a + r[i], 0) / Object.keys(BOT).length);


  // Nouvelles poches : jours en position → rendement de l'ETF, sinon SHY
  const sleeve = (sym, inPos) => { const pa = P[sym]; return days.map((t, i) => (i === 0 ? 0 : inPos[i - 1] ? pa[i] / pa[i - 1] - 1 : R.SHY[i])); };
  const sma = (a, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
  const vixMap = new Map(vix.map((k) => [k.t, k.c]));
  const VX = days.map((t) => vixMap.get(t) ?? null);
  const rsi2 = (c) => { const out = [null]; let up = 0, dn = 0; for (let i = 1; i < c.length; i++) { const ch = c[i] - c[i - 1]; up = (up + Math.max(ch, 0)) / 2; dn = (dn + Math.max(-ch, 0)) / 2; out.push(dn === 0 ? 100 : 100 - 100 / (1 + up / dn)); } return out; };
  const vixStretch = (sym) => {
    const c = P[sym]; const r2 = rsi2(c); const pos = new Array(days.length).fill(false);
    for (let i = 210; i < days.length; i++) {
      let ok = c[i] > sma(c, 200, i);
      for (let k = 0; k < 3 && ok; k++) { const j = i - k; const w = VX.slice(j - 9, j + 1); if (w.some((x) => x == null)) { ok = false; break; } ok = VX[j] >= 1.05 * (w.reduce((a, b) => a + b, 0) / 10); }
      if (!ok) continue;
      let j = i; for (; j < Math.min(days.length - 1, i + 10); j++) { pos[j] = true; if (j > i && r2[j] > 65) break; }
      i = j;
    }
    return sleeve(sym, pos);
  };
  const turnTue = (sym) => {
    const c = P[sym]; const pos = new Array(days.length).fill(false);
    for (let i = 1; i < days.length - 1; i++) if (new Date(days[i] * 1000).getUTCDay() === 1 && c[i] < c[i - 1] * 0.99) pos[i] = true; // lundi en baisse > 1 % : tenu jusqu'au mardi
    return sleeve(sym, pos);
  };
  const NEW = { 'VIX stretch SPY': vixStretch('SPY'), 'VIX stretch QQQ': vixStretch('QQQ'), 'Mardi SPY': turnTue('SPY'), 'Mardi QQQ': turnTue('QQQ') };
  const avg = (curves) => days.map((_, i) => curves.reduce((a, r) => a + r[i], 0) / curves.length);
  R.BOT5 = avg(Object.values(BOT));
  R.BOT7 = avg([...Object.values(BOT), NEW['VIX stretch SPY'], NEW['Mardi SPY']]);
  R.BOT9 = avg([...Object.values(BOT), ...Object.values(NEW)]);
  const monthEnd = days.map((t, i) => i === days.length - 1 || new Date(days[i + 1] * 1000).getUTCMonth() !== new Date(t * 1000).getUTCMonth());
  const run = (W) => {
    let v = 1, w = { ...W }; const vals = [1]; let dca = 0;
    for (let i = 1; i < days.length; i++) {
      const fxr = FX[i - 1] && FX[i] ? FX[i - 1] / FX[i] - 1 : 0;
      const g = Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x * (1 + R[k][i])])); const tot = Object.values(g).reduce((a, x) => a + x, 0);
      v *= tot * (1 + fxr); dca *= tot * (1 + fxr); w = Object.fromEntries(Object.entries(g).map(([k, x]) => [k, x / tot]));
      if (monthEnd[i]) { const turn = Object.keys(W).reduce((a, k) => a + Math.abs(W[k] - w[k]), 0); v *= 1 - (COST * turn) / 2; dca *= 1 - (COST * turn) / 2; w = { ...W }; dca += 300; }
      vals.push(v);
    }
    const yrs = (days[days.length - 1] - days[0]) / (365.25 * DAY);
    let pk = 0, dd = 0; for (const x of vals) { pk = Math.max(pk, x); dd = Math.min(dd, x / pk - 1); }
    const by = new Map(); days.forEach((t, i) => by.set(new Date(t * 1000).getUTCFullYear(), i)); let prev = 0; const yr = [];
    for (const [, i] of by) { yr.push(vals[i] / vals[prev] - 1); prev = i; }
    const half = days.findIndex((t) => t >= Date.UTC(2016, 0, 1) / 1000);
    const c1 = (vals[half] / vals[0]) ** (1 / ((days[half] - days[0]) / (365.25 * DAY))) - 1;
    const c2 = (v / vals[half]) ** (1 / ((days[days.length - 1] - days[half]) / (365.25 * DAY))) - 1;
    return { cagr: v ** (1 / yrs) - 1, dd, worst: Math.min(...yr.slice(1)), c1, c2, dca };
  };
  const pc = (x, d = 1) => `${(x * 100).toFixed(d)} %`;
  console.log('Poches seules (en €, ETF pendant le trade, liquidités sinon) :');
  for (const [k, r] of Object.entries(NEW)) { R.TMP = r; const inPos = r.filter((x, i) => i && x !== R.SHY[i]).length; const e = run({ TMP: 1 }); console.log(`  ${k.padEnd(16)} ${pc(e.cagr)} /an · pire baisse ${pc(e.dd, 0)} · 2005–15 ${pc(e.c1)} / 2016–26 ${pc(e.c2)} · investie ${Math.round((inPos / days.length) * 100)} % du temps`); }
  console.log('\\nPortefeuille (en €) : par an · pire baisse · pire année · 2005–15 / 2016–26 · 300 €/mois depuis 2005');
  for (const [name, W] of [['Actuel : 50 % monde, 10 % or, 40 % bot (5 poches)', { WORLD: 0.5, GLD: 0.1, BOT5: 0.4 }],
    ['+ VIX stretch et mardi sur SPY (7 poches)', { WORLD: 0.5, GLD: 0.1, BOT7: 0.4 }],
    ['+ les 4 nouvelles poches (9 poches)', { WORLD: 0.5, GLD: 0.1, BOT9: 0.4 }],
    ['Bot seul, 5 poches', { BOT5: 1 }], ['Bot seul, 7 poches', { BOT7: 1 }], ['Bot seul, 9 poches', { BOT9: 1 }]]) {
    const e = run(W);
    console.log(`  ${name.padEnd(50)} ${pc(e.cagr)} · ${pc(e.dd, 0)} · ${pc(e.worst, 0)} · ${pc(e.c1)} / ${pc(e.c2)} · ${Math.round(e.dca).toLocaleString('fr-FR')} €`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
