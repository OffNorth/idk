/**
 * Marchés tradés en simulation : sources de données, stratégies, frais et financement.
 *   gold   : or via PAXG/USD (Coinbase, secours Kraken) — EUR/USD Kraken pour la stratégie dollar
 *   nas100 : Nasdaq 100 via l'indice ^NDX (Yahoo Finance)
 */
const { MarketTrader, fetchCandles, cachedHistory, rollingHistory, fetchEurUsd } = require('./gold');
const { fetchYahoo } = require('./yahoo');
const { aggregate } = require('./history');
const { auxSymbol } = require('./aux');
const oanda = require('./oanda');

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

/** Bougies intraday OANDA si un jeton est configuré (OANDA_TOKEN) et que INTRADAY_FEED ≠ yahoo. */
const useOanda = (cfg) => !!cfg.oandaToken && cfg.intradayFeed !== 'yahoo';
const oaFail = new Map(); // marché → début de la panne OANDA (ms)
/** Après 30 min de panne OANDA, le marché repasse sur Yahoo (avec décalage des positions) ; avant, passage ignoré. */
const OA_FALLBACK_MS = 30 * 60_000;

/**
 * Séries intraday d'un marché depuis OANDA : 5 min sur 60 jours (complétées chaque minute), 15 min (agrégées),
 * 1 min si demandé. session = true (Nasdaq, S&P) : seulement la séance de New York, comme l'indice chez Yahoo.
 * Retourne null si OANDA est en panne depuis plus de 30 min (le marché passe alors sur Yahoo) ; lève une erreur
 * (passage ignoré) pour une panne plus courte, pour ne pas changer de source à chaque coupure.
 */
async function oandaIntraday(cfg, id, tfs, { session = false } = {}) {
  const ins = oanda.INSTRUMENT[id];
  const keep = (c) => (session ? oanda.nySession(c) : c);
  const track = (load) => async () => {
    try {
      const out = await load();
      oaFail.delete(id);
      return out;
    } catch (err) {
      if (!oaFail.has(id)) oaFail.set(id, Date.now());
      throw err;
    }
  };
  try {
    const now = Math.floor(Date.now() / 1000);
    const [long, recent] = await Promise.all([
      cached(`oa:${id}:5m60`, 1800, track(() => oanda.fetchOanda(cfg, ins, 300, { from: now - 60 * 86400 }))),
      cached(`oa:${id}:5m`, 50, track(() => oanda.fetchOanda(cfg, ins, 300, { count: 300 }))),
    ]);
    if (oaFail.has(id)) throw new Error('OANDA ne répond plus (dernières bougies gardées)');
    const byT = new Map((long || []).map((c) => [c.t, c]));
    for (const c of recent || []) byT.set(c.t, c);
    const m5 = keep([...byT.values()].sort((a, b) => a.t - b.t));
    if (!m5.length) throw new Error(`OANDA ${ins} : aucune bougie`);
    const series = { '5m': m5, '15m': aggregate(m5, 900, 300) };
    if (tfs.includes('1m')) series['1m'] = keep(await cached(`oa:${id}:1m`, 45, track(() => oanda.fetchOanda(cfg, ins, 60, { count: 3000 }))) || []);
    return { m5, series, price: m5[m5.length - 1].c };
  } catch (err) {
    if (oaFail.has(id) && Date.now() - oaFail.get(id) > OA_FALLBACK_MS) {
      console.warn(`[${id}] OANDA en panne depuis plus de 30 min (${err.message}) : bougies Yahoo`);
      return null;
    }
    throw err;
  }
}

