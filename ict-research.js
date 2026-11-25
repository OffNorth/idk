#!/usr/bin/env node
/**
 * ICT (npm run ict) : les concepts ICT tiennent-ils sur l'historique, avec des règles précises et les frais ?
 * Données : QQQ et SPY 1 min (Polygon, nov. 2024 → nov. 2026, séance 9 h 30 – 16 h New York ; ≈ MNQ / MES de Lucid),
 * regroupées aussi en 5 min ; or XAU/USD 5 min (HistData, 2009 → 2026, 17 ans).
 * Heures en heure de New York (changement d'heure compris). Frais aller-retour 0,01 % (≈ micro-futures / CFD or).
 *
 * Règles (aucune information future : signal à la clôture d'une bougie ; ordre limite exécuté si le cours touche le prix
 * pendant l'attente ; sur la bougie d'exécution, seul le stop compte, jamais l'objectif ; stop prioritaire ; tout est
 * fermé à l'heure de sortie de la séance) :
 *  - FVG          : 3 bougies, trou entre le plus haut de la 1re et le plus bas de la 3e (≥ x ATR), bougie du milieu dans
 *                   le sens du trou ; ordre limite au bord du trou (ou au milieu, « consequent encroachment ») pendant
 *                   30 bougies ; stop sous la 1re bougie ; objectif 2 R. Option : biais du jour (sens de la veille).
 *  - Silver Bullet: fenêtres 10 h – 11 h et 14 h – 15 h (New York ; + 3 h – 4 h pour l'or) ; liquidité = plus haut / plus
 *                   bas de l'heure qui précède ; après un balayage (cours au-delà), premier FVG dans l'autre sens → limite au
 *                   bord du FVG, stop à l'extrême du balayage, objectif 2 R ou la liquidité opposée ; sortie 1 h après la fenêtre.
 *  - Balayage PDH / PDL : le cours dépasse le plus haut (bas) de la veille puis clôture en dessous (dessus) → entrée contre
 *                   le balayage à l'ouverture suivante ; stop au-delà de la mèche ; objectif 2 R. Or : aussi balayage du range
 *                   asiatique (20 h – 2 h) entre 2 h et 5 h (ouverture de Londres).
 *  - SMT (QQQ / SPY) : un des deux fait un nouveau plus bas (haut) de 20 bougies, l'autre non, et la bougie se retourne →
 *                   entrée dans le sens du retournement sur celui qui a fait l'extrême ; stop au-delà ; objectif 2 R.
 *  - Order block  : bougie de déplacement (corps > k ATR) qui casse le plus haut (bas) des 10 bougies précédentes ; dernière
 *                   bougie de sens contraire avant elle = order block ; limite à son bord pendant 30 bougies, stop à son autre
 *                   bord, objectif 2 R.
 *  - Témoin       : entrée au hasard à chaque heure ronde de la séance, stop 1 ATR, objectif 2 R (ce que coûtent les frais).
 * Mesures : trades, gagnants, R moyen net, facteur de profit, R moyen par période ; ✅ = positif sur CHAQUE période et
 * facteur de profit ≥ 1,1.
 */
const fs = require('fs');
const path = require('path');
const { aggregate } = require('./src/history');

const CACHE = path.join(__dirname, 'data', 'research');
const COST = 0.01;

/* ---------- Données ---------- */
const polygon = (tk) => JSON.parse(fs.readFileSync(path.join(CACHE, `polygon-${tk}-1m-2024-11-18.json`), 'utf8')).map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v }));
const gold5 = () => JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));

