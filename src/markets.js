/**
 * Marchés tradés en simulation : sources de données, stratégies, frais et financement.
 *   gold   : or via PAXG/USD (Coinbase, secours Kraken) — EUR/USD Kraken pour la stratégie dollar
 *   nas100 : Nasdaq 100 via l'indice ^NDX (Yahoo Finance)
 */
const { MarketTrader, fetchCandles, cachedHistory, rollingHistory, fetchEurUsd } = require('./gold');
const { fetchYahoo } = require('./yahoo');
const { aggregate } = require('./history');
const { auxSymbol } = require('./aux');

/** En direct : 2 essais de 15 s au plus, pour ne pas bloquer le passage si Yahoo répond mal. */
const LIVE = { attempts: 2, timeoutMs: 15_000 };

/** Séries externes journalières demandées par les stratégies (taux, dollar, argent, SOX, autre marché). */
async function fetchAux(marketId, keys = []) {
  const out = {};
  await Promise.all(keys.map(async (k) => {
    const sym = auxSymbol(k, marketId);
    if (sym) out[k] = await cached(`aux:${sym}`, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
  }));
  return out;
}

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
    async fetch(tfs, { needsFx, needsVix, aux: auxList = [] } = {}) {
      const yahoo = (key, sym) => cached(key, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
      const [m5, d1, fx, vix, aux, ...more] = await Promise.all([
        fetchCandles(300),
        cachedHistory(86400, 500, 3600),
        needsFx ? fetchEurUsd() : null,
        needsVix ? yahoo('vix1d', '^VIX') : null,
        fetchAux('gold', auxList),
        ...tfs.map((tf) => (tf === '1d' ? null : tf === '6h' ? cachedHistory(21600, 150, 1800)
          : tf === '5m' ? rollingHistory(300, 5) : tf === '15m' ? rollingHistory(900, 10) : tf === '1m' ? rollingHistory(60, 2) : fetchCandles(3600))),
      ]);
      const series = {};
      tfs.forEach((tf, k) => {
        series[tf] = tf === '1d' ? d1 : more[k];
      });
      return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx, vix, aux, series };
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
    async fetch(tfs, { needsVix, aux: auxList = [] } = {}) {
      const needIntraday = tfs.some((tf) => tf === '1h' || tf === '6h');
      const yahoo = (key, sym) => cached(key, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
      const [m5, d1, h1, vix, aux] = await Promise.all([
        cached('ndx5m', 120, () => fetchYahoo('^NDX', '5m', { range: '5d', ...LIVE })),
        cached('ndx1d', 3600, () => fetchYahoo('^NDX', '1d', { range: '2y', ...LIVE })),
        needIntraday ? cached('ndx1h', 900, () => fetchYahoo('^NDX', '1h', { range: '730d', ...LIVE })) : null,
        needsVix ? yahoo('vix1d', '^VIX') : null,
        fetchAux('nas100', auxList),
      ]);
      const series = { '1d': d1, '1h': h1, '6h': h1 ? aggregate(h1, 21600) : null, '5m': m5 };
      // Stratégies 5 / 15 min : il faut plus que 5 jours de bougies (tendance 1 h, réchauffage) → 60 jours, complétés
      // à chaque passage par les 5 derniers jours (bougies récentes)
      if (tfs.includes('15m') || tfs.includes('5m')) {
        const long = await cached('ndx5m60', 1800, () => fetchYahoo('^NDX', '5m', { range: '60d', ...LIVE })).catch(() => null);
        if (long?.length) {
          const byT = new Map(long.map((c) => [c.t, c]));
          for (const c of m5 || []) byT.set(c.t, c);
          series['5m'] = [...byT.values()].sort((x, y) => x.t - y.t);
          series['15m'] = aggregate(series['5m'], 900, 300);
        }
      }
      return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx: null, vix, aux, series };
    },
  };
}

/** Tous les marchés (actifs ou non). */
function allMarkets(cfg) {
  // Nasdaq en premier : marché par défaut du panneau, du résumé, des bilans et du jeu ; l'or suit
  return [nasMarket(cfg), goldMarket(cfg)];
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
