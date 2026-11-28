#!/usr/bin/env node
/**
 * Cassure 4 h + volume + vrai delta (src/crypto4h.js), npm run crypto4h : résultats seuls par marché, achats / ventes
 * séparés, par période (2020–21, 2022–23, 2024–26), puis choix du filtre sur 2020–2023 SEULEMENT et jugement sur 2024–2026.
 */
const { loadKlines, loadFunding, backtest4h } = require('./src/crypto4h');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const st = (l) => ({ n: l.length, r: l.length ? l.reduce((a, t) => a + t.r, 0) / l.length : NaN, win: l.length ? (l.filter((t) => t.r > 0).length / l.length) * 100 : NaN });
const f = (s) => (s.n ? `${s.r >= 0 ? '+' : ''}${s.r.toFixed(2)} R (${s.n}, ${s.win.toFixed(0)} %)` : '—');
const PER = [['2020–21', Y(2020), Y(2022)], ['2022–23', Y(2022), Y(2024)], ['2024–26', Y(2024), Infinity]];
const data = {};
for (const sym of ['BTCUSDT', 'ETHUSDT', 'XAUUSDT', 'XAGUSDT']) data[sym] = { bars: loadKlines(sym), funding: loadFunding(sym) };
for (const [sym, d] of Object.entries(data)) console.log(`${sym} : ${d.bars.length} bougies 4 h depuis ${new Date(d.bars[0].t * 1000).toISOString().slice(0, 10)}`);
const V = { 'cassure seule': { useVol: false, useDelta: false }, '+ volume': { useVol: true, useDelta: false }, '+ volume + delta (0,5 σ)': { useVol: true, useDelta: true } };
for (const [sym, d] of Object.entries(data)) {
  console.log(`\n=== ${sym} ===`);
  for (const [name, o] of Object.entries(V)) {
    const tr = backtest4h(d.bars, { ...o, funding: d.funding });
    const crypto = sym.startsWith('BTC') || sym.startsWith('ETH');
    const per = crypto ? PER.map(([p, a, b]) => `${p} ${f(st(tr.filter((t) => t.entryT >= a && t.entryT < b)))}`).join(' · ') : '';
    console.log(`  ${name.padEnd(26)} total ${f(st(tr))} · achats ${f(st(tr.filter((t) => t.side === 'long')))} · ventes ${f(st(tr.filter((t) => t.side === 'short')))}${per ? `\n${' '.repeat(30)}${per}` : ''}`);
  }
}
// Hors échantillon : choix des réglages (N, k) sur 2020–2023 pour BTC + ETH ensemble, jugement sur 2024–2026
console.log('\n=== Choix du filtre sur 2020–2023 (BTC + ETH), jugement sur 2024–2026 ===');
const grid = [];
for (const n of [10, 20, 40]) for (const k of [0, 0.25, 0.5, 1]) for (const useDelta of [false, true]) grid.push({ n, kVol: k, kDelta: k, useVol: true, useDelta });
grid.push({ n: 20, useVol: false, useDelta: false });
const score = (o, a, b) => { const all = ['BTCUSDT', 'ETHUSDT'].flatMap((s) => backtest4h(data[s].bars, { ...o, funding: data[s].funding }).filter((t) => t.entryT >= a && t.entryT < b)); return st(all); };
const ranked = grid.map((o) => ({ o, tr: score(o, Y(2020), Y(2024)), te: score(o, Y(2024), Infinity) })).filter((x) => x.tr.n >= 100).sort((a, b) => b.tr.r - a.tr.r);
for (const x of ranked.slice(0, 8)) console.log(`  N ${x.o.n} · ${x.o.useVol ? `volume ≥ ${x.o.kVol} σ` : 'sans filtre'}${x.o.useDelta ? ` + delta ≥ ${x.o.kDelta} σ` : ''}`.padEnd(46) + `2020–23 ${f(x.tr)}  →  2024–26 ${f(x.te)}`);
const base = ranked.find((x) => !x.o.useVol);
console.log(`  (cassure seule N 20 : 2020–23 ${f(base.tr)} → 2024–26 ${f(base.te)})`);
