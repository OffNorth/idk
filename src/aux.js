/**
 * Séries externes (journalières, Yahoo Finance) utilisées par certaines stratégies.
 *   tnx    : taux US 10 ans          dxy    : indice du dollar
 *   silver : argent (future SI=F)    sox    : indice des semi-conducteurs
 *   oil    : pétrole (future CL=F)   spx    : S&P 500 (^GSPC)
 *   peer   : l'AUTRE marché du bot (Nasdaq 100 pour l'or, or pour le Nasdaq) — momentum relatif
 */
const { cachedYahoo } = require('./yahoo');

const SYMBOLS = { tnx: '^TNX', dxy: 'DX-Y.NYB', silver: 'SI=F', sox: '^SOX', oil: 'CL=F', spx: '^GSPC' };
const PEER = { gold: '^NDX', nas100: 'GC=F', spx: 'GC=F', eurusd: 'GC=F' }; // « l'autre marché » : l'or pour les indices et l'EUR/USD

/** Symbole Yahoo d'une série externe pour un marché donné. */
function auxSymbol(key, marketId) {
  return key === 'peer' ? PEER[marketId] : SYMBOLS[key];
}

/** Séries externes demandées par une liste de stratégies. */
function auxKeys(strategies) {
  const keys = new Set();
  for (const s of strategies) {
    if (s.needsTnx) keys.add('tnx');
    if (s.needsDxy) keys.add('dxy');
    for (const k of s.needsAux || []) keys.add(k);
  }
  return [...keys];
}

/** Historique complet (cache disque) de toutes les séries externes d'un marché — banc d'essai et /historique. */
async function loadAux(cacheDir, marketId, keys = ['tnx', 'dxy', 'silver', 'sox', 'peer']) {
  const out = {};
  for (const k of keys) {
    const sym = auxSymbol(k, marketId);
    if (sym) out[k] = await cachedYahoo(cacheDir, sym, '1d').catch(() => null);
  }
  return out;
}

module.exports = { auxSymbol, auxKeys, loadAux, SYMBOLS, PEER };
