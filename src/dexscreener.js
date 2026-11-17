/**
 * Récupère les données de marché DexScreener par lots de 30 tokens
 * et garde, pour chaque token, la paire la plus liquide.
 */
const { getJson, mapLimit } = require('./http');

const BATCH = 30;

async function fetchPairs(chain, addresses) {
  const batches = [];
  for (let i = 0; i < addresses.length; i += BATCH) batches.push(addresses.slice(i, i + BATCH));

  const results = await mapLimit(batches, 3, (batch) =>
    getJson(`https://api.dexscreener.com/tokens/v1/${chain}/${batch.join(',')}`),
  );

  const best = new Map(); // adresse du token → meilleure paire
  for (const pairs of results) {
    if (!Array.isArray(pairs)) continue;
    for (const p of pairs) {
      const addr = p?.baseToken?.address;
      if (!addr) continue;
      const cur = best.get(addr);
      if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(addr, p);
    }
  }
  return best;
}

/** Normalise une paire DexScreener vers un objet plat facile à scorer. */
function normalize(pair) {
  const tx = pair.txns || {};
  const vol = pair.volume || {};
  const pc = pair.priceChange || {};
  const socials = pair.info?.socials || [];
  const websites = pair.info?.websites || [];
  const sum = (t) => (t?.buys || 0) + (t?.sells || 0);
  return {
    chain: pair.chainId,
    address: pair.baseToken.address,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    pairAddress: pair.pairAddress,
    dex: pair.dexId,
    url: pair.url,
    quote: pair.quoteToken?.symbol,
    priceUsd: Number(pair.priceUsd) || 0,
    marketCap: pair.marketCap || pair.fdv || 0,
    liquidity: pair.liquidity?.usd || 0,
    vol: { m5: vol.m5 || 0, h1: vol.h1 || 0, h6: vol.h6 || 0, h24: vol.h24 || 0 },
    change: { m5: pc.m5 || 0, h1: pc.h1 || 0, h6: pc.h6 || 0, h24: pc.h24 || 0 },
    txns: {
      h1: { buys: tx.h1?.buys || 0, sells: tx.h1?.sells || 0, total: sum(tx.h1) },
      h6: { buys: tx.h6?.buys || 0, sells: tx.h6?.sells || 0, total: sum(tx.h6) },
      h24: { buys: tx.h24?.buys || 0, sells: tx.h24?.sells || 0, total: sum(tx.h24) },
    },
    ageHours: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : null,
    twitter: socials.find((s) => s.type === 'twitter')?.url || null,
    telegram: socials.find((s) => s.type === 'telegram')?.url || null,
    website: websites[0]?.url || null,
    boosts: pair.boosts?.active || 0,
    imageUrl: pair.info?.imageUrl || null,
  };
}

module.exports = { fetchPairs, normalize };
