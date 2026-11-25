#!/usr/bin/env node
/**
 * Order flow (npm run orderflow) : les stratégies d'order flow gagnent-elles de l'argent en automatique, après frais ?
 * Données gratuites seulement :
 *  1. Vrai order flow : bougies 1 min de Binance (futures USDT-M), avec le volume des acheteurs agresseurs (« taker buy ») :
 *     delta = achats agresseurs − ventes agresseuses, minute par minute. BTCUSDT et ETHUSDT, janv. 2020 → oct. 2026.
 *     (Pas de footprint par niveau de prix : seulement le delta par bougie, le delta cumulé et le volume.)
 *  2. Delta approximé sur les marchés de Lucid : QQQ (≈ Nasdaq / MNQ) et SPY (≈ S&P / MES), bougies 1 min Polygon
 *     (nov. 2024 → nov. 2026, séance 9 h 30 – 16 h New York). Delta estimé par la classification « bulk volume » (Easley,
 *     López de Prado, O'Hara) : part acheteuse = Φ(variation / écart-type des variations). Sa qualité est mesurée sur
 *     Binance, où l'on connaît le vrai delta.
 * Stratégies (signal à la clôture d'une bougie, entrée à l'ouverture de la suivante ; stop 1 ATR(14), objectif 1,5 R,
 * sortie au bout de 30 bougies sinon ; stop prioritaire si les deux sont touchés dans la même bougie) :
 *  - delta_mom    : delta de la bougie très fort (z > 2 sur 60 bougies) et bougie dans le même sens → suivre
 *  - absorption   : gros volume (> 2 × moyenne) + delta très vendeur (z < −2) mais clôture dans la moitié haute → acheter
 *                   (les vendeurs agressifs ont été absorbés) ; symétrique à la vente
 *  - cvd_div      : plus haut de 30 bougies sans plus haut du delta cumulé → vendre ; symétrique
 *  - exhaustion   : 3 bougies de delta fort dans le même sens puis bougie de sens contraire → contre-tendance
 *  Témoins « prix seul » (mêmes règles sans le delta) pour voir si le delta apporte quelque chose : body_mom, vol_rev.
 * Frais aller-retour : BTC / ETH 0,04 % (CFD FTMO, optimiste) et 0,10 % (prudent) ; QQQ / SPY 0,01 % (≈ MNQ / MES).
 * `npm run orderflow -- --gross` : mêmes tests sans frais. Mesures : trades, gagnants, R moyen net, facteur de profit, par période (stabilité), en 1 min et en 5 min.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE = path.join(__dirname, 'data', 'research');
// --gross : sans frais (le delta prédit-il quelque chose, avant tout coût ?)
const GROSS = process.argv.includes('--gross');
const C = (list) => (GROSS ? [0] : list);
const BIN = path.join(CACHE, 'binance-klines');
fs.mkdirSync(BIN, { recursive: true });

/* ---------- Données ---------- */
async function binanceMonth(sym, ym) {
  const csv = path.join(BIN, `${sym}-1m-${ym}.csv`);
  if (fs.existsSync(csv)) return fs.readFileSync(csv, 'utf8');
  const url = `https://data.binance.vision/data/futures/um/monthly/klines/${sym}/1m/${sym}-1m-${ym}.zip`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) return null;
  const zip = path.join(BIN, `${sym}-1m-${ym}.zip`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip, '-d', BIN]);
  fs.unlinkSync(zip);
  return fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8') : null;
}
async function binance(sym, from = [2020, 1], to = [2026, 10]) {
  const bars = [];
  for (let y = from[0], m = from[1]; y < to[0] || (y === to[0] && m <= to[1]); m === 12 ? (y++, m = 1) : m++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const txt = await binanceMonth(sym, ym);
    if (!txt) { console.warn(`  ${sym} ${ym} : indisponible`); continue; }
    for (const line of txt.split('\n')) {
      const f = line.split(',');
      if (f.length < 11 || !/^\d/.test(f[0])) continue; // en-tête éventuel
      const v = +f[5], tb = +f[9];
      bars.push({ t: Math.floor(+f[0] / 1000), o: +f[1], h: +f[2], l: +f[3], c: +f[4], v, d: 2 * tb - v });
    }
  }
  return bars;
}
function polygon1m(ticker) {
  const raw = JSON.parse(fs.readFileSync(path.join(CACHE, `polygon-${ticker}-1m-2024-11-18.json`), 'utf8'));
  // Séance régulière de New York seulement (9 h 30 – 16 h)
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  return raw.filter((k) => { const [h, mi] = fmt.format(new Date(k.t * 1000)).split(':').map(Number); const x = h * 60 + mi; return x >= 570 && x < 960; })
    .map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }));
}

