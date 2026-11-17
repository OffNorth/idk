/**
 * Pipeline d'un scan : découverte → données de marché → filtres → score → RugCheck → classement.
 */
const { discover } = require('./sources');
const { fetchPairs, normalize } = require('./dexscreener');
const rugcheck = require('./rugcheck');
const { hardFilters, score, applyRugcheck } = require('./scoring');
const { mapLimit } = require('./http');

// Nombre de meilleurs tokens vérifiés sur RugCheck à chaque scan (limite les appels API)
const RUGCHECK_TOP = 15;

async function loadTokens(entries) {
  const byChain = new Map();
  for (const e of entries) {
    if (!byChain.has(e.chain)) byChain.set(e.chain, []);
    byChain.get(e.chain).push(e);
  }
  const tokens = [];
  for (const [chain, list] of byChain) {
    const pairs = await fetchPairs(chain, list.map((e) => e.address));
    for (const e of list) {
      const pair = pairs.get(e.address);
      if (pair) tokens.push({ ...normalize(pair), sources: e.sources || [] });
    }
  }
  return tokens;
}

async function withRugcheck(token, result, cfg) {
  if (!cfg.rugcheckEnabled || token.chain !== 'solana') return { result, rug: null };
  const rug = await rugcheck.check(token.address);
  return { result: applyRugcheck(result, rug, cfg), rug };
}

/**
 * @returns {Promise<{discovered:number, watched:number, priced:number, inRange:number, ranked:Array, rejected:Object}>}
 */
async function scan(cfg, store) {
  const discovered = await discover(cfg);
  const watched = store.track(discovered, cfg.watchHours);
  const tokens = await loadTokens(watched);

  const rejected = {};
  const passing = [];
  let inRange = 0;
  for (const t of tokens) {
    if (t.marketCap >= cfg.minMarketCap && t.marketCap <= cfg.maxMarketCap) inRange++;
    const reasons = hardFilters(t, cfg);
    if (reasons.length) {
      const key = reasons[0].replace(/\s*\(.*$/, '');
      rejected[key] = (rejected[key] || 0) + 1;
      continue;
    }
    passing.push({ token: t, result: score(t) });
  }

  passing.sort((a, b) => b.result.total - a.result.total);
  const top = passing.slice(0, RUGCHECK_TOP);
  const checked = await mapLimit(top, 3, async (x) => ({ token: x.token, ...(await withRugcheck(x.token, x.result, cfg)) }));

  const ranked = [];
  for (const x of checked) {
    if (x.result.rejected) {
      rejected['RugCheck'] = (rejected['RugCheck'] || 0) + 1;
      continue;
    }
    ranked.push(x);
  }
  ranked.sort((a, b) => b.result.total - a.result.total);

  return {
    discovered: discovered.length,
    watched: watched.length,
    priced: tokens.length,
    inRange,
    ranked,
    rejected,
  };
}

/** Analyse détaillée d'un token précis (commande /check). */
async function analyze(cfg, chain, address) {
  const [token] = await loadTokens([{ chain, address, sources: ['manuel'] }]);
  if (!token) return null;
  const reasons = hardFilters(token, cfg);
  const { result, rug } = await withRugcheck(token, score(token), cfg);
  if (result.rejected) reasons.push(result.rejected);
  return { token, result, rug, reasons };
}

module.exports = { scan, analyze };
