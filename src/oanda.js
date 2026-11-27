/**
 * Bougies en temps réel OANDA (API v20, compte démo gratuit « fxTrade Practice ») : prix CFD comme ceux d'un compte
 * FTMO, sans le retard d'environ 10 min des futures CME sur Yahoo (GC=F).
 * Jeton : OANDA_TOKEN dans le .env (jamais dans le code ni dans le chat) ; OANDA_ENV=live pour un compte réel.
 */
const INSTRUMENT = { gold: 'XAU_USD', nas100: 'NAS100_USD', spx: 'SPX500_USD', eurusd: 'EUR_USD', silver: 'XAG_USD', dow: 'US30_USD', russell: 'US2000_USD' };
const GRAN = { 5: 'S5', 60: 'M1', 300: 'M5', 900: 'M15', 3600: 'H1', 86400: 'D' };

const hostOf = (cfg) => (cfg.oandaEnv === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com');

/** Réponse OANDA → bougies { t, o, h, l, c, v } (horodatage UNIX en secondes, prix milieu). */
function parseCandles(json) {
  const out = [];
  for (const k of json?.candles || []) {
    const m = k.mid;
    if (!m) continue;
    const t = Math.round(Number(k.time));
    const c = { t, o: +m.o, h: +m.h, l: +m.l, c: +m.c, v: k.volume || 0 };
    if ([t, c.o, c.h, c.l, c.c].every(Number.isFinite)) out.push(c);
  }
  return out;
}

/**
 * Bougies d'un instrument. opts : { count } (≤ 5000, les plus récentes) ou { from } (secondes, pages de 5000
 * jusqu'à maintenant). La bougie en cours (incomplète) est incluse, comme chez Yahoo.
 */
async function fetchOanda(cfg, instrument, barSec, opts = {}, fetcher = fetch) {
  if (!cfg.oandaToken) throw new Error('OANDA_TOKEN manquant');
  const gran = GRAN[barSec];
  if (!gran) throw new Error(`OANDA : unité de temps ${barSec} s non prise en charge`);
  const get = async (params) => {
    const url = `${hostOf(cfg)}/v3/instruments/${instrument}/candles?${new URLSearchParams({ price: 'M', granularity: gran, ...params })}`;
    const res = await fetcher(url, {
      headers: { authorization: `Bearer ${cfg.oandaToken}`, 'accept-datetime-format': 'UNIX', accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new Error(`OANDA ${instrument} ${gran} : HTTP ${res.status}`);
    return parseCandles(await res.json());
  };
  if (opts.from == null) return get({ count: String(Math.min(5000, opts.count ?? 500)) });
  const byT = new Map();
  let from = opts.from;
  for (let page = 0; page < 20; page++) {
    const rows = await get({ from: String(from), count: '5000' });
    for (const c of rows) byT.set(c.t, c);
    if (rows.length < 5000) break;
    from = rows[rows.length - 1].t + 1;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Dernier cours (bougie 5 s), null si indisponible ou marché fermé (bougie de plus de 15 min). */
async function oandaQuote(cfg, marketId, fetcher = fetch) {
  const ins = INSTRUMENT[marketId];
  if (!ins || !cfg.oandaToken) return null;
  try {
    const rows = await fetchOanda(cfg, ins, 5, { count: 2, timeoutMs: 10_000 }, fetcher);
    const last = rows[rows.length - 1];
    if (!last || Date.now() / 1000 - last.t > 15 * 60) return null;
    return last.c;
  } catch {
    return null;
  }
}

const NYF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
/** Bougies de la séance de New York seulement (9 h 30 → 16 h, lundi → vendredi), comme les données d'indice Yahoo. */
function nySession(candles) {
  return candles.filter((c) => {
    const p = require('./nytime').nyParts(c.t);
    if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
    const m = p.min;
    return m >= 9 * 60 + 30 && m < 16 * 60;
  });
}

module.exports = { fetchOanda, oandaQuote, parseCandles, nySession, INSTRUMENT, hostOf };
