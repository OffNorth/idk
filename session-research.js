#!/usr/bin/env node
/**
 * Recherche : stratégies de l'or liées aux séances d'ASIE et de NEW YORK (les stratégies intraday or actuelles sont
 * surtout sur Londres). Or au comptant réel 5 min (HistData 2009–2026), moteur de backtest du bot, frais 0,005 % par
 * côté. Heures de New York et de Londres avec changements d'heure (Intl).
 *   Familles : cassure du range asiatique à l'ouverture de Londres · cassure à l'ouverture de Tokyo / Shanghai ·
 *   retour à la moyenne asiatique (g_asia) · effet de nuit (g_night) · cassure de l'ouverture COMEX / New York ·
 *   fixing de Londres (suivre / contrer) · après la clôture de Londres · dernière heure de New York.
 * Sélection : positive sur les 3 tranches (2009–2014, 2015–2020, 2021–2026) avec ≥ 50 trades chacune, puis rejouée
 * dans le challenge FTMO 1 étape et l'évaluation Lucid avec les stratégies actuelles (réussite < 1 an).
 *
 *   npm run sessions            (TOP=n : nombre de candidates rejouées dans les challenges, 6 par défaut)
 */
const fs = require('fs');
const path = require('path');
const { backtest } = require('./src/gold');

const CACHE = path.join(__dirname, 'data', 'research');
const FEE = 0.005;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const SLICES = [[Y(2009), Y(2015)], [Y(2015), Y(2021)], [Y(2021), Infinity]];

const { compute, breakout, momentum, night, hm } = require('./src/sessions');

function candidates() {
  const C = [];
  // ---- Asie
  for (const end of [hm(9), hm(11)]) for (const stopAtr of [0, 1.5]) for (const exitAt of [hm(12), hm(19, 55)]) {
    C.push(breakout({ id: `as_rng_${end / 60}_${stopAtr}_${exitAt / 60 | 0}`, name: `Or : cassure du range asiatique (0 h–7 h UTC) avant ${end / 60} h, sortie ${Math.floor(exitAt / 60)} h${stopAtr ? `, stop ≤ ${stopAtr} ATR` : ''}`, tz: 'utc', start: 0, len: hm(7), entryEnd: end, exitAt, stopAtr }));
  }
  for (const [lbl, start] of [['Tokyo', 0], ['Shanghai', hm(1, 30)]]) for (const len of [30, 60]) for (const exitAt of [hm(6, 55)]) {
    C.push(breakout({ id: `as_${lbl.toLowerCase()}_${len}`, name: `Or : cassure des ${len} premières min de ${lbl} (${start / 60} h UTC), sortie 6 h 55 UTC`, tz: 'utc', start, len, entryEnd: start + len + 150, exitAt }));
  }
  for (const th of [0.15, 0.3]) for (const mode of ['follow', 'fade']) {
    C.push(momentum({ id: `as_mom_${th}_${mode}`, name: `Or : mouvement de la nuit asiatique (0 h → 6 h UTC) > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} jusqu'à 12 h UTC`, tz: 'utc', ref: hm(0, 5), at: hm(6), exitAt: hm(12), th, mode }));
  }
  C.push(night({ id: 'as_night', name: 'Or : effet de nuit (achat 21 h → vente 7 h UTC, lundi → jeudi)' }));
  C.push(night({ id: 'as_night_23', name: 'Or : effet de nuit (achat 23 h → vente 7 h UTC)', inH: 23 }));
  // ---- New York (heures de New York, changement d'heure compris)
  for (const [lbl, start] of [['COMEX', hm(8, 20)], ['New York', hm(9, 30)]]) for (const len of [15, 30]) for (const exitAt of [hm(13, 30), hm(16, 55)]) for (const stopAtr of [0, 1.5]) {
    C.push(breakout({ id: `ny_${lbl === 'COMEX' ? 'cx' : 'ny'}${len}_${exitAt / 60 | 0}_${stopAtr}`, name: `Or : cassure des ${len} premières min de ${lbl} (${Math.floor(start / 60)} h ${String(start % 60).padStart(2, '0')} NY), sortie ${Math.floor(exitAt / 60)} h ${String(exitAt % 60).padStart(2, '0')} NY${stopAtr ? `, stop ≤ ${stopAtr} ATR` : ''}`, tz: 'ny', start, len, entryEnd: hm(12), exitAt, stopAtr }));
  }
  // Fixing de Londres (15 h, heure de Londres) : mouvement depuis 8 h Londres → suivre / contrer jusqu'à 17 h / 20 h Londres
  for (const th of [0.3, 0.6]) for (const mode of ['follow', 'fade']) for (const exitAt of [hm(17), hm(20)]) {
    C.push(momentum({ id: `ny_fix_${th}_${mode}_${exitAt / 60}`, name: `Or : au fixing de Londres (15 h), mouvement depuis 8 h > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} jusqu'à ${exitAt / 60} h (Londres)`, tz: 'lon', ref: hm(8), at: hm(15), exitAt, th, mode }));
  }
  // Après la clôture de Londres (16 h 30 Londres) : sens de la journée → suivre / contrer jusqu'à la clôture de New York
  for (const th of [0.3, 0.6]) for (const mode of ['follow', 'fade']) {
    C.push(momentum({ id: `ny_lclose_${th}_${mode}`, name: `Or : à la clôture de Londres (16 h 30), mouvement depuis 8 h > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} jusqu'à 21 h (Londres)`, tz: 'lon', ref: hm(8), at: hm(16, 30), exitAt: hm(21), th, mode }));
  }
  // Dernière heure de New York : sens depuis 9 h 30 NY → suivre / contrer de 15 h à 16 h 55 NY
  for (const th of [0.2, 0.4]) for (const mode of ['follow', 'fade']) {
    C.push(momentum({ id: `ny_last_${th}_${mode}`, name: `Or : dernière heure de New York (15 h), mouvement depuis 9 h 30 > ${th} % → ${mode === 'follow' ? 'suivre' : 'contrer'} jusqu'à 16 h 55 NY`, tz: 'ny', ref: hm(9, 30), at: hm(15), exitAt: hm(16, 55), th, mode }));
  }
  return C;
}

