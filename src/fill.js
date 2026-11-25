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

/** Cours actuel d'un marché (null si indisponible ou marché fermé : bougie de plus de 15 min). */
async function quoteNow(cfg, id, fetcher = fetchYahoo) {
  // Bougies OANDA (OANDA_TOKEN) : cours OANDA en temps réel (même source que les signaux) ; Nasdaq / S&P hors séance :
  // pas de cours (l'indice ne cote pas, le signal garde son prix, comme avec Yahoo)
  if (require('./markets').useOanda(cfg) && fetcher === fetchYahoo) {
    if (['nas100', 'spx', 'silver', 'dow'].includes(id) && !require('./oanda').nySession([{ t: Math.floor(Date.now() / 1000) }]).length) return null;
    return require('./oanda').oandaQuote(cfg, id);
  }
  if (!SYMBOL[id] || (id === 'gold' && cfg.goldFeed === 'paxg')) return null;
  try {
    const c = await fetcher(SYMBOL[id], '1m', { range: '1d', attempts: 2, timeoutMs: 10_000 });
    const last = c?.[c.length - 1];
    if (!last || Date.now() / 1000 - last.t > 15 * 60) return null;
    return last.c;
  } catch {
    return null;
  }
}

/**
 * Attend le délai puis relève le cours des marchés concernés : { [marché]: { price, t } } (null si rien à remplir).
 * Sans cours (marché fermé, erreur), le compte garde le prix du signal.
 */
async function delayedFills(cfg, events, accounts, { fetcher, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const delay = cfg.fillDelaySec || 0;
  if (!(delay > 0)) return null;
  const ids = marketsToFill(events, accounts);
  if (!ids.length) return null;
  await sleep(delay * 1000);
  const t = Math.floor(Date.now() / 1000);
  const fills = {};
  await Promise.all(ids.map(async (id) => {
    const price = await quoteNow(cfg, id, fetcher);
    if (price) fills[id] = { price, t };
  }));
  return fills;
}

module.exports = { delayedFills, marketsToFill, quoteNow, SYMBOL };
