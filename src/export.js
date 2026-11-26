/**
 * Export des statistiques du bot (commande admin /export) : un seul fichier JSON avec les comptes FTMO et Lucid,
 * les trades paper des stratégies suivies, les refus de l'IA et l'état de l'adaptation — pour une analyse hors du
 * serveur. Aucun secret : ni token, ni identifiant de canal, ni chemin du serveur.
 */
const { activeMarkets } = require('./markets');
const { selectStrategies } = require('./strategies');

const MAX_BYTES = 45 * 1024 * 1024;

/** Réglages utiles à l'analyse (sans secret). */
function settings(cfg) {
  return {
    ftmoProgram: cfg.ftmoProgram, ftmoCapital: cfg.ftmoCapital, ftmoRisk: cfg.ftmoRisk, ftmoIntradayRisk: cfg.ftmoIntradayRisk,
    ftmoComboNasRisk: cfg.ftmoComboNasRisk, ftmoEurRisk: cfg.ftmoEurRisk, ftmoSpxRisk: cfg.ftmoSpxRisk, ftmoDayStop: cfg.ftmoDayStop,
    ftmoSizing: cfg.ftmoSizing, ftmoAi: cfg.ftmoAi, ftmoNoHedge: cfg.ftmoNoHedge, ftmoCombined: cfg.ftmoCombined,
    ftmoStrategies: cfg.ftmoStrategies, ftmoNasStrategies: cfg.ftmoNasStrategies,
    lucidEnabled: cfg.lucidEnabled, lucidCapital: cfg.lucidCapital, lucidRiskMul: cfg.lucidRiskMul, lucidIntradayRisk: cfg.lucidIntradayRisk,
    autoAdapt: cfg.autoAdapt, adaptStrategies: cfg.adaptStrategies, goldFeed: cfg.goldFeed, publishFtmoOnly: cfg.publishFtmoOnly,
  };
}

/** Résumé d'un compte : gain, trades, R par trade (gain ÷ risque prévu), règle du meilleur jour. */
function summarize(a) {
  const closed = a.closed || [];
  const rs = closed.filter((t) => t.risk > 0).map((t) => t.pnl / t.risk);
  const gain = a.balance - a.capital;
  const best = Math.max(0, ...Object.values(a.dayPnl || {}));
  return {
    attempt: a.attempt, phase: a.phase, balance: Math.round(a.balance), gainPct: +((gain / a.capital) * 100).toFixed(2),
    trades: closed.length, wins: closed.filter((t) => t.pnl > 0).length, avgR: rs.length ? +(rs.reduce((x, y) => x + y, 0) / rs.length).toFixed(2) : null,
    worstR: rs.length ? +Math.min(...rs).toFixed(2) : null, openPositions: Object.keys(a.open || {}).length, tradingDays: (a.days || []).length,
    bestDay: Math.round(best), bestDayShareOfGain: gain > 0 ? +((best / gain) * 100).toFixed(0) : null,
  };
}

/** Objet exporté. version : version déployée (commit). */
function buildExport(cfg, store, version = 'inconnue') {
  const followed = new Set([...(cfg.ftmoStrategies || []), ...(cfg.ftmoNasStrategies || [])]);
  const markets = {};
  for (const m of activeMarkets(cfg)) {
    const st = store.loadJson(m.file, null);
    if (!st?.accounts) continue;
    const accounts = {};
    // Seulement les stratégies réellement suivies en paper sur ce marché (pas les anciens comptes figés)
    const live = new Set(selectStrategies(m.strategies || []).map((x) => x.id));
    for (const [sid, acc] of Object.entries(st.accounts)) {
      if (!live.has(sid)) continue;
      accounts[sid] = { followedByFtmo: followed.has(`${m.id}:${sid}`), position: acc.position || null, closed: acc.closed || [] };
    }
    markets[m.id] = { lastPrice: st.lastPrice ?? null, lastUpdate: st.lastUpdate ?? null, accounts };
  }
  const samples = store.loadJson('ai-samples.json', []).map(({ x, ...rest }) => rest); // sans les caractéristiques
  const accounts = {
    ftmo: store.loadJson('ftmo.json', null),
    ftmoNasdaq: store.loadJson('ftmo-nas.json', null),
    lucid: store.loadJson('lucid.json', null),
    lucidFunded: store.loadJson('lucid-funded.json', null),
  };
  const out = {
    exportedAt: new Date().toISOString(),
    version,
    settings: settings(cfg),
    summary: Object.fromEntries(Object.entries(accounts).filter(([, a]) => a?.capital).map(([k, a]) => [k, summarize(a)])),
    accounts,
    aiRefused: { ftmo: store.loadJson('ftmo-ia-refuses.json', []), lucid: store.loadJson('lucid-ia-refuses.json', []) },
    aiSamples: samples,
    adapt: store.loadJson('adapt.json', null),
    markets,
  };
  // Trop gros pour Telegram : on garde les trades les plus récents
  let json = JSON.stringify(out);
  for (let keep = 2000; json.length > MAX_BYTES && keep >= 50; keep = Math.floor(keep / 2)) {
    for (const mk of Object.values(out.markets)) for (const a of Object.values(mk.accounts)) a.closed = a.closed.slice(-keep);
    out.aiSamples = out.aiSamples.slice(-keep);
    json = JSON.stringify(out);
  }
  return out;
}

module.exports = { buildExport };
