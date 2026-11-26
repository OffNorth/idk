#!/usr/bin/env node
/**
 * Compte Lucid FINANCÉ (npm run lucid-funded) : objectif de l'utilisateur = réussir l'évaluation Lucid, puis toucher des
 * retraits le plus vite et le plus sûrement possible pour financer un compte FTMO.
 * Règles de retrait LucidFlex (src/ftmoAccount.js, sources secondaires) : 5 jours gagnants d'au moins 150 $, retrait
 * ≤ 50 % du gain et ≤ 2 000 $ (50K), 90 % pour le trader ; perte max 2 000 $ suiveuse en fin de journée, bloquée à
 * capital + 100 $.
 * Variantes : risque (intraday et journalier) × 0,5 / 0,75 / 1 / 1,5 / 2 / 3 du risque « financé » actuel ; gestion de la
 * journée : aucune, arrêt après 1 perte, plafond de gain du jour 150 / 300 / 500 $ (plus de jours gagnants ≥ 150 $).
 * Départ chaque jour ouvré sur nov. 24–26 (toutes les stratégies, intraday compris) et chaque semaine sur 2020–2024
 * (journalières seulement) : 1er retrait en ≤ 30 j / ≤ 60 j, délai médian du 1er retrait, retraits pour le trader sur
 * 6 et 12 mois, comptes perdus en 12 mois.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { runPhase, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;

(async () => {
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const NYB = { nas100: [qs, 82, 2.5], silver: [nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity })), 1075, 3.5],
    dow: [nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    spx: [nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60)), 50, 4] };
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k), 'funded') > 0);
  const intra = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; }).flatMap((k) => {
    const [b, mult, fee] = NYB[k.split(':')[0]]; const s = strat(k)[1];
    return backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, b, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid: k, market: k.split(':')[0], intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  });
  const base = [...all.filter((t) => sids.includes(t.sid) && !t.intraday), ...intra].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid), 'funded') }));
  const A0 = q5[0].t + 30 * DAY;
  const RL = { capital: 50_000, target: Infinity, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: 0, minDays: 0, contracts: true, maxContracts: 40,
    minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1,
    // Règles officielles du compte financé (centre d'aide Lucid, oct. 2026) : contrats selon le gain, perte max bloquée dès le 1er retrait
    scaling: [[0, 20], [1000, 30], [2000, 40]], lockOnPayout: true,
    // + risque selon la marge restante (FUNDED_CUSHION), comme en direct
    sizer: (t, st) => (RULES[cfg.ftmoSizing] || RULES.fixe)(t, st) * (cfg.fundedCushion !== false ? require('./src/sizing').cushionMul(st.room) : 1) };

  const study = (mul, rules, [a, b, withIntra, step]) => {
    const list = base.filter((t) => withIntra || !t.intraday).map((t) => ({ ...t, riskPct: t.riskPct * mul })).sort((x, y) => x.entryT - y.entryT);
    const end = Math.min(b, list[list.length - 1].entryT) - 120 * DAY;
    let n = 0; let p30 = 0; let p60 = 0; const firsts = []; let paid6 = 0; let paid12 = 0; let lost = 0;
    for (let s = a; s < end; s += step) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      n++;
      let good = 0; let nPay = 0; let cycleStart = -Infinity;
      const payout = ({ day, balance, capital, dayPnl }) => {
        if ((dayPnl.get(day) || 0) >= 150) good++;
        const gain = balance - capital;
        if (nPay >= 5 || good < 5 || gain <= 0 || balance <= cycleStart) return 0; // 5 retraits au plus, gain net positif sur le cycle
        const amt = Math.min(gain * 0.5, 2000);
        if (amt < 500) return 0;
        good = 0; nPay++; cycleStart = balance - amt;
        return amt;
      };
      const r = runPhase(list, { ...RL, ...rules, from: s, until: s + 365 * DAY, payout });
      const pts = r.paid;
      if (pts.length) { const d = (pts[0].t - s) / DAY; firsts.push(d); if (d <= 30) p30++; if (d <= 60) p60++; }
      paid6 += pts.filter((p) => p.t - s <= 182 * DAY).reduce((x, p) => x + p.amount, 0) * 0.9;
      paid12 += pts.reduce((x, p) => x + p.amount, 0) * 0.9;
      if (r.outcome === 'maxloss' || r.outcome === 'daily') lost++;
    }
    firsts.sort((x, y) => x - y);
    const pc = (x) => `${((x / n) * 100).toFixed(0).padStart(3)} %`;
    const med = firsts.length >= n / 2 ? `${firsts[Math.floor(n / 2) - (n - firsts.length)]?.toFixed(0) ?? '—'} j` : '—';
    return `1er retrait ≤30 j ${pc(p30)} · ≤60 j ${pc(p60)} · médiane ${med.padStart(5)} · retraits 6 mois ${Math.round(paid6 / n).toLocaleString('fr-FR').padStart(6)} $ · 12 mois ${Math.round(paid12 / n).toLocaleString('fr-FR').padStart(6)} $ · perdus ${pc(lost)}`;
  };
  const PER = { 'nov. 24–26 (tout)': [A0, Infinity, true, DAY], '2020–24 (journalier)': [Y(2020), Y(2025), false, 7 * DAY] };
  const VAR = [
    ['risque financé actuel', 1, {}], ['sans marge (FUNDED_CUSHION=0)', 1, { sizer: RULES[cfg.ftmoSizing] }], ['ancien modèle (40 micros, sans blocage)', 1, { scaling: null, lockOnPayout: false }], ['× 0,5', 0.5, {}], ['× 0,75', 0.75, {}], ['× 1,5', 1.5, {}], ['× 2', 2, {}], ['× 3', 3, {}],
    ['arrêt après 1 perte', 1, { maxLossesPerDay: 1 }], ['plafond jour 150 $', 1, { dayProfitCapUsd: 150 }], ['plafond jour 300 $', 1, { dayProfitCapUsd: 300 }],
    ['plafond jour 500 $', 1, { dayProfitCapUsd: 500 }], ['× 2 + plafond 300 $ + 1 perte', 2, { dayProfitCapUsd: 300, maxLossesPerDay: 1 }],
    ['× 1,5 + plafond 300 $', 1.5, { dayProfitCapUsd: 300 }], ['× 2 + plafond 500 $', 2, { dayProfitCapUsd: 500 }],
  ];
  for (const [pname, per] of Object.entries(PER)) {
    console.log(`\n=== Lucid financé · ${pname} ===`);
    for (const [name, mul, rules] of VAR) console.log(`${name.padEnd(30)} ${study(mul, rules, per)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
