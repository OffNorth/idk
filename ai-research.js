#!/usr/bin/env node
/**
 * Amélioration de l'IA validatrice (npm run ai-research) : l'IA aide-t-elle VRAIMENT à réussir FTMO et Lucid, et
 * comment la rendre utile ? Tout est jugé « hors échantillon » : chaque année est notée par un modèle entraîné
 * UNIQUEMENT sur les trades fermés avant le 1er janvier de cette année (comme en direct).
 *
 * Modèles :
 *   - logistique : celui du bot (probabilité de gain, 21 caractéristiques dont le contexte de marché) ;
 *   - ridge R    : gain attendu en R au lieu de « gagnant / perdant » ;
 *   - arbres     : boosting d'arbres de profondeur 2 (interactions : stratégie en forme × VIX, heure × marché…),
 *                  mêmes caractéristiques + série de pertes de la stratégie.
 * Façons d'utiliser le score :
 *   - refuser les x % les moins bons (seuil = quantile des scores des 2 dernières années d'entraînement ; le bot
 *     refuse 20 % aujourd'hui) ;
 *   - doser le risque au lieu de refuser : × 0,5 pour les 30 % les moins bons, × 1,5 pour les 30 % les meilleurs
 *     (risque moyen inchangé).
 * Mesures : AUC hors échantillon, R moyen des trades gardés / refusés, et réussite FTMO (réglage actuel : intraday × 2,
 * journée gérée, stop suiveur) et Lucid (réglage actuel) sur 2009–19 | 2020–26 | nov. 24–26, + Lucid départ chaque
 * jour ouvré sur nov. 24–26 (réussie ≤ 14 j / ≤ 30 j, échouée ≤ 14 j).
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, runPhase, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { featurize, contextOf, train, trainR, predict, rOf } = require('./src/aiFilter');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const DAY = 86400;
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);

/* ---------- Boosting d'arbres (profondeur 2, perte logistique, histogrammes) ---------- */
function gbmTrain(X, y, { trees = 120, lr = 0.05, minLeaf = 150, bins = 16 } = {}) {
  const n = X.length; const d = X[0].length;
  // Seuils par quantiles
  const cuts = [];
  for (let j = 0; j < d; j++) {
    const v = X.map((x) => x[j]).sort((a, b) => a - b);
    const c = [];
    for (let k = 1; k < bins; k++) { const q = v[Math.floor((k / bins) * n)]; if (!c.length || q > c[c.length - 1]) c.push(q); }
    cuts.push(c);
  }
  const B = X.map((x) => x.map((v, j) => { const c = cuts[j]; let lo = 0, hi = c.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v > c[m]) lo = m + 1; else hi = m; } return lo; }));
  const base = Math.log((mean(y) + 1e-6) / (1 - mean(y) + 1e-6));
  const F = new Float64Array(n).fill(base);
  const model = { base, lr, cuts, trees: [] };
  const sig = (z) => 1 / (1 + Math.exp(-z));
  // Meilleure coupure d'un ensemble d'indices
  const split = (idx, g, h) => {
    let best = null;
    let G = 0, H = 0; for (const i of idx) { G += g[i]; H += h[i]; }
    for (let j = 0; j < d; j++) {
      const nb = cuts[j].length + 1;
      const gs = new Float64Array(nb), hs = new Float64Array(nb), cs = new Int32Array(nb);
      for (const i of idx) { const b = B[i][j]; gs[b] += g[i]; hs[b] += h[i]; cs[b]++; }
      let gl = 0, hl = 0, cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += gs[b]; hl += hs[b]; cl += cs[b];
        const cr = idx.length - cl;
        if (cl < minLeaf || cr < minLeaf) continue;
        const gain = (gl * gl) / (hl + 1) + ((G - gl) ** 2) / (H - hl + 1) - (G * G) / (H + 1);
        if (!best || gain > best.gain) best = { j, b, gain };
      }
    }
    return best;
  };
  const leaf = (idx, g, h) => { let G = 0, H = 0; for (const i of idx) { G += g[i]; H += h[i]; } return -G / (H + 1); };
  const all = Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t < trees; t++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = sig(F[i]); g[i] = p - y[i]; h[i] = Math.max(1e-6, p * (1 - p)); }
    const s0 = split(all, g, h);
    if (!s0) break;
    const L = all.filter((i) => B[i][s0.j] <= s0.b), R = all.filter((i) => B[i][s0.j] > s0.b);
    const node = { j: s0.j, b: s0.b, kids: [L, R].map((idx) => { const s = split(idx, g, h); if (!s) return { v: leaf(idx, g, h) };
      const a = idx.filter((i) => B[i][s.j] <= s.b), c = idx.filter((i) => B[i][s.j] > s.b);
      return { j: s.j, b: s.b, kids: [{ v: leaf(a, g, h) }, { v: leaf(c, g, h) }] }; }) };
    model.trees.push(node);
    for (let i = 0; i < n; i++) F[i] += lr * gbmNode(node, B[i]);
  }
  return model;
}
const gbmNode = (node, b) => (node.v !== undefined ? node.v : gbmNode(node.kids[b[node.j] <= node.b ? 0 : 1], b));
function gbmPredict(m, x) {
  const b = x.map((v, j) => { const c = m.cuts[j]; let lo = 0, hi = c.length; while (lo < hi) { const k = (lo + hi) >> 1; if (v > c[k]) lo = k + 1; else hi = k; } return lo; });
  let z = m.base; for (const t of m.trees) z += m.lr * gbmNode(t, b);
  return 1 / (1 + Math.exp(-z));
}

