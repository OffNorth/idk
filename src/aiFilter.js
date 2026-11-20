/**
 * IA validatrice du compte FTMO : pour chaque signal d'une stratégie, un modèle (régression logistique entraînée sur
 * les trades passés, `npm run ai-train`) estime la probabilité que le trade soit gagnant. FTMO_AI=observe (défaut) :
 * avis affiché sur chaque trade du compte FTMO, rien n'est bloqué ; FTMO_AI=block : les signaux sous le seuil
 * (FTMO_AI_MIN, défaut : ≈ 20 % des signaux refusés) ne sont pas pris ; FTMO_AI=off : sans IA.
 * Contexte de marché en direct : bougies journalières gardées par le paper trading (état du marché, champ ctx).
 *
 * Caractéristiques d'un signal : uniquement ce qui est connu AU MOMENT de l'entrée —
 *   stratégie : gains récents (R des 20 derniers trades fermés), part de gagnants et R moyen des 50 derniers (lissés) ;
 *   marché : R des 30 derniers trades fermés toutes stratégies du marché confondues ;
 *   trade : intraday ou journalier, achat ou vente, distance du stop (et par rapport aux 50 derniers stops), heure, jour.
 */
const fs = require('fs');
const path = require('path');

const MARKETS = ['gold', 'nas100', 'spx', 'eurusd'];
const stopPct = (t) => (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100;
const rOf = (t) => t.pnlPct / Math.max(1e-9, stopPct(t));
const clip = (v, a, b) => Math.max(a, Math.min(b, v));
const CTX_NAMES = ['élan 5 j (sens du trade)', 'tendance 50 j (sens du trade)', 'volatilité 20 j', 'VIX'];
const NAMES = ['biais', 'intraday', 'achat', 'log stop', 'stop / habituel', 'forme 20', 'gagnants 50', 'R moyen 50', 'marché 30', 'heure sin', 'heure cos', 'jour sin', 'jour cos', ...MARKETS.map((m) => `marché ${m}`)];

/**
 * Vecteur de caractéristiques d'un signal.
 * sig : { entryT, entry, sl|initSl, side, market, intraday } ; past : trades FERMÉS de la même stratégie (ordre de
 * sortie) ; marketPast : trades fermés du même marché (toutes stratégies) ; prevStops : distances de stop des signaux
 * précédents de la stratégie.
 */
function features(sig, past, marketPast, prevStops, ctx = []) {
  const sp = stopPct(sig);
  const last = (l, n) => l.slice(Math.max(0, l.length - n));
  const r20 = last(past, 20).map(rOf);
  const r50 = last(past, 50).map(rOf);
  const m30 = last(marketPast, 30).map(rOf);
  const sum = (l) => l.reduce((a, b) => a + b, 0);
  const ps = last(prevStops, 50).slice().sort((a, b) => a - b);
  const volRatio = ps.length >= 10 ? sp / ps[Math.floor(ps.length / 2)] : 1;
  const d = new Date(sig.entryT * 1000);
  const h = (d.getUTCHours() + d.getUTCMinutes() / 60) / 24;
  const wd = d.getUTCDay() / 7;
  return [
    1,
    sig.intraday ? 1 : 0,
    sig.side === 'long' ? 1 : -1,
    Math.log(Math.max(1e-4, sp)),
    Math.log(clip(volRatio, 0.25, 4)),
    clip(sum(r20) / 10, -2, 2),
    (r50.filter((r) => r > 0).length + 5) / (r50.length + 10) - 0.5,
    clip((sum(r50) + 0) / (r50.length + 10), -1, 1),
    clip(sum(m30) / 15, -2, 2),
    Math.sin(2 * Math.PI * h), Math.cos(2 * Math.PI * h),
    Math.sin(2 * Math.PI * wd), Math.cos(2 * Math.PI * wd),
    ...MARKETS.map((m) => (sig.market === m ? 1 : 0)),
    ...ctx,
  ];
}

/** Ajoute `t.x` (caractéristiques, passé seulement) à chaque trade d'une liste multi-stratégies (champs sid, market). */
/**
 * Contexte de marché à l'entrée (bougies journalières fermées avant l'entrée) : rendement 5 jours, écart à la moyenne
 * 50 jours, volatilité 20 jours, VIX. daily : { marché: [bougies] }, vix : [bougies].
 */
function contextOf(daily, vix) {
  const idx = (c, t) => { let lo = 0; let hi = c.length - 1; let r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].t + 86400 <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  return (sig) => {
    const c = daily[sig.market];
    const i = c ? idx(c, sig.entryT) : -1;
    if (i < 50) return [0, 0, 0, 0];
    const ret5 = c[i].c / c[i - 5].c - 1;
    let sma = 0;
    for (let k = i - 49; k <= i; k++) sma += c[k].c / 50;
    const rets = [];
    for (let k = i - 19; k <= i; k++) rets.push(c[k].c / c[k - 1].c - 1);
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length);
    const j = vix ? idx(vix, sig.entryT) : -1;
    return [clip(ret5 / Math.max(1e-6, vol * Math.sqrt(5)), -4, 4) * (sig.side === 'long' ? 1 : -1), clip((c[i].c / sma - 1) / Math.max(1e-6, vol * 7), -4, 4) * (sig.side === 'long' ? 1 : -1), Math.log(Math.max(1e-5, vol)), j >= 0 ? Math.log(vix[j].c) : Math.log(18)];
  };
}

