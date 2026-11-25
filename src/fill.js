/**
 * Exécution « comme en vrai » des comptes FTMO / Lucid simulés : un ordre n'est jamais rempli au prix exact du
 * signal. On attend FILL_DELAY_SEC secondes (temps de réaction d'un vrai bot : réception du signal, envoi de l'ordre)
 * puis on prend le cours de ce moment-là (OANDA en temps réel si OANDA_TOKEN, sinon dernière bougie 1 min de Yahoo).
 * Les stops et objectifs (ordres posés à l'avance chez le courtier) ne sont pas concernés.
 */
const { fetchYahoo } = require('./yahoo');

const SYMBOL = { gold: 'GC=F', nas100: '^NDX', spx: '^GSPC', eurusd: 'EURUSD=X', silver: 'SI=F', dow: '^DJI' };
const RESTING = /^(stop loss|take profit)$/;

/** Événements qui donnent un ordre au marché sur un des comptes (ouverture, sortie autre que stop / objectif). */
function marketsToFill(events, accounts) {
  const ids = new Set();
  for (const ev of events) {
    if (!accounts.some((a) => a.follows(ev))) continue;
    if (ev.type === 'open' || (ev.type === 'close' && !RESTING.test(ev.trade?.reason || ''))) ids.add(ev.market.id);
  }
  return [...ids];
}

/**
 * Cours actuel d'un marché (null si indisponible ou marché fermé : bougie de plus de 15 min).
 * withTime : { price, t } avec t = début de la bougie 1 min relevée (pour la comparer aux données du signal).
 */
async function quoteNow(cfg, id, fetcher = fetchYahoo, { withTime = false } = {}) {
  // Bougies OANDA (OANDA_TOKEN) : cours OANDA en temps réel (même source que les signaux) ; Nasdaq / S&P hors séance :
  // pas de cours (l'indice ne cote pas, le signal garde son prix, comme avec Yahoo)
  if (require('./markets').useOanda(cfg) && fetcher === fetchYahoo) {
    if (['nas100', 'spx', 'silver', 'dow'].includes(id) && !require('./oanda').nySession([{ t: Math.floor(Date.now() / 1000) }]).length) return null;
    const price = await require('./oanda').oandaQuote(cfg, id);
    return withTime ? (price ? { price, t: Math.floor(Date.now() / 1000) } : null) : price;
  }
  if (!SYMBOL[id] || (id === 'gold' && cfg.goldFeed === 'paxg')) return null;
  try {
    const c = await fetcher(SYMBOL[id], '1m', { range: '1d', attempts: 2, timeoutMs: 10_000 });
    const last = c?.[c.length - 1];
    if (!last || Date.now() / 1000 - last.t > 15 * 60) return null;
    return withTime ? { price: last.c, t: last.t } : last.c;
  } catch {
    return null;
  }
}

/**
 * Attend le délai puis relève le cours des marchés concernés : { [marché]: { price, t } } (null si rien à remplir).
 * Sans cours (marché fermé, erreur), le compte garde le prix du signal.
 * since : { [marché]: début de la dernière bougie 5 min qui a donné le signal } — un cours relevé sur une bougie 1 min
 * PLUS ANCIENNE que les données du signal (Yahoo : bougies 1 min et 5 min pas toujours au même retard, jusqu'à 15 min)
 * n'est pas « le cours 30 s après » : il est ignoré et le compte garde le prix du signal (25/11/2026 : vente or au
 * signal 3 549,30 $ « remplie » à 3 545,10 $, un cours d'avant le signal).
 */
async function delayedFills(cfg, events, accounts, { fetcher, since = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const delay = cfg.fillDelaySec || 0;
  if (!(delay > 0)) return null;
  const ids = marketsToFill(events, accounts);
  if (!ids.length) return null;
  await sleep(delay * 1000);
  const t = Math.floor(Date.now() / 1000);
  const fills = {};
  await Promise.all(ids.map(async (id) => {
    const q = await quoteNow(cfg, id, fetcher, { withTime: true });
    if (!q) return;
    if (Number.isFinite(since[id]) && q.t < since[id]) {
      console.warn(`[exécution] ${id} : cours relevé (bougie ${new Date(q.t * 1000).toISOString().slice(11, 16)} UTC) plus ancien que le signal → prix du signal gardé`);
      return;
    }
    fills[id] = { price: q.price, t };
  }));
  return fills;
}

module.exports = { delayedFills, marketsToFill, quoteNow, SYMBOL };
