/**
 * Cassure 4 h confirmée par le volume et le delta (proposition de l'utilisateur, 28/11/2026), sur les contrats perpétuels
 * Binance (data.binance.vision : bougies 4 h avec le VRAI volume des achats agressifs, funding toutes les 8 h).
 *   Entrée (clôture 4 h) : clôture > plus haut des N bougies précédentes (vente : < plus bas) ; filtres : volume et delta
 *   (achats agressifs − ventes agressives) au-dessus de leur moyenne de k écarts-types (delta sous la moyenne pour une
 *   vente) sur les N bougies précédentes.
 *   Sortie : stop 1,5 ATR(14), puis stop suiveur à 3 ATR du meilleur cours de clôture, au plus 10 jours (60 bougies).
 *   Coûts : 0,05 % par côté (taker) + 0,02 % de glissement par côté, funding payé / reçu toutes les 8 h.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'research', 'bnv');

/** Bougies 4 h d'un symbole : { t, o, h, l, c, v, delta } (t en secondes), triées. */
function loadKlines(sym) {
  const rows = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith(`${sym}-4h-`)).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length < 10 || !/^\d/.test(p[0])) continue;
      const v = +p[5], buy = +p[9];
      rows.push({ t: Math.floor(+p[0] / 1000), o: +p[1], h: +p[2], l: +p[3], c: +p[4], v, delta: 2 * buy - v });
    }
  }
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.t) ? false : seen.add(r.t))).sort((a, b) => a.t - b.t);
}

/** Funding : [{ t, rate }] (taux par période de 8 h). */
function loadFunding(sym) {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith(`${sym}-fundingRate-`)).sort()) {
    for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
      const p = line.split(',');
      if (p.length < 3 || !/^\d/.test(p[0])) continue;
      out.push({ t: Math.floor(+p[0] / 1000), rate: +p[p.length - 1] });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const zAt = (arr, i, n) => {
  let s = 0, s2 = 0;
  for (let k = i - n; k < i; k++) { s += arr[k]; s2 += arr[k] * arr[k]; }
  const m = s / n, sd = Math.sqrt(Math.max(1e-12, s2 / n - m * m));
  return (arr[i] - m) / sd;
};

/**
 * Backtest. opts : { n = 20, kVol = 0.5, kDelta = 0.5, useVol, useDelta, side = 'both', fee = 0.0007, funding, slAtr = 1.5,
 * trailAtr = 3, maxBars = 60 }. Retourne les trades { side, entry, initSl, entryT, exitT, exit, pnlPct, r, reason, worstPct }.
 */
function backtest4h(bars, opts = {}) {
  const { n = 20, kVol = 0.5, kDelta = 0.5, useVol = true, useDelta = true, side = 'both', fee = 0.0007, funding = [], slAtr = 1.5, trailAtr = 3, maxBars = 60 } = opts;
  const atr = []; let a = 0;
  bars.forEach((b, i) => { const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l; a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(a); });
  const vol = bars.map((b) => b.v), del = bars.map((b) => b.delta);
  const trades = []; let pos = null; let fi = 0;
  for (let i = n + 1; i < bars.length; i++) {
    const b = bars[i];
    if (pos) {
      // funding échu pendant la bougie
      while (fi < funding.length && funding[fi].t <= b.t + 4 * 3600) { if (funding[fi].t > pos.t0) pos.fund += (pos.side === 'long' ? -1 : 1) * funding[fi].rate * 100; fi++; }
      const long = pos.side === 'long';
      let exit = null, reason = null;
      if (long ? b.l <= pos.sl : b.h >= pos.sl) { exit = long ? Math.min(b.o, pos.sl) : Math.max(b.o, pos.sl); reason = 'stop'; }
      else if (i - pos.i >= maxBars) { exit = b.c; reason = 'time'; }
      pos.worst = long ? Math.min(pos.worst, b.l) : Math.max(pos.worst, b.h);
      if (exit !== null) {
        const gross = (long ? exit / pos.entry - 1 : 1 - exit / pos.entry) * 100;
        const pnlPct = gross - 2 * fee * 100 + pos.fund;
        const riskPct = (Math.abs(pos.entry - pos.sl0) / pos.entry) * 100;
        trades.push({ side: pos.side, entry: pos.entry, initSl: pos.sl0, sl: pos.sl0, entryT: pos.t0, exitT: b.t + 4 * 3600 - 1, exit, pnlPct, r: pnlPct / riskPct, reason,
          worstPct: (long ? pos.worst / pos.entry - 1 : 1 - pos.worst / pos.entry) * 100 - 2 * fee * 100 });
        pos = null;
      } else {
        pos.best = long ? Math.max(pos.best, b.c) : Math.min(pos.best, b.c);
        const trail = long ? pos.best - trailAtr * atr[i] : pos.best + trailAtr * atr[i];
        pos.sl = long ? Math.max(pos.sl, trail) : Math.min(pos.sl, trail);
        continue;
      }
    }
    let hi = -Infinity, lo = Infinity;
    for (let k = i - n; k < i; k++) { hi = Math.max(hi, bars[k].h); lo = Math.min(lo, bars[k].l); }
    const zv = zAt(vol, i, n), zd = zAt(del, i, n);
    const okVol = !useVol || zv >= kVol;
    const goLong = side !== 'short' && b.c > hi && okVol && (!useDelta || zd >= kDelta);
    const goShort = side !== 'long' && b.c < lo && okVol && (!useDelta || zd <= -kDelta);
    if (goLong || goShort) {
      const s = goLong ? 'long' : 'short';
      const sl = goLong ? b.c - slAtr * atr[i] : b.c + slAtr * atr[i];
      pos = { side: s, entry: b.c, sl, sl0: sl, i, t0: b.t + 4 * 3600, best: b.c, worst: b.c, fund: 0 };
      while (fi < funding.length && funding[fi].t <= pos.t0) fi++;
    }
  }
  return trades;
}

module.exports = { loadKlines, loadFunding, backtest4h, DIR };