/* ---------- Heure de New York, ATR, jours ---------- */
const offCache = new Map();
const nyOffset = (utcDay) => { // minutes à ajouter à l'UTC (−300 ou −240), mesuré à 17 h UTC
  if (!offCache.has(utcDay)) {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(new Date((utcDay * 86400 + 61200) * 1000)).find((p) => p.type === 'timeZoneName').value;
    const m = s.match(/GMT([+-]\d+)/);
    offCache.set(utcDay, m ? Number(m[1]) * 60 : -300);
  }
  return offCache.get(utcDay);
};
function prep(bars, { rth = false } = {}) {
  let list = bars;
  const tag = (b) => { const local = b.t + nyOffset(Math.floor(b.t / 86400)) * 60; return { m: Math.floor((local % 86400) / 60), d: Math.floor(local / 86400) }; };
  if (rth) list = bars.filter((b) => { const { m } = tag(b); return m >= 570 && m < 960; });
  const n = list.length;
  const P = { bars: list, n, m: new Int16Array(n), d: new Int32Array(n), wd: new Int8Array(n), atr: new Float64Array(n) };
  let a = 0;
  for (let i = 0; i < n; i++) {
    const { m, d } = tag(list[i]);
    P.m[i] = m; P.d[i] = d; P.wd[i] = (d + 4) % 7;
    const b = list[i];
    const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - list[i - 1].c), Math.abs(b.l - list[i - 1].c)) : b.h - b.l;
    a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14;
    P.atr[i] = a;
  }
  // Plus haut / bas et sens de la veille (jour de New York)
  P.pdh = new Float64Array(n).fill(NaN); P.pdl = new Float64Array(n).fill(NaN); P.bias = new Int8Array(n);
  let curD = null, hi = -Infinity, lo = Infinity, op = null, cl = null, prev = null;
  for (let i = 0; i < n; i++) {
    if (P.d[i] !== curD) { if (curD !== null) prev = { hi, lo, dir: cl > op ? 1 : cl < op ? -1 : 0 }; curD = P.d[i]; hi = -Infinity; lo = Infinity; op = list[i].o; }
    hi = Math.max(hi, list[i].h); lo = Math.min(lo, list[i].l); cl = list[i].c;
    if (prev) { P.pdh[i] = prev.hi; P.pdl[i] = prev.lo; P.bias[i] = prev.dir; }
  }
  return P;
}

/* ---------- Simulation des ordres (une position à la fois) ---------- */
function run(P, orders, { R = 2 } = {}) {
  const { bars, n } = P;
  orders.sort((x, y) => x.i - y.i);
  const trades = [];
  let busy = -1;
  for (const o of orders) {
    if (o.i <= busy || o.i + 1 >= n) continue;
    let filled = -1, e = null;
    if (o.limit == null) { if (P.d[o.i + 1] === P.d[o.i] && P.m[o.i + 1] < o.exitMin) { filled = o.i + 1; e = bars[filled].o; } }
    else {
      for (let k = o.i + 1; k < n && k <= o.i + (o.wait || 30); k++) {
        if (P.d[k] !== P.d[o.i] || P.m[k] >= o.exitMin) break;
        const b = bars[k];
        if (o.dir > 0 ? b.l <= o.limit : b.h >= o.limit) { filled = k; e = o.dir > 0 ? Math.min(o.limit, b.o) : Math.max(o.limit, b.o); break; }
      }
    }
    if (filled < 0) continue;
    const risk = o.dir * (e - o.sl);
    if (!(risk > 0)) continue;
    const tp = o.tp != null && o.dir * (o.tp - e) >= risk ? o.tp : e + o.dir * (o.rr || R) * risk;
    let exit = null, j = filled;
    for (; j < n; j++) {
      if (j > filled && (P.d[j] !== P.d[filled] || P.m[j] >= o.exitMin)) { exit = bars[j - 1].c; j--; break; }
      const b = bars[j];
      if (o.dir > 0 ? b.l <= o.sl : b.h >= o.sl) { exit = o.sl; break; }
      if ((j > filled || o.limit == null) && (o.dir > 0 ? b.h >= tp : b.l <= tp)) { exit = tp; break; }
    }
    if (exit === null) { j = n - 1; exit = bars[j].c; }
    trades.push({ t: bars[o.i].t, r: (o.dir * (exit - e) - (e * COST) / 100) / risk });
    busy = j;
  }
  return trades;
}

