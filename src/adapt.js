/**
 * Adaptation automatique (AUTO_ADAPT=1) : une « revue » par semaine (dimanche, marchés fermés) apprend de ce que le
 * bot vit en direct, lentement et avec des garde-fous.
 *
 *   IA validatrice : chaque signal jugé (pris ou refusé) est mémorisé avec ses caractéristiques (data/ai-samples.json)
 *   puis étiqueté par le résultat de son trade paper. Le modèle est ré-ajusté prudemment (fineTune : reste près du
 *   modèle d'origine tant qu'il y a peu de données) et n'est ADOPTÉ que s'il fait mieux que le modèle actuel sur les
 *   25 % de signaux les plus récents. Seuil recalé pour refuser ≈ 20 % des signaux. Si les signaux qu'elle refuse
 *   gagnent plus que ceux qu'elle garde, elle repasse seule en observation (et revient au blocage ensuite).
 *
 *   Stratégies : note = R moyen des trades paper live, lissé vers un a priori (PRIOR_N trades fictifs à PRIOR_R).
 *   Poids du risque × 0,5 / × 1 / × 1,25, suspension (× 0) si clairement perdante, réintégration quand elle redevient
 *   positive ; candidates (ADAPT_CANDIDATES) suivies en paper et promues sur le compte si elles font mieux.
 *   Au plus MAX_CHANGES changements par semaine, jamais plus d'un tiers des stratégies suspendues.
 *
 * Tout est dans data/adapt.json (+ data/aiModel.live.json) ; la configuration d'origine n'est jamais modifiée.
 */
const path = require('path');
const fs = require('fs');
const { fineTune, logLoss, predict, originModel, LIVE_FILE } = require('./aiFilter');

const FILE = 'adapt.json';
const SAMPLES = 'ai-samples.json';
const PRIOR_N = 30;
const PRIOR_R = 0.05;
const MAX_CHANGES = 3;
const MIN_SAMPLES = 150;
const REFUSE = 0.2;

const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
const stopPct = (t) => (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100;
const rOf = (t) => t.pnlPct / Math.max(1e-9, stopPct(t));
const quantile = (l, q) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : -Infinity; };

/* ------------------------------------------------------------------ */
/* Cœur (fonctions pures, utilisées aussi par la simulation adapt-sim) */
/* ------------------------------------------------------------------ */

/**
 * Revue de l'IA. samples : signaux étiquetés { x, win, r, entryT } (ordre chronologique) ; current : modèle actuel ;
 * origin : modèle d'origine. Retourne { adopt, model?, why, before, after, n }.
 */
function reviewAI(samples, current, origin, now, { minSamples = MIN_SAMPLES, refuse = REFUSE } = {}) {
  const n = samples.length;
  if (!current || !origin) return { adopt: false, why: 'pas de modèle', n };
  if (n < minSamples) return { adopt: false, why: `pas encore assez de signaux jugés et clôturés (${n} / ${minSamples})`, n };
  const cut = Math.floor(n * 0.75);
  const train = samples.slice(0, cut);
  const hold = samples.slice(cut);
  const cand = fineTune(current, origin.w, train);
  const thr = (m, list) => quantile(list.map((t) => predict(m, t.x)), refuse);
  const keptR = (m) => { const min = thr(m, train); return mean(hold.filter((t) => predict(m, t.x) >= min).map((t) => t.r)); };
  const before = { loss: logLoss(current, hold), keptR: keptR(current) };
  const after = { loss: logLoss(cand, hold), keptR: keptR(cand) };
  if (!(after.loss < before.loss - 1e-4 && after.keptR >= before.keptR)) {
    return { adopt: false, why: 'le modèle ré-appris ne fait pas mieux sur les signaux récents', before, after, n };
  }
  // Adopté : ré-ajusté sur tous les signaux, seuil = 20 % des scores des 3 derniers mois refusés
  const model = fineTune(current, origin.w, samples);
  const recent = samples.filter((t) => t.entryT >= now - 90 * 86400);
  model.min = thr(model, recent.length >= 30 ? recent : samples);
  return { adopt: true, model, why: 'meilleur sur les signaux récents', before, after, n };
}

/**
 * Sécurité de l'IA : sur les 60 derniers signaux étiquetés de chaque groupe, si ceux qu'elle refuse (ok = false)
 * gagnent en moyenne plus que ceux qu'elle garde → 'observe' ; sinon 'block'. null si pas assez de recul (< 20 refusés).
 */
