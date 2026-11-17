/**
 * Mini-app web : page de suivi des stratégies + API JSON en lecture seule, servies par le bot.
 *   GET /                → web/index.html (s'ouvre dans Telegram ou dans un navigateur)
 *   GET /api/state       → portefeuilles en direct (capital, positions, trades, courbes)
 *   GET /api/catalog     → toutes les stratégies, leur statut et leur résultat au banc d'essai
 *   GET /api/history?market=gold&from=2010[&ids=season,hold] → simulation sur l'historique
 * Si WEB_TOKEN est défini, l'API exige ?k=WEB_TOKEN (le lien envoyé par /app le contient).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { activeMarkets, marketById, MarketTrader } = require('./markets');
const { colorize, simulateHistory } = require('./portfolio');
const { downsample } = require('./chart');
const { catalog } = require('./catalog');
const { unrealized } = require('./gold');

const PAGE = path.join(__dirname, '..', 'web', 'index.html');
const hex = (rgb) => `#${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
const r2 = (v) => Math.round(v * 100) / 100;

/** État en direct d'un marché, prêt pour la page. */
function marketState(store, cfg, market) {
  const trader = new MarketTrader(market, store, cfg);
  const st = trader.stats();
  const curves = new Map(trader.curves().map((c) => [c.strategy.id, c.points]));
  const colors = colorize(st.rows.map((r) => r.strategy));
  const price = st.price;
  const feed = [];
  const strategies = st.rows.map((row, k) => {
    const s = row.strategy;
    const acc = trader.account(s.id);
    const p = row.position;
    for (const t of acc.closed.slice(-40)) feed.push({ type: 'close', t: t.exitT, id: s.id, side: t.side, price: t.exit, pnlUsd: r2(t.pnlUsd), pnlPct: r2(t.pnlPct), reason: t.reason });
    for (const t of acc.closed.slice(-40)) feed.push({ type: 'open', t: t.entryT, id: s.id, side: t.side, price: t.entry });
    if (p) feed.push({ type: 'open', t: p.entryT, id: s.id, side: p.side, price: p.entry, live: true });
    return {
      id: s.id,
      name: s.name,
      desc: s.desc,
      tf: s.tf || '1h',
      color: hex(colors[k].rgb),
      dash: Boolean(colors[k].dash),
      ref: s.id === 'hold',
      equity: r2(row.equity),
      capital: r2(row.capital),
      returnPct: r2(row.returnPct),
      trades: row.trades,
      winRate: r2(row.winRate),
      pnlUsd: r2(row.pnlUsd),
      profitFactor: row.profitFactor === null ? null : r2(row.profitFactor),
      position: p && {
        side: p.side, entry: p.entry, sl: p.sl, tp: p.tp, entryT: p.entryT, size: r2(p.size),
        unrealized: r2(unrealized(p, price)), unrealizedPct: price ? r2((p.side === 'long' ? 1 : -1) * (price / p.entry - 1) * 100) : 0,
      },
      closed: acc.closed.slice(-50).reverse().map((t) => ({
        side: t.side, entry: t.entry, exit: t.exit, entryT: t.entryT, exitT: t.exitT, pnlUsd: r2(t.pnlUsd), pnlPct: r2(t.pnlPct), reason: t.reason,
      })),
      curve: downsample(curves.get(s.id) || [], 300).map((q) => [q.t, r2(q.v)]),
    };
  });
  feed.sort((a, b) => b.t - a.t);
  return {
    id: market.id,
    name: market.name,
    emoji: market.emoji,
    price,
    lastUpdate: trader.state.lastUpdate || null,
    since: st.since,
    startCapital: market.startCapital,
    positionPct: market.positionPct,
    feePct: market.feePct,
    financingPct: market.financingPct,
    totalEquity: r2(st.totalEquity),
    totalStart: st.totalStart,
    inPosition: st.rows.filter((r) => r.position).length,
    strategies,
    feed: feed.slice(0, 80),
  };
}

/* Simulations sur l'historique : mises en cache 6 h, une seule à la fois (calcul lourd). */
const histCache = new Map();
let histQueue = Promise.resolve();
function history(cfg, marketId, fromYear, ids) {
  const key = `${marketId}:${fromYear}:${ids ? ids.join(',') : ''}`;
  const hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.promise;
  const promise = (histQueue = histQueue.catch(() => {}).then(async () => {
    const out = await simulateHistory(cfg, { marketId, fromYear, ids });
    const m = out.market;
    return {
      market: m.id, name: m.name, emoji: m.emoji, year: out.year, years: r2(out.years), fees: out.fees, source: out.source,
      startCapital: m.startCapital, last: out.last.t,
      results: out.results.map(({ s, r, color, dd, stats }) => ({
        id: s.id, name: s.name, color: hex(color.rgb), dash: Boolean(color.dash), ref: s.id === 'hold',
        equity: r2(r.equity), perYear: r2(stats.perYear), dd: r2(dd * 100), trades: stats.trades, winRate: r2(stats.winRate),
        avg: r2(stats.avg), days: r2(stats.days), curve: downsample(r.curve, 400).map((q) => [q.t, r2(q.v)]),
      })).sort((a, b) => b.equity - a.equity),
    };
  }));
  histCache.set(key, { at: Date.now(), promise });
  promise.catch(() => histCache.delete(key));
  return promise;
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Démarre le serveur web. Retourne le serveur (ou null si le port est indisponible). */
function startWeb({ cfg, store, port = cfg.webPort, host = '0.0.0.0', log = console.log }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method !== 'GET') return send(res, 405, { error: 'GET uniquement' });
      if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
      if (url.pathname === '/health') return send(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'introuvable' });
      if (cfg.webToken && !safeEq(String(url.searchParams.get('k') || ''), cfg.webToken)) return send(res, 401, { error: 'clé manquante ou incorrecte : ouvre l’app avec le lien de /app' });

      if (url.pathname === '/api/state') {
        return send(res, 200, { now: Date.now(), markets: activeMarkets(cfg).map((m) => marketState(store, cfg, m)) });
      }
      if (url.pathname === '/api/catalog') return send(res, 200, { strategies: catalog(cfg) });
      if (url.pathname === '/api/history') {
        const marketId = url.searchParams.get('market') === 'nas100' ? 'nas100' : 'gold';
        const minYear = marketId === 'nas100' ? 1987 : 2001;
        const year = Math.min(Math.max(Number(url.searchParams.get('from')) || (marketId === 'nas100' ? 2010 : 2021), minYear), new Date().getUTCFullYear() - 1);
        const raw = url.searchParams.get('ids');
        const ids = raw ? raw.split(',').map((x) => x.trim()).filter((x) => /^[a-z0-9_@]+$/i.test(x)).slice(0, 20) : null;
        if (!marketById(cfg, marketId)) return send(res, 404, { error: 'marché inconnu' });
        return send(res, 200, await history(cfg, marketId, year, ids?.length ? ids : null));
      }
      return send(res, 404, { error: 'introuvable' });
    } catch (err) {
      console.error('[web]', err);
      return send(res, 500, { error: err.message });
    }
  });
  server.on('error', (err) => console.warn(`[web] mini-app indisponible (port ${port}) : ${err.message}`));
  server.listen(port, host, () => log(`Mini-app : serveur web sur le port ${server.address().port}`));
  return server;
}

module.exports = { startWeb, marketState, history };
