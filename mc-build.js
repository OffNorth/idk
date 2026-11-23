#!/usr/bin/env node
/**
 * Données de la Time Machine (src/timeMachine.js) : trades simulés des stratégies du compte FTMO / Lucid
 * (src/ftmoTrades.js) sur nov. 2024 → nov. 2026 — seule période avec toutes les stratégies, Nasdaq intraday compris —
 * groupés par jour de trading, dans un fichier compact commité (src/mcDays.json) : le serveur du bot n'a pas les
 * données de recherche.
 *
 *   npm run mc-build
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { ftmoDay } = require('./src/ftmo');
const { buildTrades } = require('./src/ftmoTrades');

const CACHE = path.join(__dirname, 'data', 'research');
const r = (v, k = 5) => (Number.isFinite(v) ? +v.toPrecision(k) : undefined);

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE);
  if (!q5) throw new Error('Nasdaq intraday (QQQ Polygon) absent du cache : impossible de couvrir toutes les stratégies');
  const from = q5[0].t + 30 * 86400;
  const to = Math.max(...all.map((t) => t.entryT));
  const byDay = new Map();
  for (const t of all) {
    if (t.entryT < from) continue;
    const d = ftmoDay(t.entryT);
    const base = Date.parse(`${d}T00:00:00Z`) / 1000;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push({
      s: t.sid, i: t.intraday ? 1 : 0, o: t.entryT - base, d: Math.max(60, t.exitT - t.entryT),
      e: r(t.entry, 7), l: r(t.initSl ?? t.sl, 7), p: r(t.pnlPct, 5), w: r(t.worstPct, 5), c: r(t.contractUsd, 6), f: t.contractFee,
    });
  }
  // Jours ouvrés sans trade : comptent aussi (journée calme), pour garder la bonne fréquence de trades
  const days = [];
  for (let t = Math.floor(from / 86400) * 86400; t <= to; t += 86400) {
    const wd = new Date(t * 1000).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const d = new Date(t * 1000).toISOString().slice(0, 10);
    days.push(byDay.get(d) || []);
  }
  const out = { built: new Date().toISOString().slice(0, 10), from: new Date(from * 1000).toISOString().slice(0, 10), to: new Date(to * 1000).toISOString().slice(0, 10), strategies: [...new Set(all.map((t) => t.sid))], days };
  const file = path.join(__dirname, 'src', 'mcDays.json');
  fs.writeFileSync(file, JSON.stringify(out));
  const n = days.reduce((a, x) => a + x.length, 0);
  console.log(`${days.length} jours ouvrés (${out.from} → ${out.to}), ${n} trades, ${(fs.statSync(file).size / 1024).toFixed(0)} Ko → src/mcDays.json`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
