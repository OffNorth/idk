#!/usr/bin/env node
/**
 * Ré-entraînement de l'IA validatrice avec TOUTES les stratégies suivies (compte FTMO + comptes Lucid : variantes
 * « objectif 0,5 R », argent, Dow, Russell, S&P, or g_nypdl…), npm run ai-retrain (27/11/2026).
 * Comparaison loyale, hors échantillon : deux modèles entraînés sur 2009–2019,
 *   A = comme le modèle actuel (trades des stratégies FTMO seulement),
 *   B = toutes les stratégies suivies,
 * jugés sur 2020–2026 et nov. 2024 → nov. 2026 (Nasdaq intraday compris), sur l'ensemble des stratégies suivies
 * aujourd'hui : AUC, R moyen des signaux gardés / refusés (20 % refusés), réussite FTMO, + test glissant année par année.
 * B remplace le modèle seulement s'il fait au moins aussi bien partout et mieux quelque part (WRITE=1 pour écrire).
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { featurize, contextOf, CTX_NAMES, train, predict, NAMES, MODEL_FILE, rOf } = require('./src/aiFilter');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const REFUSE = 0.2;
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
const auc = (list, m) => {
  const s = list.map((t) => [predict(m, t.x), t.pnlPct > 0]).sort((a, b) => a[0] - b[0]);
  let pos = 0, rank = 0;
  s.forEach(([, w], i) => { if (w) { pos++; rank += i + 1; } });
  const neg = s.length - pos;
  return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
};

(async () => {
  const ftmo = await buildTrades(cfg, CACHE);
  const both = await buildTrades(cfg, CACHE, { withLucid: true });
  const ctx = contextOf(Object.fromEntries(Object.entries(both.daily).map(([k, d]) => [k, d.c])), both.vix);
  featurize(both.all, ctx);
  const ftmoSids = new Set(ftmo.all.map((t) => t.sid));
  const ALL = both.all;
  const FT = ALL.filter((t) => ftmoSids.has(t.sid)); // mêmes trades (caractéristiques calculées sur l'ensemble)
  console.log(`Trades : FTMO ${FT.length} · toutes stratégies suivies ${ALL.length} (${new Set(ALL.map((t) => t.sid)).size} stratégies, ${new Set(FT.map((t) => t.sid)).size} côté FTMO)`);
  const t0 = Y(2009) + 60 * 86400;
  const before = (l, y) => l.filter((t) => t.entryT >= t0 && t.entryT < Y(y));
  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, horizonDays: 365 };
  const describe = (list, m, ref) => {
    const qs = ref.map((t) => predict(m, t.x)).sort((a, b) => a - b);
    const min = qs[Math.floor(REFUSE * qs.length)];
    const ok = list.filter((t) => predict(m, t.x) >= min), no = list.filter((t) => predict(m, t.x) < min);
    return { auc: auc(list, m), keptR: mean(ok.map(rOf)), refusedR: mean(no.map(rOf)), gap: mean(ok.map(rOf)) - mean(no.map(rOf)), min, ok };
  };
  const mA = train(before(FT, 2020)), mB = train(before(ALL, 2020));
  const tests = [['2020–2026 (toutes stratégies suivies)', ALL.filter((t) => t.entryT >= Y(2020) && !(t.intraday && t.market !== 'gold' && t.entryT < both.q5[0].t))],
    ['nov. 2024 → nov. 2026 (Nasdaq intraday compris)', ALL.filter((t) => t.entryT >= both.q5[0].t + 30 * 86400)],
    ['2020–2026, stratégies FTMO', FT.filter((t) => t.entryT >= Y(2020))]];
  const res = {};
  for (const [lbl, list] of tests) {
    const ref = before(ALL, 2020).filter((t) => t.entryT >= Y(2018));
    const a = describe(list, mA, ref), b = describe(list, mB, ref);
    res[lbl] = { a, b };
    console.log(`\n${lbl} (${list.length} trades, R moyen sans IA ${mean(list.map(rOf)).toFixed(3)})`);
    for (const [n, r] of [['A actuel (FTMO seul)', a], ['B toutes stratégies', b]]) console.log(`   ${n.padEnd(22)} AUC ${r.auc.toFixed(3)} · R moyen gardés ${r.keptR.toFixed(3)} / refusés ${r.refusedR.toFixed(3)} (écart ${r.gap.toFixed(3)})`);
  }
  const lst = tests[0][1];
  const pass = (l) => challengeStats(l, { ...opts, start: Y(2020) })?.passRate ?? NaN;
  const pNo = pass(lst), pA = pass(res[tests[0][0]].a.ok), pB = pass(res[tests[0][0]].b.ok);
  console.log(`\nRéussite FTMO < 1 an sur 2020–2026 (journalières + intraday or) : sans IA ${pNo.toFixed(0)} % · A ${pA.toFixed(0)} % · B ${pB.toFixed(0)} %`);
  // Glissant
  let winsA = 0, winsB = 0, bBetter = 0, n = 0;
  console.log('\nTest glissant (chaque année jugée par des modèles entraînés sur les années d\'avant, 20 % refusés) :');
  for (let yr = 2013; yr <= 2026; yr++) {
    const cur = ALL.filter((t) => t.entryT >= Y(yr) && t.entryT < Y(yr + 1));
    if (cur.length < 150) continue;
    const a = describe(cur, train(before(FT, yr)), before(ALL, yr).filter((t) => t.entryT >= Y(yr - 2)));
    const b = describe(cur, train(before(ALL, yr)), before(ALL, yr).filter((t) => t.entryT >= Y(yr - 2)));
    n++; if (a.gap > 0) winsA++; if (b.gap > 0) winsB++; if (b.gap >= a.gap) bBetter++;
    console.log(`   ${yr} : A écart ${a.gap.toFixed(3)} (AUC ${a.auc.toFixed(3)}) · B écart ${b.gap.toFixed(3)} (AUC ${b.auc.toFixed(3)}) ${b.gap >= a.gap ? '✔ B' : ''}`);
  }
  console.log(`   → A trie dans le bon sens ${winsA}/${n} années, B ${winsB}/${n} ; B au moins aussi bon que A ${bBetter}/${n} années`);
  const k = Object.values(res);
  const ok = k.every((r) => r.b.gap >= r.a.gap - 0.005 && r.b.auc >= r.a.auc - 0.003) && k.some((r) => r.b.gap > r.a.gap + 0.005 || r.b.auc > r.a.auc + 0.003) && pB >= pA - 0.5 && winsB >= winsA;
  console.log(`\nVerdict : ${ok ? '✅ B meilleur (ou égal partout et mieux quelque part)' : '✘ B ne bat pas A : modèle actuel gardé'}`);
  if (ok && process.env.WRITE === '1') {
    const mF = train(ALL.filter((t) => t.entryT >= t0));
    const recent = ALL.filter((t) => t.entryT >= Date.now() / 1000 - 2 * 365 * 86400).map((t) => predict(mF, t.x)).sort((x, z) => x - z);
    const model = { ...mF, min: recent[Math.floor(REFUSE * recent.length)], refuse: REFUSE, ctx: true, names: [...NAMES, ...CTX_NAMES], trainedOn: ALL.length, strategies: new Set(ALL.map((t) => t.sid)).size,
      date: new Date().toISOString().slice(0, 10), check: Object.fromEntries(Object.entries(res).map(([l, r]) => [l, { aucA: +r.a.auc.toFixed(3), aucB: +r.b.auc.toFixed(3), gapA: +r.a.gap.toFixed(3), gapB: +r.b.gap.toFixed(3) }])) };
    fs.writeFileSync(MODEL_FILE, JSON.stringify(model));
    console.log(`Modèle écrit → ${path.relative(__dirname, MODEL_FILE)} (${ALL.length} trades, seuil ${model.min.toFixed(3)})`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
