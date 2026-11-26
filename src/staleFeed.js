/**
 * Secours des bougies intraday quand Yahoo les fige (jours fériés américains, panne) alors que son dernier cours,
 * lui, continue d'avancer : le bot fabrique ses propres bougies de 1 minute avec le cours relevé à chaque passage
 * (≈ 1 relevé par minute), placées après la dernière bougie Yahoo, et regroupées en 5 et 15 minutes.
 * Moins précis que de vraies bougies : un seul cours par minute, donc pas les pics à l'intérieur de la minute.
 *
 * Activé seulement si : la dernière bougie Yahoo date de plus de STALE_MIN minutes ET le cours Yahoo date de moins
 * de FRESH_MIN minutes (le marché tourne). Marché fermé (cours figé lui aussi) : rien. OANDA / Binance : jamais
 * utilisé, leurs bougies sont en temps réel. STALE_FEED_FALLBACK=0 pour le couper.
 */
const { fetchQuote } = require('./yahoo');

const STALE_MIN = 25; // Yahoo a ≈ 10 min de retard sur les futures : au-delà de 25 min, les bougies sont figées
const FRESH_MIN = 15;
const KEEP_SEC = 2 * 86400;
const books = new Map(); // marché → { bars: Map(minute → bougie), active }

/** Regroupe des bougies 1 min en bougies de `sec` (garde aussi la bougie en cours, même incomplète). */
function group(bars, sec) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / sec) * sec;
    const cur = out[out.length - 1];
    if (!cur || cur.t !== t) out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, syn: true });
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  return out;
}

const lastT = (l) => (l?.length ? l[l.length - 1].t : null);

/**
 * Complète les données d'un marché (résultat de market.fetch) si les bougies Yahoo sont figées.
 * quoteOf : (symbole) → { price, t } (cours Yahoo et son heure, en secondes). Retourne les données (modifiées ou non).
 */
async function patch(market, data, { now = Math.floor(Date.now() / 1000), quoteOf = fetchQuote, log = console.log } = {}) {
  if (!data || (data.feed && data.feed !== 'yahoo') || !market.yahooSymbol || !data.series) return data;
  const s5 = data.series['5m'] || data.stops;
  const s1 = data.series['1m'];
  const end = Math.max((lastT(s5) ?? 0) + 300, (lastT(s1) ?? 0) + 60); // fin de la dernière bougie Yahoo
  const B = books.get(market.id) || { bars: new Map(), active: false };
  books.set(market.id, B);
  const stop = (why) => {
    if (B.active) log(`[${market.id}] bougies Yahoo de retour : fin du secours (${why})`);
    B.active = false;
    return data;
  };
  if (now - end < STALE_MIN * 60) return stop('bougies à jour');
  let q;
  try { q = await quoteOf(market.yahooSymbol); } catch { return data; }
  if (!q?.price || !(now - q.t < FRESH_MIN * 60)) return stop('marché fermé');
  // Relevé du passage → bougie de la minute du cours
  const m = Math.floor(q.t / 60) * 60;
  const b = B.bars.get(m) || { t: m, o: q.price, h: q.price, l: q.price, c: q.price, v: 0, syn: true };
  b.h = Math.max(b.h, q.price); b.l = Math.min(b.l, q.price); b.c = q.price;
  B.bars.set(m, b);
  for (const k of B.bars.keys()) if (k < now - KEEP_SEC) B.bars.delete(k);
  const own = [...B.bars.values()].filter((x) => x.t >= end).sort((x, y) => x.t - y.t);
  if (!own.length) return data;
  if (!B.active) log(`[${market.id}] bougies Yahoo figées depuis ${new Date(end * 1000).toISOString().slice(11, 16)} UTC, cours à jour : secours avec des bougies maison (1 relevé par minute)`);
  B.active = true;
  const series = { ...data.series };
  // Ajoute les bougies maison après les bougies Yahoo (fusion si elles partagent la même bougie de début)
  const add = (list, sec) => {
    const base = (list || []).filter((x) => x.t < end).map((x) => ({ ...x }));
    for (const g of group(own, sec)) {
      const last = base[base.length - 1];
      if (last && g.t <= last.t) { if (g.t === last.t) { last.h = Math.max(last.h, g.h); last.l = Math.min(last.l, g.l); last.c = g.c; } continue; }
      base.push(g);
    }
    return base;
  };
  if (series['1m']) series['1m'] = add(series['1m'], 60);
  if (series['5m']) series['5m'] = add(series['5m'], 300);
  if (series['15m']) series['15m'] = add(series['15m'], 900);
  const stops = add(data.stops || series['5m'], 300);
  return { ...data, series, stops, price: q.price, synthetic: true };
}

module.exports = { patch, group, STALE_MIN, FRESH_MIN, _books: books };
