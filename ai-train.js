#!/usr/bin/env node
/**
 * Entraînement et test de l'IA validatrice (src/aiFilter.js) sur les trades des stratégies du compte FTMO.
 *   1. entraînement 2009–2016, choix du seuil sur 2017–2019 (réussite du challenge en moins d'un an) ;
 *   2. ré-entraînement 2009–2019, VÉRIFICATION sur 2020–2026 et nov. 2024 → nov. 2026 (jamais vus) ;
 *   3. modèle final entraîné sur tout l'historique, seuil = 20 % des signaux refusés (REFUSE) → src/aiModel.json
 *      (en direct : FTMO_AI=observe donne seulement l'avis, FTMO_AI=block refuse les signaux sous le seuil).
 *
 *   npm run ai-train
 */
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { featurize, contextOf, CTX_NAMES, train, trainR, predict, NAMES: BASE_NAMES, MODEL_FILE, rOf } = require('./src/aiFilter');
// CTX=0 : sans le contexte de marché (tendance, élan, volatilité, VIX)
const CTX = process.env.CTX !== '0';
const NAMES = CTX ? [...BASE_NAMES, ...CTX_NAMES] : BASE_NAMES;
// Défaut : probabilité de gain (logistique) ; KIND=r : gain attendu en R (ridge)
const fit = process.env.KIND === 'r' ? trainR : train;
// Part des signaux refusée en direct (seuil = ce quantile des scores des 2 dernières années)
const REFUSE = Number(process.env.REFUSE || 0.2);

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;

