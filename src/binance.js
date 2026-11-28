/**
 * Bougies en temps réel sans compte ni clé : contrats perpétuels publics de Binance (USDT-M) sur l'or et l'argent.
 *   gold → XAUUSDT, silver → XAGUSDT. Données publiques : https://fapi.binance.com/fapi/v1/klines (aucune inscription,
 *   aucune donnée personnelle). Ces contrats suivent l'or / l'argent au comptant (or : ≈ +7 $ d'écart, corrélation 0,997
 *   des variations 5 min sur novembre 2026), mais ils cotent aussi le week-end et pendant la pause quotidienne du
 *   marché de l'or : ces bougies-là sont retirées (le bot ne trade que quand le vrai marché est ouvert).
 * Binance bloque certains pays et certains hébergeurs (« restricted location ») : le bot repasse alors sur Yahoo.
 * BINANCE_FEED=0 pour ne jamais l'utiliser.
 */
const SYMBOL = { gold: 'XAUUSDT', silver: 'XAGUSDT' };
const HOST = 'https://fapi.binance.com';
const INTERVAL = { 60: '1m', 300: '5m', 900: '15m', 3600: '1h', 14400: '4h', 86400: '1d' };

/** [openTime ms, open, high, low, close, volume, …] → { t (s), o, h, l, c, v } */
const parseKlines = (rows) => (Array.isArray(rows) ? rows : [])
  .map((r) => ({ t: Math.floor(Number(r[0]) / 1000), o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], ...(r[9] !== undefined ? { bv: +r[9] } : {}) })) // bv : achats agressifs (delta)
  .filter((c) => Number.isFinite(c.t) && c.c > 0);

/** Une page de bougies (au plus 1500). */
async function klines(symbol, barSec, { startSec, endSec, limit = 1500 } = {}, fetcher = fetch) {
  const q = new URLSearchParams({ symbol, interval: INTERVAL[barSec], limit: String(limit) });
  if (startSec) q.set('startTime', String(startSec * 1000));
  if (endSec) q.set('endTime', String(endSec * 1000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetcher(`${HOST}/fapi/v1/klines?${q}`, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Binance ${symbol} ${res.status}${body?.msg ? ` : ${body.msg}` : ''}`);
    return parseKlines(body);
  } finally {
    clearTimeout(timer);
  }
}

/** Bougies depuis `fromSec` (plusieurs pages si besoin), la bougie en cours comprise. */
async function fetchRange(symbol, barSec, fromSec, fetcher = fetch) {
  const out = new Map();
  let start = fromSec;
  for (let page = 0; page < 40; page++) {
    const rows = await klines(symbol, barSec, { startSec: start }, fetcher);
    for (const c of rows) out.set(c.t, c);
    if (rows.length < 1500) break;
    start = rows[rows.length - 1].t + barSec;
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

const ETF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
/**
 * Heures d'ouverture des métaux (CME / or au comptant) : dimanche 18 h → vendredi 17 h (heure de New York),
 * pause de 17 h à 18 h chaque jour. Retire les bougies cotées par Binance quand le vrai marché est fermé.
 */
function metalsOpen(candles) {
  return candles.filter((c) => {
    const p = require('./nytime').nyParts(c.t);
    const h = p.hour;
    if (p.weekday === 'Sat') return false;
    if (p.weekday === 'Sun') return h >= 18;
    if (p.weekday === 'Fri') return h < 17;
    return h !== 17;
  });
}

/** Le marché tourne-t-il maintenant ? (même règle que metalsOpen) */
const openNow = (t = Math.floor(Date.now() / 1000)) => metalsOpen([{ t }]).length === 1;

module.exports = { SYMBOL, HOST, klines, fetchRange, parseKlines, metalsOpen, openNow };
