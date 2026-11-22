#!/usr/bin/env node
/**
 * FTMO ou Lucid Trading ? Les stratégies du compte FTMO actuel (or réel HistData intraday + journalières, Nasdaq,
 * S&P 500, EUR/USD) rejouées sous les règles de chaque société de financement :
 *   FTMO 1 étape   : +10 %, perte du jour 3 %, perte max 10 % suiveuse, meilleur jour ≤ 50 %, CFD (taille au $ près)
 *   FTMO 2 étapes  : +10 % puis +5 %, perte du jour 5 %, perte max 10 % fixe
 *   LucidFlex 50K  : +3 000 $, pas de perte du jour, perte max 2 000 $ suiveuse en fin de journée (bloquée à +100 $),
 *                    meilleur jour ≤ 40 %, micro-futures CME en contrats entiers (40 au plus)
 *   LucidFlex 100K : +6 000 $, perte max 3 000 $, 60 micros
 * Phase financée (12 mois au plus) : FTMO 80 % des gains retirés tous les 14 jours, prix du challenge remboursé au
 * 1er versement ; Lucid 90 %, versement après 5 jours gagnants ≥ 150 $, ≤ 50 % du gain et ≤ 2 000 / 3 000 $.
 * Règles et prix : sources secondaires 2026 (à vérifier sur les sites officiels, ils changent souvent).
 *
 *   npm run lucid-compare     (RISKS=… / FUNDED_RISKS=… : multiplicateurs de risque essayés, challenge / financé)
 */
const path = require('path');
const cfg = require('./src/config');
const { challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;


const FTMO_FUNDED = { rule: 'ftmo', every: 14, split: 0.8, fee: 600, refund: true, days: 365 };
const lucidFunded = (fee, cap) => ({ rule: 'lucid', cycleDays: 5, minDay: 150, share: 0.5, cap, split: 0.9, fee, refund: false, days: 365 });
const lucid = (capital, maxLossUsd, maxContracts, fee, cap) => ({
  capital, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency ?? 40, minDays: 2,
  contracts: true, maxContracts, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, funded: lucidFunded(fee, cap),
});
const FORMULAS = {
  'FTMO 1 étape 100K': { capital: 100_000, steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, leverage: 30, funded: FTMO_FUNDED },
  'FTMO 2 étapes 100K': { capital: 100_000, steps: 2, dailyPct: 5, maxPct: 10, leverage: 30, funded: FTMO_FUNDED },
  'LucidFlex 50K': lucid(50_000, 2000, 40, 165, 2000),
  'LucidFlex 100K': lucid(100_000, 3000, 60, 260, 3000),
};
const MULS = (process.env.RISKS || '0.25,0.5,0.75,1').split(',').map(Number);
const FMULS = (process.env.FUNDED_RISKS || '1,0.5,0.25').split(',').map(Number);

(async () => {
  const { all, q5, A } = await buildTrades(cfg, CACHE);
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;

  const usd = (v) => `${v < 0 ? '−' : '+'}${Math.abs(Math.round(v)).toLocaleString('fr-FR')} $`;
  const run = (F, mul, ds, list, a) => {
    const l = list.map((t) => ({ ...t, riskPct: t.riskPct * mul }));
    const c = challengeStats(l, { riskPct: 1, dayStopPct: ds, sizer, horizonDays: 365, start: a, everyDays: 7, ...F });
    if (!c) return null;
    c.pass6 = c.tries ? (c.durations.filter((d) => d <= 180).length / c.tries) * 100 : 0;
    return c;
  };
  const line = (c) => (c
    ? `${c.pass6.toFixed(0).padStart(3)} % / ${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j) · échecs jour/max ${c.failedDaily}/${c.failedMax} · financé : ${c.fundedMonths.toFixed(1)} mois, perdu ${c.fundedLost.toFixed(0)} %, ${usd(c.paidPerMonth)}/mois · net ${usd(c.netPerTry)} par challenge`
    : '—');

  const periods = {};
  if (q5) periods.A = ['A. nov. 2024 → nov. 2026 (toutes les stratégies, ≈ 6 trades / jour)', q5[0].t + 30 * 86400, Infinity, () => true];
  const noNasIntra = (t) => !(t.intraday && t.market === 'nas100');
  periods.B = ['B. 2009 → 2019 (sans Nasdaq intraday) — choix du réglage', Y(2009) + 60 * 86400, Y(2020), noNasIntra];
  periods.C = ['C. 2020 → 2026 (sans Nasdaq intraday) — vérification', Y(2020), Infinity, noNasIntra];
  const lists = Object.fromEntries(Object.entries(periods).map(([k, [, a, b, filt]]) => [k, all.filter((t) => t.entryT >= a && t.entryT < b && filt(t))]));
  const go = (k, F, st) => run({ ...F, funded: { ...F.funded, phase: { riskMul: st.fm } } }, st.mul, st.ds, lists[k], periods[k][1]);

  console.log(`=== FTMO contre Lucid · mêmes stratégies (${A.strategies.length}) · risque de base ${cfg.ftmoRisk} % journalières / ${cfg.ftmoIntradayRisk} % intraday ===`);
  console.log('Réussite < 6 mois / < 1 an (médiane) · causes d\'échec · phase financée (durée moyenne, part perdue, versé au trader) · gain net moyen par challenge acheté');
  console.log(`Réglages essayés : risque × ${MULS.join(' / ')} pendant le challenge, × ${FMULS.join(' / ')} en financé, stop du jour maison ${cfg.ftmoDayStop} % ou non ; choix sur B (meilleur gain net), puis vérification sur C et A\n`);
  for (const [name, F] of Object.entries(FORMULAS)) {
    const tried = [];
    for (const mul of MULS) for (const ds of [cfg.ftmoDayStop, 0]) for (const fm of FMULS) {
      const c = go('B', F, { mul, ds, fm });
      if (c) tried.push({ mul, ds, fm, c });
    }
    tried.sort((p, q) => q.c.netPerTry - p.c.netPerTry);
    const st = tried[0];
    const lbl = `risque × ${st.mul}, financé × ${st.fm}, stop du jour ${st.ds ? `${st.ds} %` : 'non'}`;
    console.log(`${name} — ${lbl}`);
    for (const k of ['B', 'C', 'A']) if (periods[k]) console.log(`  ${k}  ${line(k === 'B' ? st.c : go(k, F, st))}`);
    const pass = [...tried].sort((p, q) => q.c.passRate - p.c.passRate)[0];
    console.log(`  (meilleure réussite sur B : risque × ${pass.mul}, stop du jour ${pass.ds ? `${pass.ds} %` : 'non'} → ${pass.c.passRate.toFixed(0)} % ; C ${go('C', F, pass).passRate.toFixed(0)} %)\n`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
