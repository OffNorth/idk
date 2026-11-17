const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON avec timeout et retries (backoff exponentiel, gère le 429).
 * Retourne null si la ressource échoue définitivement.
 */
async function getJson(url, { retries = 2, timeoutMs = 15_000, quiet = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'gold-paper-bot/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryable: true });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      const retryable = err.retryable || err.name === 'TimeoutError' || err.name === 'TypeError';
      if (attempt < retries && retryable) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!quiet) console.warn(`[http] ${url} → ${err.message}`);
      return null;
    }
  }
  return null;
}

module.exports = { getJson, sleep };
