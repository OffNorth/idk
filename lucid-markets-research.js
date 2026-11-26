#!/usr/bin/env node
/**
 * Nouveaux marchés pour Lucid (npm run lucid-markets) — seulement des contrats de la liste officielle Lucid (CME, CBOT,
 * NYMEX, COMEX, nov. 2026 : pas de CAC 40, DAX ni indice européen, pas de micro-devises, pas de taux, pas de crypto) :
 *   cuivre HG, platine PL, gaz naturel NG, maïs ZC, soja ZS, blé ZW, huile de soja ZL, tourteau ZM, bovins LE, porcs HE
 *   (bougies 1 h Yahoo, 2 ans) ; devises en contrat standard 6A, 6B, 6C, 6E, 6J, 6S, 6N (Polygon 5 min, 2 ans) ;
 *   + journalier Yahoo depuis 2000 pour tous. (Nikkei NKD : 5 $ × 56 000 ≈ 280 000 $ par contrat, trop gros pour 50K.)
 * Taille réelle du contrat et frais Lucid (commission × 2 + 1 tick de glissement par côté).
 *   1. Intraday : cassures d'ouverture, Crabel NR4 / NR7, Williams 0,5 / 0,7 à l'ouverture de leur séance (+ ouverture de
 *      Londres pour les devises), avec ou sans objectif 0,5 / 0,75 R ; stable = > +0,02 R les deux années, ≤ 8 pertes de suite.
 *   2. Journalier : RSI 2, IBS, 3 baisses, Double 7, RSI cumulé ; stable = > +0,02 R sur 2000–09, 2010–17, 2018–26.
 *   3. Ajout au compte Lucid actuel : réussite < 1 an (2009–19 | 2020–26 | nov. 24–26) et, l'objectif étant 2 semaines,
 *      réussite en ≤ 14 j / ≤ 30 j (départ chaque jour ouvré, nov. 24–26). Ajout une à une, gardé si rien ne baisse.
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, runPhase, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { computeAll } = require('./src/indicators');
const { cachedYahoo } = require('./src/yahoo');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { breakout, crabelNR, williamsVB, withTp, hm } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const DAY = 86400;
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const sgn = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

function sessionSet(pfx, { tz, open, close, entryEnd, exitAt, lens = [15, 30, 60], nrLen = 30 }) {
  const S = { market: 'gold', tz, s: open, e: close, entryEnd, exitAt };
  return [
    ...lens.map((len) => breakout({ id: `${pfx}_orb${len}`, name: `${pfx} cassure ${len} min`, tz, start: open, len, entryEnd, exitAt })),
    crabelNR({ ...S, id: `${pfx}_crabel4`, name: `${pfx} Crabel NR4`, nr: 4, len: nrLen }),
    crabelNR({ ...S, id: `${pfx}_crabel7`, name: `${pfx} Crabel NR7`, nr: 7, len: nrLen }),
    williamsVB({ ...S, id: `${pfx}_wvb05`, name: `${pfx} Williams 0,5`, k: 0.5 }),
    williamsVB({ ...S, id: `${pfx}_wvb07`, name: `${pfx} Williams 0,7`, k: 0.7 }),
  ];
}
const withTps = (list) => list.flatMap((s) => [s, withTp(s, 0.5, `${s.id}_t05`, `${s.name} (0,5 R)`), withTp(s, 0.75, `${s.id}_t075`, `${s.name} (0,75 R)`)]);
// Bougies 1 h (Yahoo) : cassure de la 1re heure, Crabel sur 60 min, Williams ; heures de New York
const hourly = (pfx, open, close) => withTps(sessionSet(pfx, { tz: 'ny', open, close, entryEnd: Math.min(close - 60, open + hm(3)), exitAt: close - 60, lens: [60], nrLen: 60 }));
// Devises (5 min) : ouverture de Londres (8 h Londres) et de New York (8 h NY)
const fx = (pfx) => withTps([
  ...sessionSet(`${pfx}l`, { tz: 'lon', open: hm(8), close: hm(16, 30), entryEnd: hm(12), exitAt: hm(16, 25) }),
  ...sessionSet(`${pfx}n`, { tz: 'ny', open: hm(8), close: hm(16), entryEnd: hm(12), exitAt: hm(15, 55) }),
]);

// usd(p) : valeur d'un contrat en $ au prix p (prix de la source) ; fee : commission × 2 + 2 ticks ; yd : symbole journalier
const MK = {
  copper: { name: 'Cuivre (HG)', h1: 'HGF', yd: 'HG=F', usd: (p) => p * 25_000, fee: 4.6 + 25, strat: hourly('hg', hm(8), hm(13, 30)) },
  platinum: { name: 'Platine (PL)', h1: 'PLF', yd: 'PL=F', usd: (p) => p * 50, fee: 4.6 + 10, strat: hourly('pl', hm(8), hm(13, 30)) },
  natgas: { name: 'Gaz naturel (NG)', h1: 'NGF', yd: 'NG=F', usd: (p) => p * 10_000, fee: 4 + 20, strat: hourly('ng', hm(9), hm(14, 30)) },
  corn: { name: 'Maïs (ZC)', h1: 'ZCF', yd: 'ZC=F', usd: (p) => (p / 100) * 5000, fee: 5.6 + 25, strat: hourly('zc', hm(9), hm(14, 20)) },
  soy: { name: 'Soja (ZS)', h1: 'ZSF', yd: 'ZS=F', usd: (p) => (p / 100) * 5000, fee: 5.6 + 25, strat: hourly('zs', hm(9), hm(14, 20)) },
  wheat: { name: 'Blé (ZW)', h1: 'ZWF', yd: 'ZW=F', usd: (p) => (p / 100) * 5000, fee: 5.6 + 25, strat: hourly('zw', hm(9), hm(14, 20)) },
  soyoil: { name: 'Huile de soja (ZL)', h1: 'ZLF', yd: 'ZL=F', usd: (p) => (p / 100) * 60_000, fee: 5.6 + 12, strat: hourly('zl', hm(9), hm(14, 20)) },
  soymeal: { name: 'Tourteau de soja (ZM)', h1: 'ZMF', yd: 'ZM=F', usd: (p) => p * 100, fee: 5.6 + 20, strat: hourly('zm', hm(9), hm(14, 20)) },
  cattle: { name: 'Bovins (LE)', h1: 'LEF', yd: 'LE=F', usd: (p) => (p / 100) * 40_000, fee: 5.6 + 20, strat: hourly('le', hm(9), hm(14)) },
  hogs: { name: 'Porcs (HE)', h1: 'HEF', yd: 'HE=F', usd: (p) => (p / 100) * 40_000, fee: 5.6 + 20, strat: hourly('he', hm(9), hm(14)) },
  aud: { name: 'Dollar australien (6A)', poly: 'C:AUDUSD', yd: '6A=F', usd: (p) => 100_000 * p, fee: 4.8 + 10, strat: fx('aud') },
  gbp: { name: 'Livre (6B)', poly: 'C:GBPUSD', yd: '6B=F', usd: (p) => 62_500 * p, fee: 4.8 + 12.5, strat: fx('gbp') },
  cad: { name: 'Dollar canadien (6C)', poly: 'C:USDCAD', yd: '6C=F', usd: (p) => 100_000 / p, fee: 4.8 + 10, strat: fx('cad') },
  eur: { name: 'Euro (6E)', poly: 'C:EURUSD', yd: '6E=F', usd: (p) => 125_000 * p, fee: 4.8 + 12.5, strat: fx('eur') },
  jpy: { name: 'Yen (6J)', poly: 'C:USDJPY', yd: '6J=F', usd: (p) => 12_500_000 / p, fee: 4.8 + 12.5, strat: fx('jpy') },
  chf: { name: 'Franc suisse (6S)', poly: 'C:USDCHF', yd: '6S=F', usd: (p) => 125_000 / p, fee: 4.8 + 12.5, strat: fx('chf') },
  nzd: { name: 'Dollar néo-zélandais (6N)', poly: 'C:NZDUSD', yd: '6N=F', usd: (p) => 100_000 * p, fee: 4.8 + 10, strat: fx('nzd') },
};
// Journalier : le prix Yahoo des futures (6J=F en $ par yen, ZC=F en cents…) → valeur du contrat
const DUSD = { copper: (p) => p * 25_000, platinum: (p) => p * 50, natgas: (p) => p * 10_000, corn: (p) => p * 50, soy: (p) => p * 50, wheat: (p) => p * 50, soyoil: (p) => p * 600, soymeal: (p) => p * 100,
  cattle: (p) => p * 400, hogs: (p) => p * 400, aud: (p) => p * 100_000, gbp: (p) => p * 62_500, cad: (p) => p * 100_000, eur: (p) => p * 125_000, jpy: (p) => p * 12_500_000, chf: (p) => p * 125_000, nzd: (p) => p * 100_000 };
const DAILY = ['rsi2', 'ibs', 'down3', 'double7', 'cumrsi'];

(async () => {
  const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
  const vix = (await cachedYahoo(CACHE, '^VIX', '1d', {}, 72)).filter((k) => k.c > 0);
  const report = [];
  for (const [id, M] of Object.entries(MK)) {
    if (ONLY && !ONLY.includes(id)) continue;
    let bars = null; let bar = 300;
    try {
      if (M.h1) { bars = JSON.parse(fs.readFileSync(path.join(CACHE, `yahoo1h-${M.h1}.json`), 'utf8')).filter((k) => k.c > 0 && k.t >= Y(2024) + 320 * DAY); bar = 3600; }
      else bars = await polygonBars(CACHE, M.poly, 5, '2024-11-18', { maxAgeH: Infinity });
    } catch { /* pas de données */ }
    const intra = [];
    if (bars?.length) {
      const t0 = bars[0].t + 30 * DAY; const t1 = bars[bars.length - 1].t; const mid = (t0 + t1) / 2;
      const days = ((t1 - t0) / DAY) * (5 / 7);
      for (const s of M.strat) {
        let l;
        try { l = backtest(s, bars, { size: 1000, feePct: 0.003, financingPct: 3, barSec: bar, market: 'gold' }).list.filter((t) => t.entryT >= t0); } catch { continue; }
        const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const st = rStats(l);
        const ok = a.expR > 0.02 && b.expR > 0.02 && a.n >= 25 && b.n >= 25 && st.worstRun <= 8;
        intra.push({ sid: s.id, a, b, st, ok, perDay: l.length / days, l: l.map((t) => ({ ...t, sid: `${id}:${s.id}`, market: id, intraday: true, contractUsd: M.usd(t.entry), contractFee: M.fee })) });
      }
    }
    const daily = [];
    const d = await cachedYahoo(CACHE, M.yd, '1d', {}, 72).then((x) => x.filter((k) => k.c > 0)).catch(() => null);
    if (d && d.length > 1500) {
      const ind = computeAll(d, d, 86400, null, vix, {});
      const sl = [[Y(2000), Y(2010)], [Y(2010), Y(2018)], [Y(2018), Infinity]];
      for (const sid of DAILY) {
        const s = selectStrategies([sid])[0];
        const l = backtest(s, d, { size: 1000, feePct: 0.01, financingPct: 3, barSec: 86400, ind, daily: d, vix }).list;
        const per = sl.map(([a, b]) => rStats(l.filter((t) => t.entryT >= a && t.entryT < b)));
        daily.push({ sid, per, ok: per.every((p) => p.expR > 0.02 && p.n >= 15), l: l.map((t) => ({ ...t, sid: `${id}:${sid}`, market: id, intraday: false, contractUsd: DUSD[id](t.entry), contractFee: M.fee })) });
      }
    }
    report.push({ id, M, intra, daily });
    console.log(`\n=== ${M.name} · 1 contrat ≈ ${bars?.length ? Math.round(M.usd(bars[bars.length - 1].c)).toLocaleString('fr-FR') : '—'} $ ===`);
    for (const x of intra.filter((q) => q.ok)) console.log(`  ✅ intraday ${x.sid.padEnd(16)} ${sgn(x.a.expR)} / ${sgn(x.b.expR)} R · ${x.st.win.toFixed(0)} % gagnants · série ${x.st.worstRun} · ${x.perDay.toFixed(2)} /j`);
    console.log(`  intraday : ${intra.filter((q) => q.ok).length} / ${intra.length} stables`);
    for (const x of daily) console.log(`  ${x.ok ? '✅' : '  '} journalier ${x.sid.padEnd(8)} ${x.per.map((p) => `${sgn(p.expR)} (${p.n})`).join(' | ')} R`);
  }
  if (process.env.NO_ACCOUNTS) return;

  // Compte Lucid actuel (risque intraday de l'évaluation, journalières S&P, argent, Dow)
  const { all, q5 } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true, lucidSplit: false }, 'lucid');
  const IB = { nas100: [qs, 82, 2.5] };
  for (const [m, T, mult, fee] of [['silver', 'SLV', 1075, 3.5], ['dow', 'DIA', 50, 2.5]]) IB[m] = [nySession(await polygonBars(CACHE, T, 5, '2024-11-18', { maxAgeH: Infinity })), mult, fee];
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const intraBase = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && IB[m]; }).flatMap((k) => {
    const [b, mult, fee] = IB[k.split(':')[0]]; const s = strat(k)[1];
    return backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, b, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
      .map((t) => ({ ...t, sid: k, market: k.split(':')[0], intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  });
  const base = [...all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market !== 'gold')), ...intraBase].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) }));
  const ir = A.riskOf('nas100', selectStrategies(['n_mom10_t05'])[0]); const dr = cfg.ftmoRisk * cfg.lucidRiskMul;
  const sizer = RULES[cfg.ftmoSizing];
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer };
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const evalL = (extra) => {
    const list = [...base, ...extra.map((t) => ({ ...t, riskPct: t.intraday ? ir : dr }))];
    const out = Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      const c = challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...RL });
      return { pass: c.passRate, days: c.medianDays };
    });
    // ≤ 14 j / ≤ 30 j, départ chaque jour ouvré sur nov. 24–26
    const l = list.filter((t) => t.entryT >= A0).sort((x, y) => x.entryT - y.entryT);
    const end = Math.max(...l.map((t) => t.entryT)) - 60 * DAY;
    let n = 0; let p14 = 0; let p30 = 0; let f14 = 0;
    for (let s = A0; s < end; s += DAY) {
      const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
      n++;
      const r = runPhase(l.filter((t) => t.entryT >= s && t.entryT < s + 60 * DAY), { ...RL, from: s });
      const dd = (r.at - s) / DAY;
      if (r.outcome === 'target' && dd <= 14) p14++;
      if (r.outcome === 'target' && dd <= 30) p30++;
      if ((r.outcome === 'daily' || r.outcome === 'maxloss') && dd <= 14) f14++;
    }
    return { per: out, p14: (p14 / n) * 100, p30: (p30 / n) * 100, f14: (f14 / n) * 100 };
  };
  const fmt = (r) => `${r.per.map((p) => `${p.pass.toFixed(0).padStart(3)} % (${p.days ? p.days.toFixed(0) : '—'} j)`).join(' | ')} || ≤14 j ${r.p14.toFixed(0).padStart(2)} % · ≤30 j ${r.p30.toFixed(0).padStart(2)} % · échec ≤14 j ${r.f14.toFixed(0)} %`;
  const notWorse = (r, ref) => r.per.every((p, i) => p.pass >= ref.per[i].pass - 0.5) && r.p14 >= ref.p14 - 0.5;
  const better = (r, ref) => notWorse(r, ref) && (r.per.some((p, i) => p.pass > ref.per[i].pass + 0.5) || r.p14 > ref.p14 + 0.5 || r.p30 > ref.p30 + 0.5);
  const ref = evalL([]);
  console.log('\n=== Compte Lucid : réussite < 1 an (délai) 2009–19 | 2020–26 | nov. 24–26 || nov. 24–26 départ chaque jour ===');
  console.log(`${'actuel'.padEnd(34)} ${fmt(ref)}`);
  const cands = [];
  for (const r of report) {
    for (const [what, ex] of [['intraday', r.intra.filter((q) => q.ok).flatMap((q) => q.l)], ['journalier', r.daily.filter((q) => q.ok).flatMap((q) => q.l)]]) {
      if (!ex.length) continue;
      const res = evalL(ex);
      const ok = better(res, ref);
      console.log(`${ok ? '✅' : '  '} ${(r.M.name + ' ' + what).padEnd(32)} ${fmt(res)}`);
      if (ok) cands.push({ tag: `${r.M.name} ${what}`, ex, score: res.per.reduce((a, p) => a + p.pass, 0) + 2 * res.p14 });
    }
  }
  console.log('\n=== Ensemble (ajout une à une, meilleure d\'abord) ===');
  let acc = []; let accRes = ref;
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    const res = evalL([...acc, ...c.ex]);
    const ok = better(res, accRes);
    console.log(`${ok ? '✅' : '  '} + ${c.tag.padEnd(30)} ${fmt(res)}`);
    if (ok) { acc = [...acc, ...c.ex]; accRes = res; }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
