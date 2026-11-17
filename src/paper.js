/**
 * Paper trading des calls meme coins : chaque alerte publiée ouvre un achat SIMULÉ.
 * Les positions sont réévaluées à chaque passage et clôturées selon des règles fixes :
 *   take profit, stop loss, trailing stop, durée max, ou rug (liquidité disparue).
 * Frais + slippage simulés à chaque achat et vente (PAPER_FEE_PCT).
 */
const dex = require('./dexscreener');

const FILE = 'paper.json';
const HOUR = 3_600_000;
const MAX_HISTORY = 500;

class PaperBook {
  constructor(store, cfg) {
    this.store = store;
    this.cfg = cfg;
    this.state = store.loadJson(FILE, { open: {}, closed: [] });
  }

  save() {
    if (this.state.closed.length > MAX_HISTORY) this.state.closed = this.state.closed.slice(-MAX_HISTORY);
    this.store.saveJson(FILE, this.state);
  }

  isOpen(key) {
    return Boolean(this.state.open[key]);
  }

  /** Ouvre une position simulée sur un token alerté. Retourne la position ou null. */
  open(item) {
    const t = item.token;
    const key = `${t.chain}:${t.address}`;
    if (!this.cfg.paperEnabled || this.isOpen(key) || !(t.priceUsd > 0)) return null;
    const fee = this.cfg.paperFeePct / 100;
    const pos = {
      key,
      chain: t.chain,
      address: t.address,
      symbol: t.symbol,
      url: t.url,
      score: Math.round(item.result.total),
      size: this.cfg.paperSizeUsd,
      entryPrice: t.priceUsd,
      entryEff: t.priceUsd * (1 + fee), // prix payé avec frais/slippage
      entryMc: t.marketCap,
      entryAt: Date.now(),
      peak: t.priceUsd,
      last: t.priceUsd,
      missed: 0,
    };
    this.state.open[key] = pos;
    this.save();
    return pos;
  }

  /** Réévalue les positions ouvertes. Retourne la liste des trades clôturés pendant ce passage. */
  async update() {
    const positions = Object.values(this.state.open);
    if (!positions.length) return [];

    const byChain = new Map();
    for (const p of positions) {
      if (!byChain.has(p.chain)) byChain.set(p.chain, []);
      byChain.get(p.chain).push(p);
    }

    const closed = [];
    const c = this.cfg;
    for (const [chain, list] of byChain) {
      const pairs = await dex.fetchPairs(chain, list.map((p) => p.address));
      for (const p of list) {
        const pair = pairs.get(p.address);
        if (!pair) {
          // Paire introuvable pendant ~1 h → considérée comme morte
          p.missed = (p.missed || 0) + 1;
          if (p.missed >= 6) closed.push(this.#close(p, 0, 'paire disparue (rug ?)'));
          continue;
        }
        const t = dex.normalize(pair);
        p.missed = 0;
        p.last = t.priceUsd;
        p.lastMc = t.marketCap;
        p.peak = Math.max(p.peak, t.priceUsd);

        const gain = (t.priceUsd / p.entryPrice - 1) * 100;
        const peakGain = (p.peak / p.entryPrice - 1) * 100;
        let reason = null;
        if (t.liquidity < 1000) reason = 'liquidité retirée (rug)';
        else if (gain >= c.paperTpPct) reason = `take profit (+${c.paperTpPct} %)`;
        else if (gain <= -c.paperSlPct) reason = `stop loss (−${c.paperSlPct} %)`;
        else if (peakGain >= c.paperTrailStartPct && t.priceUsd <= p.peak * (1 - c.paperTrailPct / 100)) {
          reason = `trailing stop (−${c.paperTrailPct} % depuis le plus haut)`;
        } else if (Date.now() - p.entryAt >= c.paperMaxHoldHours * HOUR) reason = `durée max (${c.paperMaxHoldHours} h)`;

        if (reason) closed.push(this.#close(p, reason.includes('rug') ? 0 : t.priceUsd, reason));
      }
    }
    this.save();
    return closed;
  }

  #close(p, exitPrice, reason) {
    const fee = this.cfg.paperFeePct / 100;
    const exitEff = exitPrice * (1 - fee);
    const pnlPct = (exitEff / p.entryEff - 1) * 100;
    const trade = {
      ...p,
      exitPrice,
      exitAt: Date.now(),
      reason,
      pnlPct,
      pnlUsd: (p.size * pnlPct) / 100,
      peakPct: (p.peak / p.entryPrice - 1) * 100,
    };
    delete this.state.open[p.key];
    this.state.closed.push(trade);
    return trade;
  }

  stats() {
    const closed = this.state.closed;
    const open = Object.values(this.state.open);
    const wins = closed.filter((t) => t.pnlUsd > 0);
    const realized = closed.reduce((s, t) => s + t.pnlUsd, 0);
    const fee = this.cfg.paperFeePct / 100;
    const unrealized = open.reduce((s, p) => s + p.size * ((p.last * (1 - fee)) / p.entryEff - 1), 0);
    const sorted = [...closed].sort((a, b) => b.pnlPct - a.pnlPct);
    return {
      trades: closed.length,
      wins: wins.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
      realized,
      unrealized,
      invested: closed.reduce((s, t) => s + t.size, 0),
      best: sorted[0] || null,
      worst: sorted[sorted.length - 1] || null,
      open,
    };
  }
}

module.exports = { PaperBook };