/* ---------- Caractéristique en plus : série de pertes de la stratégie (pour les arbres) ---------- */
function addStreak(list) {
  const exits = [...list].sort((a, b) => a.exitT - b.exitT);
  const bySid = new Map(); let k = 0;
  for (const t of [...list].sort((a, b) => a.entryT - b.entryT)) {
    while (k < exits.length && exits[k].exitT <= t.entryT) { const x = exits[k++]; const s = bySid.get(x.sid) || []; s.push(x.pnlPct > 0); bySid.set(x.sid, s); }
    const s = bySid.get(t.sid) || []; let streak = 0; for (let i = s.length - 1; i >= 0 && !s[i]; i--) streak++;
    t.x2 = [...t.x, Math.min(streak, 8)];
  }
}

/* ---------- Scores hors échantillon (année par année) ---------- */
function walkForward(list, kind) {
  const out = new Map();
  for (let yr = 2011; yr <= 2026; yr++) {
    const hist = list.filter((t) => t.exitT < Y(yr));
    const cur = list.filter((t) => t.entryT >= Y(yr) && t.entryT < Y(yr + 1));
    if (hist.length < 800 || !cur.length) continue;
    let score;
    if (kind === 'gbm') { const m = gbmTrain(hist.map((t) => t.x2), hist.map((t) => (t.pnlPct > 0 ? 1 : 0))); score = (t) => gbmPredict(m, t.x2); }
    else { const m = kind === 'ridge' ? trainR(hist) : train(hist); score = (t) => predict(m, t.x); }
    // Référence du seuil : scores des 2 dernières années d'entraînement (comme en direct)
    const ref = hist.filter((t) => t.entryT >= Y(yr) - 2 * 365 * DAY).map(score).sort((a, b) => a - b);
    for (const t of cur) { const s = score(t); let lo = 0, hi = ref.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ref[m] < s) lo = m + 1; else hi = m; } out.set(t, { s, q: ref.length ? lo / ref.length : 0.5 }); }
  }
  return out;
}
function auc(list, sc) {
  const s = list.filter((t) => sc.has(t)).map((t) => [sc.get(t).s, t.pnlPct > 0]).sort((a, b) => a[0] - b[0]);
  let pos = 0, rank = 0; s.forEach(([, w], i) => { if (w) { pos++; rank += i + 1; } });
  const neg = s.length - pos; return pos && neg ? (rank - (pos * (pos + 1)) / 2) / (pos * neg) : 0.5;
}

