#!/usr/bin/env node
/**
 * L'adaptation automatique (src/adapt.js) aurait-elle aidé ? Rejoue 2015 → 2026 semaine par semaine, comme en direct :
 *   - IA de départ entraînée sur 2009–2014 seulement, seuil = 20 % des signaux refusés ;
 *   - chaque semaine, les signaux des stratégies du compte FTMO sont jugés, mémorisés, étiquetés à leur clôture ;
 *   - chaque dimanche, revue : IA ré-apprise si meilleure (reviewAI), sécurité (aiSafety), poids des stratégies
 *     (reviewStrategies sur les trades « paper » : tous les signaux, pris ou non).
 * Comparaison de la réussite du challenge (formule FTMO_PROGRAM, risque qui baisse à l'approche de l'objectif) :
 * sans IA · IA figée · IA qui apprend · stratégies qui s'adaptent · tout adaptatif. Candidates non simulées.
 *
 *   npm run adapt-sim          (REVIEW_DAYS=7 : intervalle entre deux revues)
 */
const path = require('path');
const cfg = require('./src/config');
const { challengeStats } = require('./src/ftmo');
const { programOf } = require('./src/ftmoAccount');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { featurize, contextOf, train, predict, rOf } = require('./src/aiFilter');
const ad = require('./src/adapt');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const START = Y(2015);
const STEP = Number(process.env.REVIEW_DAYS || 7) * 86400;
const quantile = (l, q) => { const s = [...l].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

(async () => {
  const { all, daily, vix } = await buildTrades(cfg, CACHE);
  featurize(all, contextOf(Object.fromEntries(Object.entries(daily).map(([k, d]) => [k, d.c])), vix));
  const noNasIntra = (t) => !(t.intraday && t.market === 'nas100'); // pas de Nasdaq intraday avant nov. 2024
  const trades = all.filter((t) => t.entryT >= Y(2009) + 60 * 86400 && noNasIntra(t)).sort((a, b) => a.entryT - b.entryT);
  const base = trades.filter((t) => t.exitT < START);
  const origin = { ...train(base), kind: 'win' };
  origin.min = quantile(base.map((t) => predict(origin, t.x)), 0.2);
  const live = trades.filter((t) => t.entryT >= START);
  console.log(`=== Adaptation automatique, rejouée ${new Date(START * 1000).getUTCFullYear()} → 2026 · revue tous les ${STEP / 86400} j · IA de départ : ${base.length} trades 2009–2014 ===`);

  // Une passe : renvoie les trades pris (avec poids) selon les options
  const runPass = ({ aiOn, aiLearn, stratLearn }) => {
    let model = origin;
    let mode = 'block';
    let state = { weights: {}, promoted: [] };
    const samples = [];
    const kept = [];
    const log = { adopted: 0, observeWeeks: 0, changes: 0 };
    const followed = [...new Set(live.map((t) => t.sid))];
    let i = 0;
    for (let w = START; i < live.length; w += STEP) {
      // Revue (début de semaine) avec ce qui est clôturé
      const done = samples.filter((s) => s.exitT <= w);
      if (aiOn && aiLearn) {
        const rv = ad.reviewAI(done.slice(-2000), model, origin, w);
        if (rv.adopt) { model = rv.model; log.adopted++; }
      }
      if (aiOn) {
        const safe = ad.aiSafety(done);
        if (safe) mode = safe.mode;
        if (mode === 'observe') log.observeWeeks++;
      }
      if (stratLearn) {
        const stats = {};
        for (const t of live) { if (t.exitT > w) break; (stats[t.sid] ||= []).push(rOf(t)); }
        const rv = ad.reviewStrategies(stats, followed, [], state);
        state = rv;
        log.changes += rv.changes.length;
      }
      // Signaux de la semaine
      while (i < live.length && live[i].entryT < w + STEP) {
        const t = live[i++];
        const wt = stratLearn ? state.weights[t.sid] ?? 1 : 1;
        let ok = true;
        if (aiOn) {
          const p = predict(model, t.x);
          ok = p >= model.min;
          samples.push({ x: t.x, entryT: t.entryT, exitT: t.exitT, win: t.pnlPct > 0, r: rOf(t), ok });
        }
        if (!(wt > 0)) continue;
        if (aiOn && !ok && mode === 'block') continue;
        kept.push({ ...t, riskPct: t.riskPct * wt });
      }
    }
    return { kept, log };
  };

  const F = programOf(cfg);
  const opts = { riskPct: 1, dayStopPct: cfg.ftmoDayStop, sizer: RULES[cfg.ftmoSizing] || RULES.fixe, steps: F.steps, dailyPct: F.daily, maxPct: F.max, trailingMax: F.trailing, bestDayPct: F.bestDay, horizonDays: 365 };
  const P = [['2015–2019', START, Y(2020)], ['2020–2026', Y(2020), Infinity]];
  const show = (label, list, log) => {
    const cells = P.map(([lbl, a, b]) => {
      const c = challengeStats(list.filter((t) => t.entryT >= a && t.entryT < b), { ...opts, start: a, ...(Number.isFinite(b) ? { end: b } : {}) });
      return `${lbl} ${c ? `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)` : '—'}`;
    });
    console.log(`  ${label.padEnd(34)} ${cells.join(' · ')} · ${list.length} trades${log ? ` · IA adoptée ${log.adopted} fois, ${log.observeWeeks} sem. en observation, ${log.changes} changements de poids` : ''}`);
  };
  console.log('Réussite du challenge en moins d\'un an (médiane) :');
  show('sans IA, stratégies fixes', live);
  for (const [label, o] of [
    ['IA figée (2009–2014)', { aiOn: true, aiLearn: false, stratLearn: false }],
    ['IA qui apprend', { aiOn: true, aiLearn: true, stratLearn: false }],
    ['stratégies qui s\'adaptent (sans IA)', { aiOn: false, aiLearn: false, stratLearn: true }],
    ['tout adaptatif (IA + stratégies)', { aiOn: true, aiLearn: true, stratLearn: true }],
  ]) {
    const t0 = Date.now();
    const { kept, log } = runPass(o);
    show(label, kept, log);
    if (process.env.DEBUG) console.log(`    (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