function aiSafety(samples) {
  const no = samples.filter((t) => !t.ok).slice(-60);
  const ok = samples.filter((t) => t.ok).slice(-60);
  if (no.length < 20 || ok.length < 20) return null;
  return { mode: mean(no.map((t) => t.r)) > mean(ok.map((t) => t.r)) ? 'observe' : 'block', refusedR: mean(no.map((t) => t.r)), keptR: mean(ok.map((t) => t.r)), n: no.length };
}

/** Note lissée d'une stratégie à partir des R de ses trades live. */
const scoreOf = (rs) => (rs.reduce((a, b) => a + b, 0) + PRIOR_R * PRIOR_N) / (rs.length + PRIOR_N);

/** Poids visé pour une stratégie suivie, selon sa note et son nombre de trades live. */
function targetWeight(n, score, current = 1) {
  if (current === 0) return n >= 20 && score > 0 ? 1 : 0; // suspendue : réintégrée quand la note redevient positive
  if (n >= 20 && score < -0.15) return 0;
  if (n >= 10 && score < -0.05) return 0.5;
  if (n >= 20 && score > 0.15) return 1.25;
  return 1;
}

/**
 * Revue des stratégies. stats : { clé: [R des trades live] } ; followed : clés suivies par le compte ; candidates :
 * clés en observation ; state : { weights, promoted }. Retourne { weights, promoted, changes: [{ key, from, to, n, score, why }] }.
 */
function reviewStrategies(stats, followed, candidates, state = {}) {
  const weights = { ...(state.weights || {}) };
  const promoted = [...(state.promoted || [])];
  const active = [...new Set([...followed, ...promoted])];
  const note = (k) => { const rs = stats[k] || []; return { n: rs.length, score: scoreOf(rs) }; };
  const wanted = [];
  for (const k of active) {
    const { n, score } = note(k);
    const cur = weights[k] ?? 1;
    let to = targetWeight(n, score, cur);
    // Candidate promue qui déçoit : retirée du compte (reste en observation)
    if (promoted.includes(k) && n >= 25 && score < 0) to = 'out';
    if (to !== cur) wanted.push({ key: k, from: cur, to, n, score, gap: Math.abs(score) });
  }
  wanted.sort((a, b) => b.gap - a.gap);
  const changes = [];
  const maxSusp = Math.floor(active.length / 3);
  let susp = active.filter((k) => (weights[k] ?? 1) === 0).length;
  for (const c of wanted) {
    if (changes.length >= MAX_CHANGES) break;
    if (c.to === 0 && susp >= maxSusp) continue;
    if (c.to === 'out') {
      promoted.splice(promoted.indexOf(c.key), 1);
      delete weights[c.key];
      changes.push({ ...c, why: 'candidate retirée du compte (note négative)' });
      continue;
    }
    if (c.to === 0) susp++;
    if (c.from === 0) susp--;
    weights[c.key] = c.to;
    changes.push({ ...c, why: c.to === 0 ? 'suspendue' : c.from === 0 ? 'réintégrée' : c.to > c.from ? 'renforcée' : 'réduite' });
  }
  // Promotion : au plus 1 candidate par semaine, si elle fait mieux que la moins bonne stratégie suivie
  if (changes.length < MAX_CHANGES) {
    const worst = Math.min(...active.filter((k) => (weights[k] ?? 1) > 0).map((k) => note(k).score), Infinity);
    const best = candidates.filter((k) => !promoted.includes(k) && !followed.includes(k)).map((k) => ({ key: k, ...note(k) }))
      .filter((c) => c.n >= 25 && c.score > Math.max(0, Number.isFinite(worst) ? worst : 0)).sort((a, b) => b.score - a.score)[0];
    if (best) {
      promoted.push(best.key);
      weights[best.key] = 0.5;
      changes.push({ key: best.key, from: null, to: 0.5, n: best.n, score: best.score, why: 'candidate promue sur le compte (risque × 0,5)' });
    }
  }
  return { weights, promoted, changes };
}

/* ------------------------------------------------------------------ */
/* En direct                                                            */
/* ------------------------------------------------------------------ */

const loadState = (store) => store.loadJson(FILE, null) || { version: 1, weights: {}, promoted: [], aiMode: null, aiVersion: 0, lastReview: 0, history: [] };

/** Mémorise un signal jugé par l'IA (compte FTMO). */
function recordSignal(store, sig) {
  const list = store.loadJson(SAMPLES, []);
  if (list.some((t) => t.market === sig.market && t.sid === sig.sid && Math.abs(t.entryT - sig.entryT) < 2)) return;
  list.push(sig);
  store.saveJson(SAMPLES, list.slice(-5000));
}

