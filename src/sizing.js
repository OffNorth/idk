/**
 * Levier dynamique : le risque de chaque trade (donc son levier = montant engagé ÷ solde) est ajusté selon le contexte.
 * Toutes les règles renvoient un MULTIPLICATEUR du risque de base (0 = on ne prend pas le trade), borné.
 * Indicateurs par trade (annotate) calculés uniquement avec le passé :
 *   volRatio : distance du stop ÷ médiane des 50 derniers stops de la même stratégie (> 1 = marché plus agité que d'habitude)
 *   recentR  : somme des R des 20 derniers trades FERMÉS de la même stratégie avant l'entrée (forme récente)
 * État du compte (fourni par runPhase / le compte en direct) : balance, capital, dayStart, target (%), open (positions).
 */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const stopPctOf = (t) => (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100;

/** Ajoute volRatio et recentR à chaque trade (liste de trades d'une ou plusieurs stratégies, champ `sid`). */
function annotate(trades) {
  const by = new Map();
  for (const t of trades) {
    if (!by.has(t.sid)) by.set(t.sid, []);
    by.get(t.sid).push(t);
  }
  for (const list of by.values()) {
    list.sort((a, b) => a.entryT - b.entryT);
    const exits = [...list].sort((a, b) => a.exitT - b.exitT);
    let k = 0;
    const closedR = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      while (k < exits.length && exits[k].exitT <= t.entryT) {
        const x = exits[k++];
        closedR.push(x.pnlPct / Math.max(1e-9, stopPctOf(x)));
      }
      const prev = list.slice(Math.max(0, i - 50), i).map(stopPctOf).sort((a, b) => a - b);
      t.volRatio = prev.length >= 10 ? stopPctOf(t) / prev[Math.floor(prev.length / 2)] : 1;
      t.recentR = closedR.length >= 5 ? closedR.slice(-20).reduce((a, b) => a + b, 0) : 0;
    }
  }
  return trades;
}

/** Règles de levier dynamique testées par `npm run ftmo-sizing`. */
const RULES = {
  fixe: () => 1,
  // Marché agité → moins de risque, marché calme → un peu plus
  volatilité: (t) => clamp(1 / (t.volRatio || 1), 0.5, 1.5),
  'volatilité forte seulement': (t) => ((t.volRatio || 1) > 1.5 ? 0.5 : 1),
  // Forme de la stratégie : plus de risque quand elle gagne, moins quand elle perd
  'forme récente': (t) => (t.recentR > 2 ? 1.5 : t.recentR < -2 ? 0.5 : 1),
  'forme récente (coupe les perdantes)': (t) => (t.recentR < -3 ? 0 : t.recentR > 2 ? 1.25 : 1),
  // État du compte
  'prudence en perte': (t, s) => (s.balance < s.capital * 0.97 ? 0.5 : 1),
  'gain → plus de risque': (t, s) => clamp(1 + ((s.balance / s.capital - 1) * 100) / 10, 0.6, 1.6),
  'perte du jour → moins': (t, s) => (s.balance < s.dayStart - s.capital * 0.01 ? 0.5 : 1),
  'proche de l’objectif → moins': (t, s) => (s.balance >= s.capital * (1 + (s.target * 0.7) / 100) ? 0.5 : 1),
  'plusieurs positions → moins': (t, s) => (s.open >= 2 ? 0.5 : 1),
  // Combinaisons
  'volatilité + prudence en perte': (t, s) => clamp(1 / (t.volRatio || 1), 0.5, 1.5) * (s.balance < s.capital * 0.97 ? 0.5 : 1),
  'volatilité + forme': (t) => clamp(1 / (t.volRatio || 1), 0.5, 1.5) * (t.recentR > 2 ? 1.25 : t.recentR < -2 ? 0.6 : 1),
};

// Avance vers l'objectif du challenge (0 au départ, 1 à l'objectif) ; 0 sans objectif (compte financé)
const progress = (s) => (Number.isFinite(s.target) && s.target > 0 ? Math.max(0, ((s.balance / s.capital - 1) * 100) / s.target) : 0);
const several = (s) => (s.open >= 2 ? 0.5 : 1);
// Risque qui baisse à l'approche de l'objectif (protège le gain acquis), avec « plusieurs positions → moins »
Object.assign(RULES, {
  'objectif : × 0,5 dès 50 %': (t, s) => several(s) * (progress(s) >= 0.5 ? 0.5 : 1),
  'objectif : × 0,5 dès 30 %': (t, s) => several(s) * (progress(s) >= 0.3 ? 0.5 : 1),
  'objectif : paliers': (t, s) => { const p = progress(s); return several(s) * (p >= 0.85 ? 0.25 : p >= 0.6 ? 0.5 : p >= 0.3 ? 0.75 : 1); },
  'objectif : dégressif': (t, s) => several(s) * clamp(1 - progress(s), 0.25, 1),
  'objectif : dégressif doux': (t, s) => several(s) * clamp(1 - 0.75 * progress(s), 0.4, 1),
});

// Groupes de marchés corrélés : indices US et actions, métaux, devises, obligations
const GROUP = { nas100: 'idx', spx: 'idx', dow: 'idx', russell: 'idx', googl: 'idx', pltr: 'idx', lly: 'idx', ba: 'idx', gold: 'metal', silver: 'metal', eurusd: 'fx', tlt: 'bond' };
const groupOf = (m) => GROUP[m] || m;
/**
 * Taille selon la corrélation (npm run optimize, 26/11/2026) : × 0,5 si une position du même groupe est déjà ouverte,
 * et × 0,5 à partir de 3 positions ouvertes en tout. Compte FTMO : réussite 34 / 43 / 67 % → 42 / 47 / 69 % (un peu
 * plus lent : +2 / +18 / +6 jours médians) ; Lucid : moins bien (garde « plusieurs positions → moins »).
 */
RULES['même groupe → moins'] = (t, s) => {
  let same = 0;
  for (const o of s.openTrades || []) if (groupOf(o.market) === groupOf(t.market)) same++;
  return (same >= 1 ? 0.5 : 1) * (s.open >= 3 ? 0.5 : 1);
};
/** Règle de taille d'un compte : FTMO_GROUP_SIZING (défaut) remplace « plusieurs positions → moins » sur FTMO. */
const ruleFor = (cfg, firm) => (firm !== 'Lucid' && cfg.ftmoGroupSizing !== false && cfg.ftmoSizing === 'plusieurs positions → moins'
  ? RULES['même groupe → moins'] : RULES[cfg.ftmoSizing] || RULES.fixe);

module.exports = { annotate, RULES, clamp, stopPctOf, progress, ruleFor, groupOf };