/* ---------- Stratégies ---------- */
const inWin = (m, [a, b]) => m >= a && m < b;
function fvg(P, { minGap = 0.25, mid = false, bias = false, win = [570, 900], exitMin = 960, wait = 30 } = {}) {
  const { bars: B } = P; const out = [];
  for (let i = 2; i < P.n; i++) {
    if (P.d[i - 2] !== P.d[i] || !inWin(P.m[i], win) || !(P.atr[i] > 0)) continue;
    if (B[i].l > B[i - 2].h && B[i].l - B[i - 2].h >= minGap * P.atr[i] && B[i - 1].c > B[i - 1].o && (!bias || P.bias[i] > 0)) {
      const top = B[i].l, bot = B[i - 2].h;
      out.push({ i, dir: 1, limit: mid ? (top + bot) / 2 : top, sl: Math.min(B[i - 2].l, B[i - 1].l), exitMin, wait });
    } else if (B[i].h < B[i - 2].l && B[i - 2].l - B[i].h >= minGap * P.atr[i] && B[i - 1].c < B[i - 1].o && (!bias || P.bias[i] < 0)) {
      const bot = B[i].h, top = B[i - 2].l;
      out.push({ i, dir: -1, limit: mid ? (top + bot) / 2 : bot, sl: Math.max(B[i - 2].h, B[i - 1].h), exitMin, wait });
    }
  }
  return out;
}
function silverBullet(P, { win, toLiq = false, after = 60 }) {
  const { bars: B } = P; const out = [];
  const [ws, we] = win;
  let day = null, hi = -Infinity, lo = Infinity, swept = 0, ext = null, sweptAt = -1, done = false;
  for (let i = 0; i < P.n; i++) {
    if (P.d[i] !== day) { day = P.d[i]; hi = -Infinity; lo = Infinity; swept = 0; ext = null; done = false; }
    const m = P.m[i];
    if (m >= ws - 60 && m < ws) { hi = Math.max(hi, B[i].h); lo = Math.min(lo, B[i].l); continue; }
    if (done || m < ws || m >= we || hi === -Infinity) continue;
    if (!swept) {
      if (B[i].l < lo) { swept = 1; ext = B[i].l; sweptAt = i; } else if (B[i].h > hi) { swept = -1; ext = B[i].h; sweptAt = i; }
      continue;
    }
    if (swept === 1) ext = Math.min(ext, B[i].l); else ext = Math.max(ext, B[i].h);
    if (i - 2 < sweptAt || P.d[i - 2] !== day) continue;
    // FVG dans l'autre sens que le balayage (déplacement)
    if (swept === 1 && B[i].l > B[i - 2].h && B[i - 1].c > B[i - 1].o) { out.push({ i, dir: 1, limit: B[i].l, sl: ext, tp: toLiq ? hi : null, exitMin: we + after, wait: 30 }); done = true; }
    else if (swept === -1 && B[i].h < B[i - 2].l && B[i - 1].c < B[i - 1].o) { out.push({ i, dir: -1, limit: B[i].h, sl: ext, tp: toLiq ? lo : null, exitMin: we + after, wait: 30 }); done = true; }
  }
  return out;
}
function sweepPD(P, { win = [570, 900], exitMin = 960 } = {}) {
  const { bars: B } = P; const out = [];
  let day = null, up = false, dn = false;
  for (let i = 0; i < P.n; i++) {
    if (P.d[i] !== day) { day = P.d[i]; up = false; dn = false; }
    if (!inWin(P.m[i], win) || Number.isNaN(P.pdh[i])) continue;
    const b = B[i];
    if (!up && b.h > P.pdh[i] && b.c < P.pdh[i]) { up = true; out.push({ i, dir: -1, limit: null, sl: b.h + 0.1 * P.atr[i], exitMin }); }
    else if (!dn && b.l < P.pdl[i] && b.c > P.pdl[i]) { dn = true; out.push({ i, dir: 1, limit: null, sl: b.l - 0.1 * P.atr[i], exitMin }); }
  }
  return out;
}
function sweepAsia(P, { exitMin = 720 } = {}) { // or : range asiatique 20 h – 2 h (New York), balayé entre 2 h et 5 h
  const { bars: B } = P; const out = []; const asia = new Map();
  for (let i = 0; i < P.n; i++) {
    const m = P.m[i];
    if (m >= 1200 || m < 120) { const k = m >= 1200 ? P.d[i] + 1 : P.d[i]; const r = asia.get(k) || { hi: -Infinity, lo: Infinity }; r.hi = Math.max(r.hi, B[i].h); r.lo = Math.min(r.lo, B[i].l); asia.set(k, r); }
  }
  let day = null, up = false, dn = false;
  for (let i = 0; i < P.n; i++) {
    if (P.d[i] !== day) { day = P.d[i]; up = false; dn = false; }
    const r = asia.get(P.d[i]);
    if (!r || P.m[i] < 120 || P.m[i] >= 300) continue;
    const b = B[i];
    if (!up && b.h > r.hi && b.c < r.hi) { up = true; out.push({ i, dir: -1, limit: null, sl: b.h + 0.1 * P.atr[i], exitMin }); }
    else if (!dn && b.l < r.lo && b.c > r.lo) { dn = true; out.push({ i, dir: 1, limit: null, sl: b.l - 0.1 * P.atr[i], exitMin }); }
  }
  return out;
}
function smt(P, Q, { look = 20, win = [600, 900], exitMin = 960 } = {}) { // P : marché tradé, Q : marché comparé
  const { bars: A } = P; const idx = new Map(Q.bars.map((b, j) => [b.t, j])); const out = [];
  for (let i = look; i < P.n; i++) {
    if (!inWin(P.m[i], win) || P.d[i - look] !== P.d[i]) continue;
    const j = idx.get(A[i].t);
    if (j === undefined || j < look) continue;
    let lA = Infinity, hA = -Infinity, lB = Infinity, hB = -Infinity;
    for (let k = 1; k <= look; k++) { lA = Math.min(lA, A[i - k].l); hA = Math.max(hA, A[i - k].h); lB = Math.min(lB, Q.bars[j - k].l); hB = Math.max(hB, Q.bars[j - k].h); }
    const b = A[i];
    if (b.l < lA && Q.bars[j].l >= lB && b.c > b.o) out.push({ i, dir: 1, limit: null, sl: b.l - 0.1 * P.atr[i], exitMin });
    else if (b.h > hA && Q.bars[j].h <= hB && b.c < b.o) out.push({ i, dir: -1, limit: null, sl: b.h + 0.1 * P.atr[i], exitMin });
  }
  return out;
}
function orderBlock(P, { disp = 1.5, win = [570, 900], exitMin = 960 } = {}) {
  const { bars: B } = P; const out = [];
  for (let i = 10; i < P.n; i++) {
    if (!inWin(P.m[i], win) || P.d[i - 10] !== P.d[i]) continue;
    const b = B[i]; const body = b.c - b.o;
    let hh = -Infinity, ll = Infinity;
    for (let k = 1; k <= 10; k++) { hh = Math.max(hh, B[i - k].h); ll = Math.min(ll, B[i - k].l); }
    if (body > disp * P.atr[i] && b.c > hh) {
      for (let k = i - 1; k >= i - 5; k--) if (B[k].c < B[k].o) { out.push({ i, dir: 1, limit: B[k].h, sl: B[k].l, exitMin, wait: 30 }); break; }
    } else if (-body > disp * P.atr[i] && b.c < ll) {
      for (let k = i - 1; k >= i - 5; k--) if (B[k].c > B[k].o) { out.push({ i, dir: -1, limit: B[k].l, sl: B[k].h, exitMin, wait: 30 }); break; }
    }
  }
  return out;
}
function randomBase(P, { win = [570, 900], exitMin = 960, seed = 7 } = {}) {
  let r = seed; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  const out = [];
  for (let i = 1; i < P.n; i++) {
    if (!inWin(P.m[i], win) || P.m[i] % 60 !== 0 || P.m[i - 1] % 60 === 0) continue;
    const dir = rnd() < 0.5 ? 1 : -1;
    out.push({ i, dir, limit: null, sl: P.bars[i].c - dir * P.atr[i], exitMin });
  }
  return out;
}

