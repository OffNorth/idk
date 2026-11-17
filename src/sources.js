/**
 * Découverte de tokens candidats depuis plusieurs sources publiques (sans clé API).
 * Chaque source renvoie des { chain, address, source }. Une source qui échoue est ignorée.
 */
const { getJson } = require('./http');

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
// Correspondance chainId DexScreener → réseau GeckoTerminal
const GT_NETWORK = { solana: 'solana', base: 'base', bsc: 'bsc', ethereum: 'eth', arbitrum: 'arbitrum', polygon: 'polygon_pos' };

function fromDexList(data, source, chains) {
  if (!Array.isArray(data)) return [];
  return data
    .filter((t) => t && chains.includes(String(t.chainId).toLowerCase()) && t.tokenAddress)
    .map((t) => ({ chain: t.chainId.toLowerCase(), address: t.tokenAddress, source }));
}

async function dexProfiles(chains) {
  return fromDexList(await getJson(`${DS}/token-profiles/latest/v1`), 'profil', chains);
}
async function dexBoostsLatest(chains) {
  return fromDexList(await getJson(`${DS}/token-boosts/latest/v1`), 'boost', chains);
}
async function dexBoostsTop(chains) {
  return fromDexList(await getJson(`${DS}/token-boosts/top/v1`), 'top-boost', chains);
}
async function dexTakeovers(chains) {
  return fromDexList(await getJson(`${DS}/community-takeovers/latest/v1`), 'CTO', chains);
}

async function dexSearch(chains, queries) {
  const out = [];
  for (const q of queries) {
    const data = await getJson(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`);
    for (const p of data?.pairs || []) {
      const chain = String(p.chainId).toLowerCase();
      if (chains.includes(chain) && p.baseToken?.address) {
        out.push({ chain, address: p.baseToken.address, source: 'recherche' });
      }
    }
  }
  return out;
}

/** GeckoTerminal : pools tendance + pools au plus gros volume. Rate limit strict → quiet. */
async function geckoPools(chains) {
  const out = [];
  for (const chain of chains) {
    const net = GT_NETWORK[chain];
    if (!net) continue;
    const urls = [
      [`${GT}/networks/${net}/trending_pools?page=1`, 'gecko-trending'],
      [`${GT}/networks/${net}/trending_pools?page=2`, 'gecko-trending'],
      [`${GT}/networks/${net}/pools?sort=h24_tx_count_desc&page=1`, 'gecko-actif'],
    ];
    for (const [url, source] of urls) {
      const data = await getJson(url, { retries: 1, quiet: true });
      for (const pool of data?.data || []) {
        const id = pool?.relationships?.base_token?.data?.id || '';
        const address = id.slice(id.indexOf('_') + 1);
        if (address) out.push({ chain, address, source });
      }
    }
  }
  return out;
}

/**
 * Lance toutes les sources en parallèle et fusionne.
 * @returns {Promise<Array<{chain, address, sources: string[]}>>}
 */
async function discover(cfg) {
  const results = await Promise.all([
    dexProfiles(cfg.chains),
    dexBoostsLatest(cfg.chains),
    dexBoostsTop(cfg.chains),
    dexTakeovers(cfg.chains),
    dexSearch(cfg.chains, cfg.searchQueries),
    geckoPools(cfg.chains),
  ]);
  const merged = new Map();
  for (const item of results.flat()) {
    const key = `${item.chain}:${item.address}`;
    if (!merged.has(key)) merged.set(key, { chain: item.chain, address: item.address, sources: new Set() });
    merged.get(key).sources.add(item.source);
  }
  return [...merged.values()].map((c) => ({ ...c, sources: [...c.sources] }));
}

module.exports = { discover };
