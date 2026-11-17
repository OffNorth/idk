/**
 * Marchés tradés en simulation : sources de données, stratégies, frais et financement.
 *   gold   : or via PAXG/USD (Coinbase, secours Kraken) — EUR/USD Kraken pour la stratégie dollar
 *   nas100 : Nasdaq 100 via l'indice ^NDX (Yahoo Finance)
 */
const { MarketTrader, fetchCandles, cachedHistory, fetchEurUsd } = require('./gold');
const { fetchYahoo } = require('./yahoo');
const { aggregate } = require('./history');

/** En direct : 2 essais de 15 s au plus, pour ne pas bloquer le passage si Yahoo répond mal. */
const LIVE = { attempts: 2, timeoutMs: 15_000 };

/** Cache mémoire avec durée de vie ; en cas d'erreur, renvoie la dernière valeur connue. */
const memo = new Map();
async function cached(key, ttlSec, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttlSec * 1000) return hit.data;
  try {
    const data = await load();
    if (data?.length) memo.set(key, { at: Date.now(), data });
    return data?.length ? data : hit?.data ?? null;
  } catch (err) {
    if (hit) return hit.data;
    throw err;
  }
}

function goldMarket(cfg) {
  return {
    id: 'gold',
    name: 'Or',
    emoji: '🥇',
    file: 'gold.json',
    enabled: cfg.goldEnabled,
    strategies: cfg.goldStrategies,
    startCapital: cfg.goldStartCapital,
    positionPct: cfg.goldPositionPct,
    feePct: cfg.goldFeePct,
    financingPct: cfg.goldFinancingPct,
    async fetch(tfs, { needsFx, needsVix, needsTnx, needsDxy } = {}) {
      const yahoo = (key, sym) => cached(key, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
      const [m5, d1, fx, vix, tnx, dxy, ...more] = await Promise.all([
        fetchCandles(300),
        cachedHistory(86400, 500, 3600),
        needsFx ? fetchEurUsd() : null,
        needsVix ? yahoo('vix1d', '^VIX') : null,
        needsTnx ? yahoo('tnx1d', '^TNX') : null,
        needsDxy ? yahoo('dxy1d', 'DX-Y.NYB') : null,
        ...tfs.map((tf) => (tf === '1d' ? null : tf === '6h' ? cachedHistory(21600, 150, 1800) : fetchCandles(3600))),
      ]);
      const series = {};
      tfs.forEach((tf, k) => {
        series[tf] = tf === '1d' ? d1 : more[k];
      });
      return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx, vix, aux: { tnx, dxy }, series };
    },
  };
}

function nasMarket(cfg) {
  return {
    id: 'nas100',
    name: 'Nasdaq 100',
    emoji: '🇺🇸',
    file: 'nas100.json',
    enabled: cfg.nasEnabled,
    strategies: cfg.nasStrategies,
    startCapital: cfg.nasStartCapital,
    positionPct: cfg.nasPositionPct,
    feePct: cfg.nasFeePct,
    financingPct: cfg.nasFinancingPct,
    async fetch(tfs, { needsVix } = {}) {
      const needIntraday = tfs.some((tf) => tf === '1h' || tf === '6h');
      const [m5, d1, h1, vix] = await Promise.all([
        cached('ndx5m', 120, () => fetchYahoo('^NDX', '5m', { range: '5d', ...LIVE })),
        cached('ndx1d', 3600, () => fetchYahoo('^NDX', '1d', { range: '2y', ...LIVE })),
        needIntraday ? cached('ndx1h', 900, () => fetchYahoo('^NDX', '1h', { range: '730d', ...LIVE })) : null,
        needsVix ? cached('vix1d', 3600, () => fetchYahoo('^VIX', '1d', { range: '2y', ...LIVE })).catch(() => null) : null,
      ]);
      const series = { '1d': d1, '1h': h1, '6h': h1 ? aggregate(h1, 21600) : null, '5m': m5 };
      return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx: null, vix, series };
    },
  };
}

/** Tous les marchés (actifs ou non). */
function allMarkets(cfg) {
  return [goldMarket(cfg), nasMarket(cfg)];
}

/** Marchés actifs. */
function activeMarkets(cfg) {
  return allMarkets(cfg).filter((m) => m.enabled);
}

function marketById(cfg, id) {
  return allMarkets(cfg).find((m) => m.id === id);
}

/** Compatibilité : trader de l'or. */
class GoldTrader extends MarketTrader {
  constructor(store, cfg) {
    super(goldMarket(cfg), store, cfg);
  }
}

module.exports = { goldMarket, nasMarket, allMarkets, activeMarkets, marketById, GoldTrader, MarketTrader };