// Témoin du biais : entrée au hasard chaque heure, mais toujours dans le sens de la veille (le FVG apporte-t-il quelque chose ?)
function biasBase(P, { win = [570, 900], exitMin = 960 } = {}) {
  const out = [];
  for (let i = 1; i < P.n; i++) {
    if (!inWin(P.m[i], win) || P.m[i] % 60 !== 0 || P.m[i - 1] % 60 === 0 || !P.bias[i]) continue;
    out.push({ i, dir: P.bias[i], limit: null, sl: P.bars[i].c - P.bias[i] * P.atr[i], exitMin });
  }
  return out;
}

/* ---------- Bilan ---------- */
function stats(tr) {
  if (!tr.length) return { n: 0, avg: 0, pf: 0, win: 0 };
  const gp = tr.filter((x) => x.r > 0).reduce((s, x) => s + x.r, 0), gl = -tr.filter((x) => x.r <= 0).reduce((s, x) => s + x.r, 0);
  return { n: tr.length, win: tr.filter((x) => x.r > 0).length / tr.length, avg: tr.reduce((s, x) => s + x.r, 0) / tr.length, pf: gl ? gp / gl : Infinity };
}
const f = (x, d = 3) => (Number.isFinite(x) ? (x >= 0 ? ' ' : '') + x.toFixed(d) : ' ∞');
const keep = [];
function table(title, P, rows, periods) {
  console.log(`\n=== ${title} · ${P.n.toLocaleString('fr-FR')} bougies ===`);
  console.log(`${'règle'.padEnd(34)} trades gagn.  R moyen   PF  | ${periods.map((p) => p[0].padStart(17)).join(' | ')}`);
  for (const [name, orders, opt] of rows) {
    // Or 15 min : calculé sur ses propres bougies
    const PP = opt?.tf15 ? (P.g15 ||= prep(aggregate(P.bars, 900, 300))) : P;
    const tr = run(PP, orders || fvg(PP, { minGap: 0.25, mid: opt.mid, bias: true, win: [180, 900], wait: 10 }), opt || {});
    const s = stats(tr);
    const per = periods.map(([, a, b]) => stats(tr.filter((x) => x.t >= a && x.t < b)));
    const ok = s.n >= 30 && per.every((q) => q.n >= 8 && q.avg > 0) && s.pf >= 1.1;
    if (ok) keep.push(`${title} · ${name} : ${f(s.avg)} R, PF ${s.pf.toFixed(2)}, ${s.n} trades`);
    console.log(`${(ok ? '✅ ' : '   ') + name.padEnd(31)} ${String(s.n).padStart(6)} ${`${Math.round(s.win * 100)} %`.padStart(5)} ${f(s.avg).padStart(8)} ${s.pf.toFixed(2).padStart(5)} | ${per.map((q) => (q.n ? `${f(q.avg)} R (${String(q.n).padStart(4)})` : '—').padStart(17)).join(' | ')}`);
  }
}

