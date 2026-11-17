/**
 * Filtres éliminatoires + score sur 100.
 * Le score mesure l'activité / le momentum d'un token, PAS une garantie de gain.
 */

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const lin = (x, lo, hi) => clamp01((x - lo) / (hi - lo));

/** Retourne la liste des raisons de rejet (vide = token accepté). */
function hardFilters(t, cfg) {
  const reasons = [];
  if (t.marketCap < cfg.minMarketCap) reasons.push(`MC trop basse (${fmtUsd(t.marketCap)})`);
  if (t.marketCap > cfg.maxMarketCap) reasons.push(`MC trop haute (${fmtUsd(t.marketCap)})`);
  if (t.liquidity < cfg.minLiquidity) reasons.push(`liquidité faible (${fmtUsd(t.liquidity)})`);
  if (t.vol.h24 < cfg.minVolume24h) reasons.push(`volume 24h faible (${fmtUsd(t.vol.h24)})`);
  if (t.txns.h24.total < cfg.minTxns24h) reasons.push(`peu de transactions (${t.txns.h24.total})`);
  if (t.ageHours !== null && t.ageHours < cfg.minAgeHours) reasons.push(`trop récent (${t.ageHours.toFixed(1)} h)`);
  if (t.ageHours !== null && t.ageHours > cfg.maxAgeHours) reasons.push(`trop ancien (${Math.round(t.ageHours / 24)} j)`);
  if (t.change.h24 > cfg.maxPriceChange24h) reasons.push(`déjà trop pompé (+${Math.round(t.change.h24)} % 24h)`);
  if (t.marketCap > 0 && t.liquidity / t.marketCap < 0.02) reasons.push('liquidité / MC < 2 % (piège à sortie)');
  if (t.txns.h1.total > 20 && t.txns.h1.sells / t.txns.h1.total > 0.75) reasons.push('ventes massives sur 1 h');
  return reasons;
}

function score(t) {
  // 1. Activité : volume 24h rapporté à la market cap (20 pts)
  const turnover = t.marketCap ? t.vol.h24 / t.marketCap : 0;
  const activity = 20 * lin(turnover, 0.1, 1.5);

  // 2. Momentum : volume de la dernière heure vs moyenne horaire sur 6 h (15 pts)
  const hourlyAvg6h = t.vol.h6 / 6;
  const accel = hourlyAvg6h > 0 ? t.vol.h1 / hourlyAvg6h : 0;
  const momentum = 15 * lin(accel, 0.3, 2.5);

  // 3. Pression acheteuse : part des achats en nombre de transactions (20 pts)
  const ratio = (x) => (x.total ? x.buys / x.total : 0.5);
  const buyRatio = 0.6 * ratio(t.txns.h1) + 0.4 * ratio(t.txns.h24);
  const buyPressure = 20 * lin(buyRatio, 0.45, 0.65);

  // 4. Évolution du prix : tendance positive sans être déjà sur-étendu (15 pts)
  let price = 15 * (0.5 * lin(t.change.h1, -15, 20) + 0.5 * lin(t.change.h6, -20, 40));
  if (t.change.h24 > 300) price *= 0.6;

  // 5. Liquidité saine : 10-35 % de la MC + montant absolu (15 pts)
  const liqRatio = t.marketCap ? t.liquidity / t.marketCap : 0;
  const liqHealth = liqRatio <= 0.35 ? lin(liqRatio, 0.03, 0.1) : 1 - 0.5 * lin(liqRatio, 0.35, 1);
  const liquidity = 15 * (0.7 * liqHealth + 0.3 * lin(t.liquidity, 15_000, 120_000));

  // 6. Présence sociale (10 pts)
  const social = (t.twitter ? 4 : 0) + (t.telegram ? 3 : 0) + (t.website ? 3 : 0);

  // 7. Nombre de transactions = nombre de traders actifs (5 pts)
  const traders = 5 * lin(Math.log10(t.txns.h24.total + 1), Math.log10(150), Math.log10(5000));

  const breakdown = { activity, momentum, buyPressure, price, liquidity, social, traders };
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown, turnover, accel, buyRatio, liqRatio };
}

/** Applique le résultat RugCheck : rejet ou pénalité. */
function applyRugcheck(result, rug, cfg) {
  if (!rug || !rug.available) return { ...result, rugPenalty: 0 };
  if (rug.fatal) return { ...result, rejected: `RugCheck : ${rug.fatal}` };
  if (rug.score !== null && rug.score > cfg.rugcheckMaxScore) {
    return { ...result, rejected: `RugCheck : score de risque ${rug.score}/100` };
  }
  const penalty = Math.min(25, (rug.score || 0) * 0.2 + 5 * rug.dangers.length);
  return { ...result, total: Math.max(0, result.total - penalty), rugPenalty: penalty };
}

function fmtUsd(v) {
  if (!Number.isFinite(v)) return '?';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

module.exports = { hardFilters, score, applyRugcheck, fmtUsd };