function featurize(trades, ctx = null) {
  const list = [...trades].sort((a, b) => a.entryT - b.entryT);
  const exits = [...trades].sort((a, b) => a.exitT - b.exitT);
  const bySid = new Map();
  const byMarket = new Map();
  const stops = new Map();
  let k = 0;
  for (const t of list) {
    while (k < exits.length && exits[k].exitT <= t.entryT) {
      const x = exits[k++];
      if (!bySid.has(x.sid)) bySid.set(x.sid, []);
      bySid.get(x.sid).push(x);
      if (!byMarket.has(x.market)) byMarket.set(x.market, []);
      byMarket.get(x.market).push(x);
    }
    if (!stops.has(t.sid)) stops.set(t.sid, []);
    t.x = features(t, bySid.get(t.sid) || [], byMarket.get(t.market) || [], stops.get(t.sid), ctx ? ctx(t) : []);
    stops.get(t.sid).push(stopPct(t));
  }
  return trades;
}

/** Normalisation (moyenne / écart type par colonne, sauf biais et indicatrices). */
function scaler(X) {
  const n = X[0].length;
  const mu = new Array(n).fill(0);
  const sd = new Array(n).fill(1);
  for (let j = 1; j < n; j++) {
    const col = X.map((x) => x[j]);
    const binary = col.every((v) => v === 0 || v === 1 || v === -1);
    if (binary) continue;
    mu[j] = col.reduce((a, b) => a + b, 0) / col.length;
    sd[j] = Math.sqrt(col.reduce((a, b) => a + (b - mu[j]) ** 2, 0) / col.length) || 1;
  }
  return { mu, sd };
}
const norm = (x, s) => x.map((v, j) => (v - s.mu[j]) / s.sd[j]);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/**
 * Régression logistique (gagnant = R > 0), pondérée par |R| plafonné (un gros perdant pèse plus qu'un petit), L2.
 * Retourne { w, mu, sd }.
 */
function train(trades, { l2 = 1, iters = 400, lr = 0.5 } = {}) {
  const X0 = trades.map((t) => t.x);
  const s = scaler(X0);
  const X = X0.map((x) => norm(x, s));
  const y = trades.map((t) => (t.pnlPct > 0 ? 1 : 0));
  const wt = trades.map((t) => clip(Math.abs(rOf(t)), 0.25, 3));
  const W = wt.reduce((a, b) => a + b, 0);
  const n = X[0].length;
  const w = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(n).fill(0);
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(X[i].reduce((a, v, j) => a + v * w[j], 0));
      const e = (p - y[i]) * wt[i];
      for (let j = 0; j < n; j++) g[j] += e * X[i][j];
    }
    for (let j = 0; j < n; j++) w[j] -= lr * (g[j] / W + (j ? (l2 * w[j]) / X.length : 0));
  }
  return { w, mu: s.mu, sd: s.sd };
}

/**
 * Régression ridge du résultat en R (plafonné à −1,5 / +3) : gain attendu du trade, en multiples du risque.
 * Retourne { w, mu, sd, kind: 'r' }.
 */
function trainR(trades, { l2 = 50, iters = 600, lr = 0.3 } = {}) {
  const X0 = trades.map((t) => t.x);
  const s = scaler(X0);
  const X = X0.map((x) => norm(x, s));
  const y = trades.map((t) => clip(rOf(t), -1.5, 3));
  const n = X[0].length;
  const w = new Array(n).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(n).fill(0);
    for (let i = 0; i < X.length; i++) {
      const e = X[i].reduce((a, v, j) => a + v * w[j], 0) - y[i];
      for (let j = 0; j < n; j++) g[j] += e * X[i][j];
    }
    for (let j = 0; j < n; j++) w[j] -= lr * (g[j] / X.length + (j ? (l2 * w[j]) / X.length : 0));
  }
  return { w, mu: s.mu, sd: s.sd, kind: 'r' };
}

/** Score du trade : probabilité de gain (modèle logistique) ou gain attendu en R (modèle 'r'). */
const predict = (model, x) => {
  const z = norm(x, model).reduce((a, v, j) => a + v * model.w[j], 0);
  return model.kind === 'r' ? z : sigmoid(z);
};

const MODEL_FILE = path.join(__dirname, 'aiModel.json');
let cached;
/** Modèle entraîné (src/aiModel.json, écrit par `npm run ai-train`) ou null. */
function loadModel() {
  if (cached === undefined) {
    try { cached = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')); } catch { cached = null; }
  }
  return cached;
}

/**
 * Avis de l'IA sur un signal en direct : { p, ok, min } (ok = probabilité ≥ seuil), ou null sans modèle.
 * paperAcc : compte paper de la stratégie (closed = trades fermés) ; marketClosed : trades fermés du marché.
 */
function judge(cfg, sig, paperAcc, marketClosed, ctxData = null) {
  const model = loadModel();
  if (!model) return null;
  const past = [...(paperAcc?.closed || [])].sort((a, b) => a.exitT - b.exitT).filter((t) => t.exitT <= sig.entryT);
  const mk = [...(marketClosed || [])].sort((a, b) => a.exitT - b.exitT).filter((t) => t.exitT <= sig.entryT);
  const stops = past.map(stopPct); // distances de stop des derniers signaux de la stratégie
  const ctx = model.ctx ? contextOf({ [sig.market]: ctxData?.daily || [] }, ctxData?.vix || null)(sig) : [];
  const p = predict(model, features(sig, past, mk, stops, ctx));
  const min = Number.isFinite(cfg.ftmoAiMin) ? cfg.ftmoAiMin : model.min;
  return { p, ok: p >= min, min, kind: model.kind || 'win' };
}

module.exports = { features, featurize, contextOf, CTX_NAMES, train, trainR, predict, judge, loadModel, NAMES, MODEL_FILE, rOf };
