/**
 * Export des statistiques du bot (commande admin /export) : un seul fichier JSON avec les comptes FTMO et Lucid,
 * les trades paper des stratégies suivies, les refus de l'IA et l'état de l'adaptation — pour une analyse hors du
 * serveur. Aucun secret : ni token, ni identifiant de canal, ni chemin du serveur.
 */
const { activeMarkets } = require('./markets');

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

/** Objet exporté. version : version déployée (commit). */
function buildExport(cfg, store, version = 'inconnue') {
  const followed = new Set([...(cfg.ftmoStrategies || []), ...(cfg.ftmoNasStrategies || [])]);
  const markets = {};
  for (const m of activeMarkets(cfg)) {
    const st = store.loadJson(m.file, null);
    if (!st?.accounts) continue;
    const accounts = {};
    for (const [sid, acc] of Object.entries(st.accounts)) {
      accounts[sid] = { followedByFtmo: followed.has(`${m.id}:${sid}`), position: acc.position || null, closed: acc.closed || [] };
    }
    markets[m.id] = { lastPrice: st.lastPrice ?? null, lastUpdate: st.lastUpdate ?? null, accounts };
  }
  const samples = store.loadJson('ai-samples.json', []).map(({ x, ...rest }) => rest); // sans les caractéristiques
  const out = {
    exportedAt: new Date().toISOString(),
    version,
    settings: settings(cfg),
    accounts: {
      ftmo: store.loadJson('ftmo.json', null),
      ftmoNasdaq: store.loadJson('ftmo-nas.json', null),
      lucid: store.loadJson('lucid.json', null),
    },
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