(() => {
  const T = (y, m = 1) => Date.UTC(y, m - 1, 1) / 1000;
  const idxPeriods = [['nov. 24–juil. 25', T(2024, 11), T(2025, 7)], ['juil. 25–mars 26', T(2025, 7), T(2026, 3)], ['mars–nov. 26', T(2026, 3), T(2027)]];
  const raw = { QQQ: polygon('QQQ'), SPY: polygon('SPY') };
  const P1 = { QQQ: prep(raw.QQQ, { rth: true }), SPY: prep(raw.SPY, { rth: true }) };
  for (const tk of ['QQQ', 'SPY']) {
    const p1 = P1[tk];
    const p5 = prep(aggregate(p1.bars, 300, 60));
    const other = tk === 'QQQ' ? 'SPY' : 'QQQ';
    const rows = (P, tf) => [
      [`témoin (hasard) ${tf}`, randomBase(P)],
      [`témoin biais seul ${tf}`, biasBase(P)],
      ...[0.25, 0.5].flatMap((g) => [false, true].flatMap((mid) => [false, true].map((bias) => [`FVG ${tf} ≥${g} ATR ${mid ? 'milieu' : 'bord'}${bias ? ' + biais' : ''}`, fvg(P, { minGap: g, mid, bias })]))),
      [`order block ${tf} 1,5 ATR`, orderBlock(P, { disp: 1.5 })],
      [`order block ${tf} 2 ATR`, orderBlock(P, { disp: 2 })],
      [`balayage PDH/PDL ${tf}`, sweepPD(P)],
      [`balayage PDH/PDL ${tf} 1,5 R`, sweepPD(P), { R: 1.5 }],
    ];
    table(`${tk} (≈ ${tk === 'QQQ' ? 'MNQ' : 'MES'}) · 1 min`, p1, [
      ...rows(p1, '1m'),
      ['Silver Bullet 10–11 h · 2 R', silverBullet(p1, { win: [600, 660] })],
      ['Silver Bullet 10–11 h · liquidité', silverBullet(p1, { win: [600, 660], toLiq: true })],
      ['Silver Bullet 14–15 h · 2 R', silverBullet(p1, { win: [840, 900] })],
      ['Silver Bullet 14–15 h · liquidité', silverBullet(p1, { win: [840, 900], toLiq: true })],
      [`SMT vs ${other} 1m`, smt(p1, P1[other])],
    ], idxPeriods);
    table(`${tk} (≈ ${tk === 'QQQ' ? 'MNQ' : 'MES'}) · 5 min`, p5, rows(p5, '5m'), idxPeriods);
    const p15 = prep(aggregate(p1.bars, 900, 60));
    table(`${tk} · 15 min (robustesse)`, p15, [[`témoin biais seul 15m`, biasBase(p15)], ...[false, true].map((mid) => [`FVG 15m ≥0.25 ATR ${mid ? 'milieu' : 'bord'} + biais`, fvg(p15, { minGap: 0.25, mid, bias: true, wait: 10 })])], idxPeriods);
  }
  // Or, 17 ans
  const g = prep(gold5());
  const gp = [['2009–12', T(2009), T(2013)], ['2013–16', T(2013), T(2017)], ['2017–19', T(2017), T(2020)], ['2020–26', T(2020), T(2027)]];
  const W = [180, 900]; // 3 h – 15 h New York (Londres + New York)
  table('Or XAU/USD · 5 min · 2009–2026', g, [
    ['témoin (hasard)', randomBase(g, { win: W })],
    ['témoin biais seul', biasBase(g, { win: W })],
    ...[false, true].map((mid) => [`FVG 15m ≥0.25 ATR ${mid ? 'milieu' : 'bord'} + biais`, null, { tf15: true, mid }]),
    ...[0.25, 0.5].flatMap((gap) => [false, true].flatMap((mid) => [false, true].map((bias) => [`FVG ≥${gap} ATR ${mid ? 'milieu' : 'bord'}${bias ? ' + biais' : ''}`, fvg(g, { minGap: gap, mid, bias, win: W })]))),
    ['order block 1,5 ATR', orderBlock(g, { disp: 1.5, win: W })],
    ['order block 2 ATR', orderBlock(g, { disp: 2, win: W })],
    ['Silver Bullet 3–4 h · 2 R', silverBullet(g, { win: [180, 240] })],
    ['Silver Bullet 3–4 h · liquidité', silverBullet(g, { win: [180, 240], toLiq: true })],
    ['Silver Bullet 10–11 h · 2 R', silverBullet(g, { win: [600, 660] })],
    ['Silver Bullet 10–11 h · liquidité', silverBullet(g, { win: [600, 660], toLiq: true })],
    ['Silver Bullet 14–15 h · 2 R', silverBullet(g, { win: [840, 900] })],
    ['balayage PDH/PDL', sweepPD(g, { win: W })],
    ['balayage range asiatique (2–5 h)', sweepAsia(g)],
    ['balayage range asiatique · 1,5 R', sweepAsia(g), { R: 1.5 }],
  ], gp);
  console.log(`\nRègles positives sur chaque période (PF ≥ 1,1) : ${keep.length ? `\n  ${keep.join('\n  ')}` : 'aucune'}`);
})();