/** Écart de cotation OANDA − Yahoo (médiane sur les dernières bougies 5 min communes), pour changer de source. */
async function basisOf(cfg, id, yahooSym, session) {
  const ins = oanda.INSTRUMENT[id];
  const [y, o] = await Promise.all([
    fetchYahoo(yahooSym, '5m', { range: '5d', ...LIVE }),
    oanda.fetchOanda(cfg, ins, 300, { count: 2000 }),
  ]);
  const ym = new Map(y.map((c) => [c.t, c.c]));
  const diffs = (session ? oanda.nySession(o) : o).filter((c) => ym.has(c.t)).slice(-12).map((c) => c.c - ym.get(c.t)).sort((a, b) => a - b);
  if (!diffs.length) return null;
  return diffs[Math.floor(diffs.length / 2)];
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
    scalpFeePct: cfg.goldScalpFeePct,
    financingPct: cfg.goldFinancingPct,
    yahooSymbol: 'GC=F',
    session: false,
    basis: () => basisOf(cfg, 'gold', 'GC=F', false),
    async fetch(tfs, { needsFx, needsVix, aux: auxList = [] } = {}) {
      const yahoo = (key, sym) => cached(key, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
      if (cfg.goldFeed !== 'paxg') {
        // Or « réel » (GOLD_FEED=future, par défaut) : future GC=F de Yahoo, qui suit l'or au comptant que trade un compte
        // FTMO. PAXG (jeton Binance / Coinbase) cote différemment en intraday (marché peu liquide, faux retours à la moyenne).
        // Avec OANDA_TOKEN : bougies 1 / 5 / 15 min de l'or au comptant OANDA (XAU_USD) en temps réel
        const oa = useOanda(cfg) ? await oandaIntraday(cfg, 'gold', tfs) : null;
        const [m5y, d1, fx, vix, aux, h1] = await Promise.all([
          oa ? null : cached('gc5m', 120, () => fetchYahoo('GC=F', '5m', { range: '5d', ...LIVE })),
          cached('gc1d', 3600, () => fetchYahoo('GC=F', '1d', { range: '2y', ...LIVE })),
          needsFx ? fetchEurUsd() : null,
          needsVix ? yahoo('vix1d', '^VIX') : null,
          fetchAux('gold', auxList),
          tfs.some((tf) => tf === '1h' || tf === '6h') ? cached('gc1h', 900, () => fetchYahoo('GC=F', '1h', { range: '730d', ...LIVE })) : null,
        ]);
        const m5 = oa ? oa.m5 : m5y;
        const series = { '1d': d1, '1h': h1, '6h': h1 ? aggregate(h1, 21600) : null, '5m': m5 };
        if (oa) {
          Object.assign(series, oa.series);
          return { price: oa.price, stops: m5, daily: d1, fx, vix, aux, series, feed: 'oanda' };
        }
        if (tfs.some((tf) => tf === '5m' || tf === '15m')) {
          const long = await cached('gc5m60', 1800, () => fetchYahoo('GC=F', '5m', { range: '60d', ...LIVE })).catch(() => null);
          if (long?.length) {
            const byT = new Map(long.map((c) => [c.t, c]));
            for (const c of m5 || []) byT.set(c.t, c);
            series['5m'] = [...byT.values()].sort((x, y) => x.t - y.t);
          }
          series['15m'] = series['5m'] ? aggregate(series['5m'], 900, 300) : null;
        }
        if (tfs.includes('1m')) series['1m'] = await cached('gc1m', 60, () => fetchYahoo('GC=F', '1m', { range: '5d', ...LIVE })).catch(() => null);
        return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx, vix, aux, series, feed: 'yahoo' };
      }
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
    yahooSymbol: '^NDX',
    session: true,
    basis: () => basisOf(cfg, 'nas100', '^NDX', true),
    async fetch(tfs, { needsVix, aux: auxList = [] } = {}) {
      const needIntraday = tfs.some((tf) => tf === '1h' || tf === '6h');
      const yahoo = (key, sym) => cached(key, 3600, () => fetchYahoo(sym, '1d', { range: '2y', ...LIVE })).catch(() => null);
      // Avec OANDA_TOKEN : bougies 5 / 15 min du CFD NAS100_USD en temps réel, séance de New York seulement
      const oa = useOanda(cfg) ? await oandaIntraday(cfg, 'nas100', tfs, { session: true }) : null;
      const [m5y, d1, h1, vix, aux] = await Promise.all([
        oa ? null : cached('ndx5m', 120, () => fetchYahoo('^NDX', '5m', { range: '5d', ...LIVE })),
        cached('ndx1d', 3600, () => fetchYahoo('^NDX', '1d', { range: '2y', ...LIVE })),
        needIntraday ? cached('ndx1h', 900, () => fetchYahoo('^NDX', '1h', { range: '730d', ...LIVE })) : null,
        needsVix ? yahoo('vix1d', '^VIX') : null,
        fetchAux('nas100', auxList),
      ]);
      const m5 = oa ? oa.m5 : m5y;
      const series = { '1d': d1, '1h': h1, '6h': h1 ? aggregate(h1, 21600) : null, '5m': m5 };
      if (oa) {
        Object.assign(series, oa.series);
        return { price: oa.price, stops: m5, daily: d1, fx: null, vix, aux, series, feed: 'oanda' };
      }
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
      return { price: m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx: null, vix, aux, series, feed: 'yahoo' };
    },
  };
}