/** Étiquette les signaux par le résultat de leur trade paper ; retourne la liste (étiquetés en premier, ordre d'entrée). */
function labelSamples(store) {
  const list = store.loadJson(SAMPLES, []);
  const papers = {};
  let changed = false;
  for (const t of list) {
    if (t.win !== undefined) continue;
    papers[t.market] ??= store.loadJson(`${t.market}.json`, null);
    const tr = (papers[t.market]?.accounts?.[t.sid]?.closed || []).find((c) => Math.abs(c.entryT - t.entryT) < 2);
    if (!tr) continue;
    t.win = tr.pnlPct > 0;
    t.r = rOf(tr);
    changed = true;
  }
  if (changed) store.saveJson(SAMPLES, list);
  return list.filter((t) => t.win !== undefined).sort((a, b) => a.entryT - b.entryT);
}

/** R des trades paper live de chaque stratégie (clé « marché:id »). */
function liveStats(cfg, store, keys) {
  const out = {};
  const papers = {};
  for (const k of keys) {
    const [m, id] = k.split(':');
    papers[m] ??= store.loadJson(`${m}.json`, null);
    out[k] = (papers[m]?.accounts?.[id]?.closed || []).filter((t) => t.entry && (t.initSl ?? t.sl)).map(rOf);
  }
  return out;
}

/** Poids de risque appris pour une stratégie (1 si adaptation coupée). */
function weightOf(cfg, store, key) {
  if (!cfg.autoAdapt || !cfg.adaptStrategies) return 1;
  return loadState(store).weights?.[key] ?? 1;
}
/** Candidates promues sur le compte. */
const promotedOf = (cfg, store) => (cfg.autoAdapt && cfg.adaptStrategies ? loadState(store).promoted || [] : []);
/** Mode effectif de l'IA : 'observe' si la sécurité l'a décidé, sinon celui de la configuration. */
function aiModeOf(cfg, store) {
  if (!cfg.autoAdapt || cfg.ftmoAi !== 'block') return cfg.ftmoAi;
  return loadState(store).aiMode === 'observe' ? 'observe' : cfg.ftmoAi;
}

/** La revue est-elle due ? (dimanche UTC, ≥ 6 jours après la précédente) */
function reviewDue(cfg, store, now = Date.now()) {
  if (!cfg.autoAdapt) return false;
  const st = loadState(store);
  return new Date(now).getUTCDay() === 0 && now - (st.lastReview || 0) > 6 * 86400_000;
}

const fmtW = (w) => (w === 0 ? 'suspendue' : w === null || w === undefined ? '—' : `× ${String(w).replace('.', ',')}`);