(async () => {
  const { all, q5, daily, vix } = await buildTrades(cfg, CACHE);
  featurize(all, CTX ? contextOf(Object.fromEntries(Object.entries(daily).map(([k, d]) => [k, d.c])), vix) : null);
  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, horizonDays: 365 };
  const noNasIntra = (t) => !(t.intraday && t.market === 'nas100');
  const span = (a, b, f = noNasIntra) => all.filter((t) => t.entryT >= a && t.entryT < b && f(t));
  const chal = (list, a) => challengeStats(list, { ...opts, start: a });
  const pass = (c) => (c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j, échecs jour/max ${c.failedDaily}/${c.failedMax})` : '—');
  const auc = (list, m) => {
    const s = list.map((t) => [predict(m, t.x), t.pnlPct > 0]).sort((a, b) => a[0] - b[0]);
    let pos = 0;
    let rank = 0;
    s.forEach(([, w], i) => { if (w) { pos++; rank += i + 1; } });
    const neg = s.length - pos;
    return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
  };
  const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
  const describe = (list, m, min) => {
    const ok = list.filter((t) => predict(m, t.x) >= min);
    const no = list.filter((t) => predict(m, t.x) < min);
    return `AUC ${auc(list, m).toFixed(3)} · ${no.length}/${list.length} refusés (${((no.length / list.length) * 100).toFixed(0)} %) · R moyen gardés ${mean(ok.map(rOf)).toFixed(3)} / refusés ${mean(no.map(rOf)).toFixed(3)} · gagnants gardés ${((ok.filter((t) => t.pnlPct > 0).length / Math.max(1, ok.length)) * 100).toFixed(0)} % / refusés ${((no.filter((t) => t.pnlPct > 0).length / Math.max(1, no.length)) * 100).toFixed(0)} %`;
  };

  // 1. Choix du seuil
  const t0 = Y(2009) + 60 * 86400;
  const tr1 = span(t0, Y(2017));
  const val = span(Y(2017), Y(2020));
  const m1 = fit(tr1);
  const ps = val.map((t) => predict(m1, t.x)).sort((a, b) => a - b);
  console.log(`=== IA validatrice · ${F.label} · réussite < 1 an (médiane) ===`);
  console.log(`1. Entraînement 2009–2016 (${tr1.length} trades), choix du seuil sur 2017–2019 (${val.length} trades)`);
  console.log(`   sans IA : ${pass(chal(val, Y(2017)))}`);
  let best = { min: 0, v: chal(val, Y(2017)).passRate, q: 0 };
  for (const q of [0.1, 0.2, 0.3, 0.4, 0.5]) {
    const min = ps[Math.floor(q * ps.length)];
    const c = chal(val.filter((t) => predict(m1, t.x) >= min), Y(2017));
    console.log(`   refuse les ${(q * 100).toFixed(0)} % les moins bons (score < ${min.toFixed(3)}) : ${pass(c)} · ${describe(val, m1, min)}`);
    if (c.passRate > best.v + 1) best = { min, v: c.passRate, q };
  }
  console.log(`   → seuil retenu : ${best.q ? `score ≥ ${best.min.toFixed(3)} (refuse ≈ ${(best.q * 100).toFixed(0)} %)` : 'aucun (l\'IA n\'améliore pas la réussite sur 2017–2019)'}`);

  // 2. Vérification
  const tr2 = span(t0, Y(2020));
  const m2 = fit(tr2);
  console.log(`\n2. Entraînement 2009–2019 (${tr2.length} trades), vérification :`);
  const checks = [['2020–2026', span(Y(2020), Infinity), Y(2020)]];
  if (q5) checks.push(['nov. 2024 → nov. 2026 (avec Nasdaq intraday)', span(q5[0].t + 30 * 86400, Infinity, () => true), q5[0].t + 30 * 86400]);
  const out = {};
  for (const [lbl, list, a] of checks) {
    const without = chal(list, a);
    const withAi = best.q ? chal(list.filter((t) => predict(m2, t.x) >= best.min), a) : null;
    out[lbl] = { without: without.passRate, with: withAi?.passRate };
    console.log(`   ${lbl}`);
    console.log(`     sans IA : ${pass(without)}`);
    if (withAi) console.log(`     avec IA : ${pass(withAi)}`);
    console.log(`     ${describe(list, m2, best.q ? best.min : -Infinity)}`);
    // Pour information (non utilisé pour choisir) : chaque seuil de l'étape 1 appliqué ici
    const qs = list.map((t) => predict(m2, t.x)).sort((x, z) => x - z);
    for (const q of [0.1, 0.2, 0.3]) {
      const min = qs[Math.floor(q * qs.length)];
      console.log(`     (info) refuse ${(q * 100).toFixed(0)} % : ${pass(chal(list.filter((t) => predict(m2, t.x) >= min), a))} · ${describe(list, m2, min)}`);
    }
  }
  console.log('\n   Poids du modèle (caractéristiques normalisées ; + = plus de chances de gagner) :');
  console.log(`   ${m2.w.map((w, j) => `${NAMES[j]} ${w >= 0 ? '+' : ''}${w.toFixed(2)}`).join(' · ')}`);

  // Glissant : chaque année entraînée sur toutes les années d'avant, 20 % des signaux refusés
  console.log('\n   Test glissant (chaque année jugée par un modèle entraîné sur les années précédentes, 20 % refusés) :');
  let better = 0;
  let years = 0;
  for (let yr = 2012; yr <= 2026; yr++) {
    const hist = span(t0, Y(yr));
    const cur = span(Y(yr), Y(yr + 1), yr >= 2025 ? () => true : noNasIntra);
    if (cur.length < 100) continue;
    const m = fit(hist);
    const qs = cur.map((t) => predict(m, t.x)).sort((x, z) => x - z);
    const min = qs[Math.floor(0.2 * qs.length)];
    const ok = cur.filter((t) => predict(m, t.x) >= min).map(rOf);
    const no = cur.filter((t) => predict(m, t.x) < min).map(rOf);
    years++;
    if (mean(no) < mean(ok)) better++;
    console.log(`     ${yr} : R moyen gardés ${mean(ok).toFixed(3)} / refusés ${mean(no).toFixed(3)} ${mean(no) < mean(ok) ? '✔' : '✘'}`);
  }
  console.log(`     → l'IA refuse de moins bons trades ${better} années sur ${years}`);

  // 3. Modèle final
  const mF = fit(span(t0, Infinity, () => true));
  // Seuil en direct : refuse ≈ REFUSE des signaux (quantile des scores des 2 dernières années). Non choisi sur
  // 2017–2019 (où l'IA n'aidait pas) : à juger d'abord en observation (FTMO_AI=observe) avant de bloquer.
  const recent = all.filter((t) => t.entryT >= Date.now() / 1000 - 2 * 365 * 86400).map((t) => predict(mF, t.x)).sort((x, z) => x - z);
  const min = recent.length ? recent[Math.floor(REFUSE * recent.length)] : -Infinity;
  const model = { ...mF, min, refuse: REFUSE, ctx: CTX, names: NAMES, trainedOn: all.length, date: new Date().toISOString().slice(0, 10), check: out };
  fs.writeFileSync(MODEL_FILE, JSON.stringify(model));
  console.log(`\n3. Modèle final (tous les trades) → ${path.relative(__dirname, MODEL_FILE)} · seuil ${Number.isFinite(model.min) ? model.min.toFixed(3) : 'aucun'}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
