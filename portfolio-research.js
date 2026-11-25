#!/usr/bin/env node
/**
 * Portefeuille perso (npm run portfolio) : quel portefeuille pour son propre argent, sans prop firm, sur le long terme ?
 * ETF réels, cours ajustés des dividendes (Yahoo), décembre 2004 → aujourd'hui (≈ 22 ans : krachs 2008, 2020, 2022),
 * sans levier, frais 0,1 % du montant échangé, rééquilibrage mensuel, résultats en euros (investisseur français : le
 * cours EUR/USD est appliqué) et en dollars.
 *   ETF : SPY (S&P 500), EFA (actions hors USA ; 60 % SPY + 40 % EFA ≈ « monde »), QQQ (Nasdaq 100), GLD (or),
 *   IEF (obligations US 7–10 ans), TLT (20 ans et +), SHY (1–3 ans ≈ liquidités).
 * Portefeuilles : achat-conservation (S&P, monde, Nasdaq), 60/40, monde + or, permanent (Browne), tendance 10 mois
 * (Faber, sur le monde et sur 4 actifs), double momentum (Antonacci), et « cœur + bot » : monde + or + une poche gérée par
 * des stratégies journalières du bot (RSI 2 et Double 7 sur le S&P, tendance sur le Nasdaq et l'or), liquidités sinon.
 * Mesures : rendement par an (€ et $), volatilité, pire baisse, pire année, années positives, 2005–15 vs 2016–26, et
 * 300 € investis chaque mois depuis 2005 (valeur aujourd'hui).
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

  // Signaux de fin de mois
  const monthEnd = days.map((t, i) => i === days.length - 1 || new Date(days[i + 1] * 1000).getUTCMonth() !== new Date(t * 1000).getUTCMonth());
  const sma = (p, n, i) => { if (i < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += p[k]; return s / n; };
  const idx = (r) => { const v = [1]; for (let i = 1; i < r.length; i++) v.push(v[i - 1] * (1 + r[i])); return v; };
  const IDX = { WORLD: idx(R.WORLD), SPY: P.SPY, EFA: P.EFA, GLD: P.GLD, TLT: P.TLT, SHY: P.SHY, IEF: P.IEF };
  const above = (a, i) => { const m = sma(IDX[a], 210, i); return m !== null && IDX[a][i] > m; };
  const mom = (a, i) => (i >= 252 ? IDX[a][i] / IDX[a][i - 252] - 1 : null);

  // Portefeuilles : fonction (i) → poids cibles (décidés en fin de mois)
  const fixed = (w) => () => w;
  const PORT = {
    'S&P 500 seul': fixed({ SPY: 1 }),
    'Monde (60 % S&P + 40 % hors USA)': fixed({ WORLD: 1 }),
    'Nasdaq 100 seul': fixed({ QQQ: 1 }),
    '60 / 40 (monde / obligations)': fixed({ WORLD: 0.6, IEF: 0.4 }),
    'Monde 80 % + or 20 %': fixed({ WORLD: 0.8, GLD: 0.2 }),
    'Permanent (actions, long terme, or, liquidités)': fixed({ SPY: 0.25, TLT: 0.25, GLD: 0.25, SHY: 0.25 }),
    'Tendance 10 mois sur le monde': (i) => (above('WORLD', i) ? { WORLD: 1 } : { IEF: 1 }),
    'Tendance 10 mois, 4 actifs': (i) => ['SPY', 'EFA', 'GLD', 'TLT'].reduce((o, a) => { const k = above(a, i) ? a : 'SHY'; o[k] = (o[k] || 0) + 0.25; return o; }, {}),
    'Double momentum (Antonacci)': (i) => { const s = mom('SPY', i); const e = mom('EFA', i); const c = mom('SHY', i); if (s === null) return { WORLD: 1 }; return s > c ? (s >= e ? { SPY: 1 } : { EFA: 1 }) : { IEF: 1 }; },
    'Cœur + bot (70 % monde, 10 % or, 20 % bot)': fixed({ WORLD: 0.7, GLD: 0.1, BOT: 0.2 }),
    'Cœur + bot (50 % monde, 10 % or, 40 % bot)': fixed({ WORLD: 0.5, GLD: 0.1, BOT: 0.4 }),
    'Bot seul (5 stratégies journalières)': fixed({ BOT: 1 }),
  };
  const run = (fn, eur) => {
    let v = 1; let w = fn(0); const vals = [1];
    let dca = 0; let invested = 0;
    for (let i = 1; i < days.length; i++) {
      const fxr = eur && FX[i - 1] && FX[i] ? FX[i - 1] / FX[i] - 1 : 0; // USD → EUR
      const r = Object.entries(w).reduce((a, [k, x]) => a + x * R[k][i], 0);
      const rr = (1 + r) * (1 + fxr) - 1;
      v *= 1 + rr; dca *= 1 + rr;
      if (monthEnd[i]) {
        const nw = fn(i);
        const turn = [...new Set([...Object.keys(w), ...Object.keys(nw)])].reduce((a, k) => a + Math.abs((nw[k] || 0) - (w[k] || 0)), 0);
        v *= 1 - COST * turn / 2; dca *= 1 - COST * turn / 2;
        w = nw; dca += 300; invested += 300;
      }
      vals.push(v);
    }
    const yrs = (days[days.length - 1] - days[0]) / (365.25 * DAY);
    const cagr = v ** (1 / yrs) - 1;
    let peak = 0; let dd = 0; for (const x of vals) { peak = Math.max(peak, x); dd = Math.min(dd, x / peak - 1); }
    const dr = vals.map((x, i) => (i ? x / vals[i - 1] - 1 : 0));
    const vol = Math.sqrt(dr.reduce((a, x) => a + x * x, 0) / dr.length) * Math.sqrt(252);
    const byYear = new Map(); days.forEach((t, i) => byYear.set(new Date(t * 1000).getUTCFullYear(), i));
    let prev = 0; const yr = [];
    for (const [y, i] of [...byYear]) { yr.push([y, vals[i] / vals[prev] - 1]); prev = i; }
    const half = days.findIndex((t) => t >= Date.UTC(2016, 0, 1) / 1000);
    const c1 = (vals[half] / vals[0]) ** (1 / ((days[half] - days[0]) / (365.25 * DAY))) - 1;
    const c2 = (v / vals[half]) ** (1 / ((days[days.length - 1] - days[half]) / (365.25 * DAY))) - 1;
    return { cagr, dd, vol, worst: Math.min(...yr.slice(1).map((x) => x[1])), pos: yr.slice(1).filter((x) => x[1] > 0).length / (yr.length - 1), c1, c2, dca, invested };
  };
  const pc = (x, d = 1) => `${(x * 100).toFixed(d)} %`;
  console.log(`Portefeuille perso · ${new Date(days[0] * 1000).toISOString().slice(0, 10)} → ${new Date(days[days.length - 1] * 1000).toISOString().slice(0, 10)} · ETF dividendes inclus, sans levier, frais 0,1 %`);
  console.log(`${'portefeuille'.padEnd(46)} €/an    $/an   volat.  pire baisse  pire année  années +  2005–15 / 2016–26 (€)   300 €/mois → aujourd'hui`);
  for (const [name, fn] of Object.entries(PORT)) {
    const e = run(fn, true); const u = run(fn, false);
    console.log(`${name.padEnd(46)} ${pc(e.cagr).padStart(6)} ${pc(u.cagr).padStart(7)} ${pc(e.vol, 0).padStart(6)} ${pc(e.dd, 0).padStart(9)} ${pc(e.worst, 0).padStart(11)} ${pc(e.pos, 0).padStart(8)}   ${pc(e.c1).padStart(6)} / ${pc(e.c2).padStart(6)}        ${Math.round(e.dca).toLocaleString('fr-FR').padStart(9)} € (versé ${Math.round(e.invested).toLocaleString('fr-FR')} €)`);
  }
  console.log('\nPoches du bot (seules, € ) :');
  for (const [k, r] of Object.entries(BOT)) { R.TMP = r; const e = run(fixed({ TMP: 1 }), true); console.log(`  ${k.padEnd(14)} ${pc(e.cagr)} /an · pire baisse ${pc(e.dd, 0)} · 2005–15 ${pc(e.c1)} / 2016–26 ${pc(e.c2)}`); }
})().catch((e) => { console.error(e); process.exit(1); });