(async () => {
  const g5 = JSON.parse(fs.readFileSync(path.join(CACHE, 'xauusd-5m.json'), 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
  const C = candidates();
  // g_asia (bot, testée sur PAXG) re-testée sur l'or réel
  const gAsia = require('./src/strategies').selectStrategies(['g_asia'])[0];
  if (gAsia) C.push(gAsia);
  console.log(`=== Or : séances d'Asie et de New York · ${C.length} variantes · or au comptant 5 min ${new Date(g5[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(g5[g5.length - 1].t * 1000).toISOString().slice(0, 10)} · frais ${FEE} %/côté ===`);
  console.log('Gain cumulé (somme des % par trade) par tranche 2009–14 | 2015–20 | 2021–26 · trades · % gagnants · R moyen\n');
  const rows = [];
  for (const s of C) {
    let r;
    try {
      r = backtest(s, g5, { size: 1000, feePct: FEE, financingPct: 0, barSec: 300, market: 'gold', ind: s.compute ? s.compute(g5, 300, 'gold') : undefined });
    } catch (err) {
      console.log(`  ${s.id} : erreur ${err.message}`);
      continue;
    }
    const sl = SLICES.map(([a, b]) => r.list.filter((t) => t.entryT >= a && t.entryT < b));
    const sum = (l) => l.reduce((a, t) => a + t.pnlPct, 0);
    const R = (t) => t.pnlPct / Math.max(1e-9, (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100);
    const row = { s, list: r.list, g: sl.map(sum), n: sl.map((l) => l.length), win: r.list.length ? (r.list.filter((t) => t.pnlPct > 0).length / r.list.length) * 100 : 0, avgR: r.list.length ? r.list.reduce((a, t) => a + R(t), 0) / r.list.length : 0 };
    row.ok = row.g.every((v) => v > 0) && row.n.every((v) => v >= 50);
    rows.push(row);
  }
  rows.sort((a, b) => Math.min(...b.g) - Math.min(...a.g));
  for (const r of rows) {
    console.log(`${r.ok ? '✅' : '  '} ${r.s.id.padEnd(22)} ${r.g.map((v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`.padStart(9)).join(' |')} · ${String(r.list.length).padStart(5)} trades · ${r.win.toFixed(0)} % · ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(2)} R  ${r.s.name}`);
  }
  const kept = rows.filter((r) => r.ok);
  console.log(`\n${kept.length} variante(s) positive(s) sur les 3 tranches sur ${rows.length}.`);
  fs.writeFileSync(path.join(CACHE, 'session-research.json'), JSON.stringify(rows.map((r) => ({ id: r.s.id, name: r.s.name, g: r.g, n: r.n, win: r.win, avgR: r.avgR, ok: r.ok }))));

  // ---- Challenges FTMO / Lucid : stratégies actuelles + chaque candidate retenue (les meilleures)
  if (!kept.length) return;
  const cfg = require('./src/config');
  const { challengeStats, cmeDay } = require('./src/ftmo');
  const { RULES } = require('./src/sizing');
  const { buildTrades } = require('./src/ftmoTrades');
  const { programOf } = require('./src/ftmoAccount');
  const { all, q5 } = await buildTrades(cfg, CACHE);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const F = programOf(cfg);
  const P = { B: [Y(2009) + 60 * 86400, Y(2020), (t) => !(t.intraday && t.market === 'nas100')], C: [Y(2020), Infinity, (t) => !(t.intraday && t.market === 'nas100')] };
  if (q5) P.A = [q5[0].t + 30 * 86400, Infinity, () => true];
  const lucidRisk = (t) => (t.intraday ? ((cfg.lucidIntradayStrategies || []).includes(t.sid) || t.extra ? cfg.lucidIntradayRisk : 0) : cfg.ftmoRisk * cfg.lucidRiskMul);
  const RS = {
    FTMO: { R: { steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, dayStopPct: cfg.ftmoDayStop }, risk: (t) => t.riskPct },
    Lucid: { R: { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency ?? 40, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop }, risk: lucidRisk },
  };
  const run = (extra) => Object.fromEntries(Object.entries(RS).map(([name, S]) => [name, Object.entries(P).map(([k, [a, b, f]]) => {
    const list = [...all, ...extra].filter((t) => t.entryT >= a && t.entryT < b && f(t)).map((t) => ({ ...t, riskPct: S.risk(t) })).filter((t) => t.riskPct > 0);
    const c = challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...S.R });
    return `${k} ${c.passRate.toFixed(0)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`;
  }).join(' | ')]));
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join('  ·  ');
  console.log(`\n=== Challenges (réussite < 1 an : 2009–19 | 2020–26 | nov. 24–26), risque intraday FTMO ${cfg.ftmoIntradayRisk} %, Lucid ${cfg.lucidIntradayRisk} % ===`);
  console.log(`actuel                 ${fmt(run([]))}`);
  const top = kept.slice(0, Number(process.env.TOP || 6));
  for (const r of top) {
    const extra = r.list.map((t) => ({ ...t, sid: `gold:${r.s.id}`, market: 'gold', intraday: true, extra: true, riskPct: cfg.ftmoIntradayRisk, contractUsd: t.entry * 10, contractFee: 3.5 }));
    console.log(`+ ${r.s.id.padEnd(20)} ${fmt(run(extra))}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