/* ---------- Delta approximé (bulk volume classification) ---------- */
const PHI = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function bvc(bars, n = 100) {
  const out = new Array(bars.length).fill(0);
  let s = 0, s2 = 0; const q = [];
  for (let i = 1; i < bars.length; i++) {
    const dp = bars[i].c - bars[i - 1].c;
    q.push(dp); s += dp; s2 += dp * dp;
    if (q.length > n) { const x = q.shift(); s -= x; s2 -= x * x; }
    const sd = Math.sqrt(Math.max(1e-18, s2 / q.length - (s / q.length) ** 2));
    out[i] = bars[i].v * (2 * PHI(dp / sd) - 1);
  }
  return out;
}

/* ---------- Agrégation 5 min ---------- */
function agg(bars, min) {
  const out = []; let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / (min * 60)) * min * 60;
    if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, d: b.d }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; cur.d += b.d; }
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------- Signaux ---------- */
function signals(bars, delta) {
  const n = bars.length;
  const N = 60;
  // Moyennes / écarts glissants : delta normalisé par le volume, volume, corps
  const dn = delta.map((d, i) => d / Math.max(1e-9, bars[i].v));
  const roll = (arr) => { const m = new Float64Array(n), sd = new Float64Array(n); let s = 0, s2 = 0; for (let i = 0; i < n; i++) { s += arr[i]; s2 += arr[i] * arr[i]; if (i >= N) { s -= arr[i - N]; s2 -= arr[i - N] ** 2; } const k = Math.min(i + 1, N); m[i] = s / k; sd[i] = Math.sqrt(Math.max(1e-18, s2 / k - m[i] * m[i])); } return { m, sd }; };
  const D = roll(dn); const V = roll(bars.map((b) => b.v)); const body = bars.map((b) => b.c - b.o); const B = roll(body);
  const atr = new Float64Array(n); let a = 0;
  for (let i = 1; i < n; i++) { const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); a = i < 15 ? (a * (i - 1) + tr) / i : (a * 13 + tr) / 14; atr[i] = a; }
  const cvd = new Float64Array(n); for (let i = 1; i < n; i++) cvd[i] = cvd[i - 1] + delta[i];
  const S = { delta_mom: [], absorption: [], cvd_div: [], exhaustion: [], body_mom: [], vol_rev: [] };
  const z = (i) => (dn[i] - D.m[i - 1]) / D.sd[i - 1];
  for (let i = 61; i < n - 1; i++) {
    if (bars[i + 1].t - bars[i].t > 600 || !(atr[i] > 0)) continue; // pas d'entrée juste avant un trou (fin de séance)
    const b = bars[i];
    const zd = z(i);
    const bigVol = b.v > 2 * V.m[i - 1];
    const upperHalf = b.c >= (b.h + b.l) / 2;
    const zb = (body[i] - B.m[i - 1]) / B.sd[i - 1];
    if (zd > 2 && b.c > b.o) S.delta_mom.push([i, 1]); else if (zd < -2 && b.c < b.o) S.delta_mom.push([i, -1]);
    if (zb > 2) S.body_mom.push([i, 1]); else if (zb < -2) S.body_mom.push([i, -1]);
    if (bigVol && zd < -2 && upperHalf) S.absorption.push([i, 1]); else if (bigVol && zd > 2 && !upperHalf) S.absorption.push([i, -1]);
    // Témoin : gros volume après une baisse, clôture dans la moitié haute (sans regarder le delta)
    if (bigVol && b.c > b.o && bars[i - 1].c < bars[i - 5].c && upperHalf) S.vol_rev.push([i, 1]); else if (bigVol && b.c < b.o && bars[i - 1].c > bars[i - 5].c && !upperHalf) S.vol_rev.push([i, -1]);
    // Divergence : plus haut / plus bas de 30 bougies sans confirmation du delta cumulé
    let hiP = -Infinity, loP = Infinity, hiC = -Infinity, loC = Infinity;
    for (let k = i - 30; k < i; k++) { hiP = Math.max(hiP, bars[k].h); loP = Math.min(loP, bars[k].l); hiC = Math.max(hiC, cvd[k]); loC = Math.min(loC, cvd[k]); }
    if (b.h > hiP && cvd[i] < hiC) S.cvd_div.push([i, -1]); else if (b.l < loP && cvd[i] > loC) S.cvd_div.push([i, 1]);
    // Épuisement : 3 bougies de delta fort (z > 1,5) dans un sens, puis bougie de sens contraire
    if (z(i - 1) > 1.5 && z(i - 2) > 1.5 && z(i - 3) > 1.5 && b.c < b.o) S.exhaustion.push([i, -1]);
    else if (z(i - 1) < -1.5 && z(i - 2) < -1.5 && z(i - 3) < -1.5 && b.c > b.o) S.exhaustion.push([i, 1]);
  }
  return { S, atr };
}