(async () => {
  const { all, q5, daily, vix } = await buildTrades(cfg, CACHE, { withLucid: true });
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const nyRun = (bars, s, sid, m, mult, fee) => backtest({ ...s, compute: (c, sec) => s.compute(c, sec, 'nas100') }, bars, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' }).list
    .map((t) => ({ ...t, sid, market: m, intraday: true, contractUsd: t.entry * mult, contractFee: fee }));
  const NYB = {
    nas100: [qs, 82, 2.5], silver: [nySession(await polygonBars(CACHE, 'SLV', 5, '2024-11-18', { maxAgeH: Infinity })), 1075, 3.5],
    dow: [nySession(await polygonBars(CACHE, 'DIA', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    russell: [nySession(await polygonBars(CACHE, 'IWM', 5, '2024-11-18', { maxAgeH: Infinity })), 50, 2.5],
    spx: [nySession(aggregate(await polygonBars(CACHE, 'SPY', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60)), 50, 4],
  };
  const A0 = q5[0].t + 30 * DAY;
  const P = { B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] };
  const ctx = contextOf(Object.fromEntries(Object.entries(daily).map(([k, d]) => [k, d.c])), vix);

  // Listes de trades des deux comptes (stratégies et risques actuels)
  const accounts = {};
  for (const id of ['ftmo', 'lucid']) {
    const A = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, id === 'ftmo' ? 'gold' : 'lucid');
    const sids = A.strategies.filter((k) => A.riskOf(...strat(k), 'eval') > 0);
    const intra = sids.filter((k) => { const [m, s] = strat(k); return s.tf && s.tf !== '1d' && NYB[m]; })
      .flatMap((k) => { const [b, mult, fee] = NYB[k.split(':')[0]]; return nyRun(b, strat(k)[1], k, k.split(':')[0], mult, fee); });
    const list = [...all.filter((t) => sids.includes(t.sid) && !(t.intraday && NYB[t.market])), ...intra].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid), 'eval') }));
    featurize(list, ctx);
    addStreak(list);
    accounts[id] = list;
    console.log(`${id} : ${list.length} trades, ${sids.length} stratégies`);
  }
  const RF = { steps: 1, capital: 100_000, target: 10, target1: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, riskPct: 1,
    sizer: RULES[cfg.ftmoSizing], dayProfitCapUsd: (cfg.ftmoDayProfitCapPct / 100) * 10_000, maxLossesPerDay: cfg.ftmoMaxLossesDay || Infinity };
  const RL = { capital: 50_000, steps: 1, target1: 6, target: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2,
    contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer: RULES[cfg.ftmoSizing],
    dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * 50_000 * 0.06, maxLossesPerDay: cfg.lucidMaxLossesDay || Infinity };
  const rules = { ftmo: RF, lucid: RL };

  const evaluate = (id, list) => {
    const o = rules[id];
    const per = Object.entries(P).map(([k, [a, b]]) => {
      const l = list.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
      return challengeStats(l, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...o }).passRate;
    });
    let extra = '';
    if (id === 'lucid') {
      const l = list.filter((t) => t.entryT >= A0).sort((x, y) => x.entryT - y.entryT);
      const end = l[l.length - 1].entryT - 60 * DAY; let n = 0, p14 = 0, p30 = 0, f14 = 0;
      for (let s = A0; s < end; s += DAY) {
        const wd = new Date(s * 1000).getUTCDay(); if (wd === 0 || wd === 6) continue;
        n++; const r = runPhase(l.filter((t) => t.entryT >= s && t.entryT < s + 200 * DAY), { ...o, from: s }); const d = (r.at - s) / DAY;
        if (r.outcome === 'target' && d <= 14) p14++; if (r.outcome === 'target' && d <= 30) p30++; if ((r.outcome === 'daily' || r.outcome === 'maxloss') && d <= 14) f14++;
      }
      extra = ` || ≤14 j ${((p14 / n) * 100).toFixed(0).padStart(2)} % · ≤30 j ${((p30 / n) * 100).toFixed(0).padStart(2)} % · échec ≤14 j ${((f14 / n) * 100).toFixed(0).padStart(2)} %`;
    }
    return `${per.map((p) => `${p.toFixed(0).padStart(3)} %`).join(' |')}${extra}`;
  };

  for (const id of ['ftmo', 'lucid']) {
    const list = accounts[id];
    console.log(`\n=== ${id === 'ftmo' ? 'FTMO' : 'Lucid'} · réussite < 1 an 2009–19 | 2020–26 | nov. 24–26${id === 'lucid' ? ' || nov. 24–26 départ chaque jour ouvré' : ''} ===`);
    console.log(`${'sans IA'.padEnd(40)} ${evaluate(id, list)}`);
    for (const kind of ['logit', 'ridge', 'gbm']) {
      const sc = walkForward(list, kind);
      const scored = list.filter((t) => sc.has(t));
      const lo = scored.filter((t) => sc.get(t).q < 0.2).map(rOf), hi = scored.filter((t) => sc.get(t).q >= 0.2).map(rOf);
      console.log(`\n  ${kind === 'logit' ? 'logistique (modèle du bot)' : kind === 'ridge' ? 'ridge R' : 'arbres (boosting)'} · AUC hors échantillon ${auc(list, sc).toFixed(3)} · R moyen : 20 % les moins bien notés ${mean(lo).toFixed(3)} / autres ${mean(hi).toFixed(3)}`);
      for (const q of [0.1, 0.2, 0.3]) {
        const kept = list.filter((t) => !sc.has(t) || sc.get(t).q >= q);
        console.log(`  ${`refuse ${q * 100} %${kind === 'logit' && q === 0.2 ? ' (= bot)' : ''}`.padEnd(38)} ${evaluate(id, kept)}`);
      }
      const sized = list.map((t) => { const v = sc.get(t); const m = !v ? 1 : v.q < 0.3 ? 0.5 : v.q >= 0.7 ? 1.5 : 1; return { ...t, riskPct: t.riskPct * m }; });
      console.log(`  ${'risque dosé (× 0,5 / × 1 / × 1,5)'.padEnd(38)} ${evaluate(id, sized)}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
