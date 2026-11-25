/**
 * Données Yahoo Finance (API « chart », gratuite, sans clé) : indices et contrats à terme.
 * Ex. ^NDX (Nasdaq 100, journalier depuis 1985), NQ=F (future Nasdaq 100, 1 h sur ~2 ans).
 */
const fs = require('fs');
const path = require('path');

const BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';

/**
 * @param {string} symbol    ex. '^NDX', 'NQ=F'
 * @param {string} interval  '1d', '1h', '5m'…
 * @param {object} opts      { range: '730d' } ou { period1, period2 } (secondes) ; adjusted : cours ajustés des dividendes
 *                           (journalier : rendement total d'un ETF, pour comparer des portefeuilles sur 20 ans)
 */
async function fetchYahoo(symbol, interval, opts = {}) {
  const params = new URLSearchParams({ interval, includePrePost: 'false' });
  if (opts.range) params.set('range', opts.range);
  else {
    params.set('period1', String(opts.period1 ?? 0));
    params.set('period2', String(opts.period2 ?? Math.floor(Date.now() / 1000)));
  }
  let lastErr;
  const attempts = opts.attempts ?? 4;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${BASE}${encodeURIComponent(symbol)}?${params}`, {
        headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`Yahoo ${symbol} : HTTP ${res.status}`);
      const json = await res.json();
      const r = json?.chart?.result?.[0];
      if (!r?.timestamp) throw new Error(`Yahoo ${symbol} : réponse vide`);
      const q = r.indicators.quote[0];
      const adj = opts.adjusted ? r.indicators.adjclose?.[0]?.adjclose : null;
      const out = [];
      r.timestamp.forEach((t, i) => {
        const k = adj && adj[i] != null && q.close[i] ? adj[i] / q.close[i] : 1;
        const c = q.close[i] == null ? null : q.close[i] * k;
        if (c == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) return;
        // journalier : bougie alignée sur minuit UTC (Yahoo donne l'heure d'ouverture du marché)
        const tt = interval === '1d' ? Math.floor(t / 86400) * 86400 : t;
        out.push({ t: tt, o: q.open[i] * k, h: q.high[i] * k, l: q.low[i] * k, c, v: q.volume?.[i] || 0 });
      });
      const byT = new Map(out.map((c) => [c.t, c]));
      return [...byT.values()].sort((a, b) => a.t - b.t);
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Version mise en cache sur disque (rafraîchie si plus vieille que maxAgeH heures). */
async function cachedYahoo(cacheDir, symbol, interval, opts = {}, maxAgeH = 24) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, `yahoo-${symbol.replace(/[^A-Za-z0-9]/g, '_')}-${interval}-${opts.range || 'all'}${opts.adjusted ? '-adj' : ''}.json`);
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < maxAgeH * 3_600_000) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const data = await fetchYahoo(symbol, interval, opts);
  fs.writeFileSync(file, JSON.stringify(data));
  return data;
}

module.exports = { fetchYahoo, cachedYahoo };
