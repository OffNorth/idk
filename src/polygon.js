/**
 * Bougies intraday d'une action / d'un ETF via l'API Polygon (offre gratuite : ~2 ans d'historique, 5 requêtes / minute).
 * La clé n'est jamais dans le code : envoyée en en-tête « Authorization: Bearer », depuis la variable POLYGON_API_KEY
 * (ou injectée par le proxy de l'environnement). Résultat mis en cache sur disque (data/research).
 */
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, key) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 429) { await sleep(15_000); continue; }
    if (!res.ok) throw new Error(`Polygon : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error('Polygon : trop de requêtes (429)');
}

/**
 * @param {string} ticker  ex. 'QQQ'
 * @param {number} minutes taille des bougies (1, 5…)
 * @param {string} from    'AAAA-MM-JJ'
 */
async function polygonBars(cacheDir, ticker, minutes, from, { maxAgeH = 24, log = () => {} } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `polygon-${ticker}-${minutes}m-${from}.json`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAgeH * 3_600_000) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = process.env.POLYGON_API_KEY || '';
  const to = new Date().toISOString().slice(0, 10);
  let url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${minutes}/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
  const byT = new Map();
  let n = 0;
  while (url) {
    const j = await get(url, key);
    for (const b of j.results || []) byT.set(Math.floor(b.t / 1000), { t: Math.floor(b.t / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
    n++;
    log(`  Polygon ${ticker} ${minutes} min : page ${n}, ${byT.size} bougies`);
    url = j.next_url || null;
    if (url) await sleep(12_500); // offre gratuite : 5 requêtes / minute
  }
  const list = [...byT.values()].sort((a, b) => a.t - b.t);
  fs.writeFileSync(file, JSON.stringify(list));
  return list;
}

module.exports = { polygonBars };