function eurusdMarket(cfg) {
  return {
    id: 'eurusd',
    name: 'EUR/USD',
    emoji: '💶',
    file: 'eurusd.json',
    enabled: cfg.eurusdEnabled,
    strategies: cfg.eurusdStrategies,
    startCapital: cfg.eurusdStartCapital,
    positionPct: cfg.eurusdPositionPct,
    feePct: cfg.eurusdFeePct,
    financingPct: cfg.eurusdFinancingPct,
    yahooSymbol: 'EURUSD=X',
    session: false,
    basis: () => basisOf(cfg, 'eurusd', 'EURUSD=X', false),
    async fetch(tfs, { needsVix, aux: auxList = [] } = {}) {
      const oa = useOanda(cfg) ? await oandaIntraday(cfg, 'eurusd', tfs) : null;
      const [m5y, d1, vix, aux] = await Promise.all([
        oa ? null : cached('eurusd5m', 120, () => fetchYahoo('EURUSD=X', '5m', { range: '5d', ...LIVE })).catch(() => null),
        cached('eurusd1d', 3600, () => fetchYahoo('EURUSD=X', '1d', { range: '2y', ...LIVE })),
        needsVix ? cached('vix1d', 3600, () => fetchYahoo('^VIX', '1d', { range: '2y', ...LIVE })).catch(() => null) : null,
        fetchAux('eurusd', auxList),
      ]);
      const m5 = oa ? oa.m5 : m5y;
      const series = { '1d': d1, '5m': m5, '1h': m5 ? aggregate(m5, 3600, 300) : null, ...(oa ? { '15m': oa.series['15m'] } : {}) };
      return { price: oa ? oa.price : m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx: null, vix, aux, series, feed: oa ? 'oanda' : 'yahoo' };
    },
  };
}

function spxMarket(cfg) {
  return {
    id: 'spx',
    name: 'S&P 500',
    emoji: '🗽',
    file: 'spx.json',
    enabled: cfg.spxEnabled,
    strategies: cfg.spxStrategies,
    startCapital: cfg.spxStartCapital,
    positionPct: cfg.spxPositionPct,
    feePct: cfg.spxFeePct,
    financingPct: cfg.spxFinancingPct,
    yahooSymbol: '^GSPC',
    session: true,
    basis: () => basisOf(cfg, 'spx', '^GSPC', true),
    async fetch(tfs, { needsVix, aux: auxList = [] } = {}) {
      const oa = useOanda(cfg) ? await oandaIntraday(cfg, 'spx', tfs, { session: true }) : null;
      const [m5y, d1, vix, aux] = await Promise.all([
        oa ? null : cached('spx5m', 120, () => fetchYahoo('^GSPC', '5m', { range: '5d', ...LIVE })).catch(() => null),
        cached('spx1d', 3600, () => fetchYahoo('^GSPC', '1d', { range: '2y', ...LIVE })),
        needsVix ? cached('vix1d', 3600, () => fetchYahoo('^VIX', '1d', { range: '2y', ...LIVE })).catch(() => null) : null,
        fetchAux('spx', auxList),
      ]);
      const m5 = oa ? oa.m5 : m5y;
      const series = { '1d': d1, '5m': m5, '1h': m5 ? aggregate(m5, 3600, 300) : null, ...(oa ? { '15m': oa.series['15m'] } : {}) };
      return { price: oa ? oa.price : m5?.[m5.length - 1]?.c ?? d1?.[d1.length - 1]?.c, stops: m5, daily: d1, fx: null, vix, aux, series, feed: oa ? 'oanda' : 'yahoo' };
    },
  };
}

/** Tous les marchés (actifs ou non). */
function allMarkets(cfg) {
  // Nasdaq en premier : marché par défaut du panneau, du résumé, des bilans et du jeu ; l'or suit
  return [nasMarket(cfg), goldMarket(cfg), spxMarket(cfg), eurusdMarket(cfg)];
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

module.exports = { useOanda, oandaIntraday, basisOf, goldMarket, nasMarket, eurusdMarket, spxMarket, allMarkets, activeMarkets, marketById, GoldTrader, MarketTrader };