/* ---------- Simulation (une position à la fois par stratégie) ---------- */
function simulate(bars, sigs, atr, costPct, { R = 1.5, maxBars = 30 } = {}) {
  const trades = [];
  let busyUntil = -1;
  for (const [i, dir] of sigs) {
    if (i <= busyUntil) continue;
    const e = bars[i + 1].o; const risk = atr[i];
    const sl = e - dir * risk, tp = e + dir * R * risk;
    let exit = null, j = i + 1;
    for (; j < Math.min(bars.length, i + 1 + maxBars); j++) {
      if (j > i + 1 && bars[j].t - bars[j - 1].t > 600) { exit = bars[j - 1].c; j--; break; } // fin de séance
      const b = bars[j];
      if (dir > 0 ? b.l <= sl : b.h >= sl) { exit = sl; break; }
      if (dir > 0 ? b.h >= tp : b.l <= tp) { exit = tp; break; }
    }
    if (exit === null) { j = Math.min(bars.length - 1, j - 1); exit = bars[j].c; }
    const cost = (e * costPct) / 100;
    trades.push({ t: bars[i].t, r: (dir * (exit - e) - cost) / risk });
    busyUntil = j;
  }
  return trades;
}
function stats(tr) {
  if (!tr.length) return { n: 0 };
  const w = tr.filter((x) => x.r > 0);
  const gp = w.reduce((s, x) => s + x.r, 0), gl = -tr.filter((x) => x.r <= 0).reduce((s, x) => s + x.r, 0);
  return { n: tr.length, win: w.length / tr.length, avg: tr.reduce((s, x) => s + x.r, 0) / tr.length, pf: gl ? gp / gl : Infinity };
}
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
function report(label, bars, delta, costs, periods) {
  const { S, atr } = signals(bars, delta);
  console.log(`\n=== ${label} · ${bars.length.toLocaleString('fr-FR')} bougies ===`);
  console.log(`${'stratégie'.padEnd(12)} ${'frais'.padStart(6)}  ${'trades'.padStart(7)} gagn.  R moyen  PF   | ${periods.map((p) => p[0].padStart(16)).join(' | ')}`);
  for (const [name, sig] of Object.entries(S)) {
    for (const c of costs) {
      const tr = simulate(bars, sig, atr, c);
      const s = stats(tr);
      const per = periods.map(([, a, b]) => { const q = stats(tr.filter((x) => x.t >= a && x.t < b)); return q.n ? `${f(q.avg, 3).padStart(7)} R (${String(q.n).padStart(5)})` : '—'.padStart(16); });
      console.log(`${name.padEnd(12)} ${(c + ' %').padStart(6)}  ${String(s.n).padStart(7)} ${s.n ? `${Math.round(s.win * 100)} %`.padStart(5) : ''}  ${s.n ? f(s.avg, 3).padStart(6) : ''}  ${s.n ? f(s.pf).padStart(4) : ''} | ${per.join(' | ')}`);
    }
  }
}

(async () => {
  const T = (y, m = 1) => Date.UTC(y, m - 1, 1) / 1000;
  // 1. Vrai order flow : Binance
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    process.stdout.write(`Téléchargement ${sym} (Binance, 1 min)…\n`);
    const b1 = await binance(sym);
    const periods = [['2020–21', T(2020), T(2022)], ['2022–23', T(2022), T(2024)], ['2024–26', T(2024), T(2027)]];
    // Qualité du delta approximé (mesurée contre le vrai delta)
    const approx = bvc(b1);
    let sxy = 0, sxx = 0, syy = 0, same = 0, cnt = 0;
    for (let i = 101; i < b1.length; i++) { const x = approx[i] / b1[i].v, y = b1[i].d / b1[i].v; if (!Number.isFinite(x) || !Number.isFinite(y)) continue; sxy += x * y; sxx += x * x; syy += y * y; if (Math.sign(x) === Math.sign(y)) same++; cnt++; }
    console.log(`\n${sym} : delta approximé vs vrai delta (1 min) : corrélation ${f(sxy / Math.sqrt(sxx * syy))}, même signe ${Math.round((same / cnt) * 100)} %`);
    report(`${sym} · vrai delta · 1 min`, b1, b1.map((x) => x.d), C([0.04, 0.1]), periods);
    const b5 = agg(b1, 5);
    report(`${sym} · vrai delta · 5 min`, b5, b5.map((x) => x.d), C([0.04, 0.1]), periods);
    if (!GROSS) report(`${sym} · delta APPROXIMÉ · 5 min (contrôle)`, b5, bvc(b5), [0.04], periods);
  }
  // 2. Delta approximé sur les équivalents des contrats Lucid
  for (const tk of ['QQQ', 'SPY']) {
    const b1 = polygon1m(tk);
    const periods = [['nov. 24–juil. 25', T(2024, 11), T(2025, 7)], ['juil. 25–mars 26', T(2025, 7), T(2026, 3)], ['mars–nov. 26', T(2026, 3), T(2027)]];
    report(`${tk} (≈ ${tk === 'QQQ' ? 'MNQ' : 'MES'}) · delta approximé · 1 min`, b1, bvc(b1), C([0.01]), periods);
    const b5 = agg(b1, 5);
    report(`${tk} (≈ ${tk === 'QQQ' ? 'MNQ' : 'MES'}) · delta approximé · 5 min`, b5, bvc(b5), C([0.01]), periods);
  }
})().catch((e) => { console.error(e); process.exit(1); });