/** Revue hebdomadaire : met à jour l'IA et les poids des stratégies. Retourne { text, state }. */
function weeklyReview(cfg, store, now = Date.now()) {
  const st = loadState(store);
  const t = Math.floor(now / 1000);
  const lines = ['🧠 <b>Revue automatique de la semaine</b>'];
  // IA
  const samples = labelSamples(store);
  const origin = originModel();
  const current = require('./aiFilter').loadModel(cfg);
  const ai = reviewAI(samples, current, origin, t);
  if (ai.adopt) {
    const version = (st.aiVersion || 0) + 1;
    const model = { ...ai.model, version, date: new Date(now).toISOString().slice(0, 10), liveSamples: ai.n };
    const file = path.join(cfg.dataDir, LIVE_FILE);
    try { if (fs.existsSync(file)) st.aiPrevious = [fs.readFileSync(file, 'utf8'), ...(st.aiPrevious || [])].slice(0, 3); } catch { /* rien */ }
    fs.writeFileSync(file, JSON.stringify(model));
    st.aiVersion = version;
    lines.push(`🤖 IA : <b>nouvelle version v${version} adoptée</b> (${ai.n} signaux live) · précision ${ai.before.loss.toFixed(3)} → ${ai.after.loss.toFixed(3)} · R moyen des signaux gardés ${ai.before.keptR.toFixed(2)} → ${ai.after.keptR.toFixed(2)} · seuil ${Math.round(model.min * 100)} %`);
  } else {
    lines.push(`🤖 IA : version v${st.aiVersion || 0} gardée — ${ai.why}`);
  }
  const safe = aiSafety(samples);
  if (safe && cfg.ftmoAi === 'block') {
    const prev = st.aiMode || 'block';
    st.aiMode = safe.mode;
    if (safe.mode !== prev) lines.push(safe.mode === 'observe'
      ? `⚠️ IA repassée en <b>observation</b> : ses refus récents auraient rapporté plus (R ${safe.refusedR.toFixed(2)}) que les trades gardés (R ${safe.keptR.toFixed(2)})`
      : `✅ IA remise en <b>blocage</b> : ses refus récents font moins bien (R ${safe.refusedR.toFixed(2)}) que les trades gardés (R ${safe.keptR.toFixed(2)})`);
  }
  // Stratégies (ADAPT_STRATEGIES=1 seulement : sur l'historique, adapter les poids n'a pas aidé)
  if (!cfg.adaptStrategies) {
    lines.push('📊 Stratégies : réglage fixe (l’adaptation des poids n’a pas amélioré la réussite sur l’historique 2015–2026 ; ADAPT_STRATEGIES=1 pour l’activer)');
    st.lastReview = now;
    st.history = [...(st.history || []), { at: now, ai: ai.adopt ? st.aiVersion : null, changes: [] }].slice(-30);
    store.saveJson(FILE, st);
    return { text: lines.join('\n'), state: st };
  }
  const { accountOf } = require('./ftmoAccount');
  const followed = accountOf(cfg, 'gold').strategies;
  const candidates = cfg.adaptCandidates || [];
  const stats = liveStats(cfg, store, [...new Set([...followed, ...candidates, ...(st.promoted || [])])]);
  const rv = reviewStrategies(stats, followed, candidates, st);
  st.weights = rv.weights;
  st.promoted = rv.promoted;
  if (rv.changes.length) {
    lines.push('📊 Stratégies :');
    for (const c of rv.changes) lines.push(`• <code>${c.key}</code> ${c.why} (${fmtW(c.from)} → ${c.to === 'out' ? 'retirée' : fmtW(c.to)}) · ${c.n} trades live, note ${c.score >= 0 ? '+' : ''}${c.score.toFixed(2)} R`);
  } else {
    lines.push('📊 Stratégies : aucun changement (pas assez de trades live pour conclure, ou rien à corriger)');
  }
  const red = Object.entries(st.weights).filter(([, w]) => w > 0 && w < 1).length;
  const sus = Object.entries(st.weights).filter(([, w]) => w === 0).length;
  lines.push(`<i>En cours : ${red} réduite(s), ${sus} suspendue(s), ${(st.promoted || []).length} candidate(s) promue(s) · trades paper de toutes les stratégies conservés.</i>`);
  st.lastReview = now;
  st.history = [...(st.history || []), { at: now, ai: ai.adopt ? st.aiVersion : null, changes: rv.changes.map((c) => ({ key: c.key, to: c.to, why: c.why })) }].slice(-30);
  store.saveJson(FILE, st);
  return { text: lines.join('\n'), state: st };
}

/** Résumé court (légende /ftmo). */
function summary(cfg, store) {
  if (!cfg.autoAdapt) return '';
  const st = loadState(store);
  const red = Object.values(st.weights || {}).filter((w) => w > 0 && w < 1).length;
  const up = Object.values(st.weights || {}).filter((w) => w > 1).length;
  const sus = Object.values(st.weights || {}).filter((w) => w === 0).length;
  const when = st.lastReview ? new Date(st.lastReview).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : 'dimanche prochain';
  const strat = cfg.adaptStrategies ? ` · ${up} renforcée(s), ${red} réduite(s), ${sus} suspendue(s), ${(st.promoted || []).length} promue(s)` : '';
  return `🧠 Adaptation : IA v${st.aiVersion || 0} (apprend chaque dimanche)${st.aiMode === 'observe' ? ', repassée en observation' : ''}${strat} · ${st.lastReview ? `dernière revue le ${when}` : `1re revue ${when}`}`;
}

/** Remise à zéro : poids, promotions et modèle live supprimés. */
function reset(cfg, store) {
  store.saveJson(FILE, { version: 1, weights: {}, promoted: [], aiMode: null, aiVersion: 0, lastReview: 0, history: [] });
  try { fs.unlinkSync(path.join(cfg.dataDir, LIVE_FILE)); } catch { /* rien */ }
}

module.exports = {
  reviewAI, aiSafety, reviewStrategies, targetWeight, scoreOf, recordSignal, labelSamples, liveStats, weightOf, promotedOf, aiModeOf,
  reviewDue, weeklyReview, summary, reset, loadState, PRIOR_N, PRIOR_R,
};
