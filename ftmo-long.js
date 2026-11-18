#!/usr/bin/env node
/**
 * L'or sur 22 ans (Dukascopy XAU/USD 2004 → 2026, `python3 scripts/dukascopy.py`) au lieu de 6 ans de PAXG :
 *   A. les scalps or du compte FTMO, période par période ;
 *   B. les 112 variantes de scalps (src/scalpgrid.js) : choix sur 2004–2019 (positives sur CHACUNE des 3 périodes),
 *      vérification sur 2020–2026 ;
 *   C. réussite du challenge FTMO (formule FTMO_PROGRAM, partie or seule) : scalps actuels contre les meilleures
 *      variantes choisies sur 2004–2019, période par période.
 * Frais 0,005 % par côté.
 *
 *   npm run ftmo-long
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { selectStrategies, tfOf, withTf } = require('./src/strategies');
const { computeScalp2 } = require('./src/scalp2');
const { variants, toStrategy } = require('./src/scalpgrid');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { annotate, RULES } = require('./src/sizing');

const FILE = path.join(__dirname, 'data', 'research', 'xauusd-5m.json');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [['2004–2008', Y(2004), Y(2009)], ['2009–2013', Y(2009), Y(2014)], ['2014–2019', Y(2014), Y(2020)], ['2020–2026', Y(2020), Infinity]];
const FEE = 0.005;
const strip = (l) => l.map((x) => x.split(':').slice(1).join(':'));
const pc = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(0)} %`;

(async () => {
  if (!fs.existsSync(FILE)) throw new Error('lancer d’abord : python3 scripts/dukascopy.py');
  const g5 = JSON.parse(fs.readFileSync(FILE, 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const G = { '5m': { c: g5, sec: 300 }, '15m': { c: aggregate(g5, 900, 300), sec: 900 } };
  console.log(`XAU/USD 5 min : ${g5.length} bougies, ${new Date(g5[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(g5[g5.length - 1].t * 1000).toISOString().slice(0, 10)}\n`);
  const parts = (list) => P.map(([, a, b]) => { const l = list.filter((t) => t.entryT >= a && t.entryT < b); return { n: l.length, sum: l.reduce((s, t) => s + t.pnlPct, 0) }; });
  const X = { '5m': computeScalp2(G['5m'].c, 300, 'gold'), '15m': computeScalp2(G['15m'].c, 900, 'gold') };

  // A. Scalps actuels du compte FTMO
  console.log(`=== A. Scalps or du compte FTMO (gain net cumulé : ${P.map((p) => p[0]).join(' · ')}) ===`);
  const cur = [];
  for (const s of selectStrategies(strip(cfg.ftmoStrategies))) {
    const tf = tfOf(s);
    const st = withTf(s, tf);
    const r = backtest(st, G[tf].c, { size: 1000, feePct: FEE, barSec: G[tf].sec, ind: s.compute ? s.compute(G[tf].c, G[tf].sec, 'gold') : X[tf], market: 'gold' });
    const p = parts(r.list);
    console.log(`  ${`${s.id}@${tf}`.padEnd(16)} ${p.map((x) => `${pc(x.sum)} (${x.n})`).join(' · ')}`);
    cur.push(...r.list.map((t) => ({ ...t, sid: s.id, market: 'gold' })));
  }

  // B. Variantes
  console.log('\n=== B. 112 variantes : choix sur 2004–2019 (positives sur chacune des 3 périodes), vérification 2020–2026 ===');
  const res = [];
  for (const tf of ['5m', '15m']) {
    for (const v of variants(X[tf])) {
      const r = backtest(toStrategy(X[tf], v, tf), G[tf].c, { size: 1000, feePct: FEE, barSec: G[tf].sec, ind: X[tf] });
      const p = parts(r.list);
      const chosen = p.slice(0, 3).every((x) => x.sum > 0 && x.n >= 100);
      res.push({ name: `${v.name} @${tf}`, p, chosen, valid: chosen && p[3].sum > 0, list: r.list, score: Math.min(...p.slice(0, 3).map((x) => x.sum)) });
    }
  }
  const chosen = res.filter((r) => r.chosen);
  console.log(`  ${res.length} testées · ${chosen.length} choisies · ${res.filter((r) => r.valid).length} confirmées sur 2020–2026`);
  chosen.sort((a, b) => b.score - a.score);
  for (const r of chosen.slice(0, 12)) console.log(`  ${r.valid ? '✔' : '✘'} ${r.name.padEnd(30)} ${r.p.map((x) => `${pc(x.sum)} (${x.n})`).join(' · ')}`);

  // C. Challenge FTMO, partie or seule
  const F = programOf(cfg);
  const opts = { riskPct: cfg.ftmoRisk, dayStopPct: cfg.ftmoDayStop, horizonDays: 180, sizer: RULES[cfg.ftmoSizing] || RULES.fixe,
    steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay };
  const top = chosen.slice(0, 5);
  const ports = {
    'scalps actuels': cur,
    '5 meilleures variantes (choix 2004–2019)': top.flatMap((r, k) => r.list.map((t) => ({ ...t, sid: `v${k}`, market: 'gold' }))),
    'actuels + 5 meilleures': [...cur, ...top.flatMap((r, k) => r.list.map((t) => ({ ...t, sid: `v${k}`, market: 'gold' })))],
  };
  console.log(`\n=== C. ${F.label} (partie or seule, risque ${cfg.ftmoRisk} %) : réussite en moins de 6 mois par période ===`);
  for (const [name, list] of Object.entries(ports)) {
    annotate(list);
    const row = P.map(([, a, b]) => {
      const c = challengeStats(list.filter((t) => t.entryT >= a && t.entryT < b), { ...opts, start: a, end: b === Infinity ? null : b });
      return c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)` : '   —';
    });
    console.log(`  ${name.padEnd(40)} ${row.join(' · ')}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
