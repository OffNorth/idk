/**
 * Portefeuille : graphique de l'évolution en direct (depuis le lancement) et historique simulé,
 * gains réinvestis dans les deux cas, pour chaque marché (or, Nasdaq 100).
 */
const path = require('path');
const { backtest } = require('./gold');
const { MarketTrader, marketById } = require('./markets');
const { selectStrategies, tfOf, TF_SEC } = require('./strategies');
const { renderEquityChart, downsample, PALETTE, REFERENCE } = require('./chart');
const { esc } = require('./format');

const CACHE = path.join(__dirname, '..', 'data', 'research');
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;
const date = (t) => new Date(t * 1000).toISOString().slice(0, 10).split('-').reverse().join('/');

/** Couleur de chaque stratégie (la référence achat-conservation en gris). */
function colorize(strategies) {
  let k = 0;
  return strategies.map((s) => (s.id === 'hold' ? REFERENCE : PALETTE[k++ % PALETTE.length]));
}

/** Graphique + légende du portefeuille en direct d'un marché. */
function liveChart(store, cfg, marketId = 'gold') {
  const market = marketById(cfg, marketId);
  const trader = new MarketTrader(market, store, cfg);
  const curves = trader.curves();
  const colors = colorize(curves.map((c) => c.strategy));
  const png = renderEquityChart(
    curves.map((c, k) => ({ points: downsample(c.points), rgb: colors[k].rgb, reference: c.strategy.id === 'hold' })),
    { baseline: market.startCapital },
  );
  const st = trader.stats();
  const order = st.rows.map((r, k) => ({ r, color: colors[k] })).sort((a, b) => b.r.equity - a.r.equity);
  const strat = st.rows.filter((r) => r.strategy.id !== 'hold');
  const total = strat.reduce((s, r) => s + r.equity, 0);
  const start = market.startCapital * strat.length;
  const lines = [
    `<b>📈 Portefeuille ${market.emoji} ${esc(market.name)}</b> <i>(simulation, gains réinvestis)</i>`,
    `${strat.length} stratégies × ${money(market.startCapital)}${st.since ? ` depuis le ${date(st.since)}` : ''}`,
    `Valeur : <b>${money(total)}</b> (${pct((total / start - 1) * 100)}) · prix ${st.price ? money(st.price) : '?'}`,
    '',
    ...order.map(({ r, color }) =>
      `${color.emoji} ${esc(r.strategy.name)} — <b>${money(r.equity)}</b> (${pct(r.returnPct)})${r.position ? (r.position.side === 'long' ? ' 📈' : ' 📉') : ''}`,
    ),
  ];
  return { png, caption: lines.join('\n').slice(0, 1024) };
}

/** Historique long : or = archive Binance (PAXG, depuis 2020) ; Nasdaq = Yahoo (^NDX journalier, depuis 1985). */
async function loadHistory(marketId, cacheDir) {
  const { loadHourly, aggregate } = require('./history');
  if (marketId === 'nas100') {
    const { cachedYahoo } = require('./yahoo');
    const d = await cachedYahoo(cacheDir, '^NDX', '1d');
    const vix = await cachedYahoo(cacheDir, '^VIX', '1d').catch(() => null);
    return { '1d': d, daily: d, fx: null, vix, source: 'indice ^NDX, Yahoo Finance' };
  }
  const hourly = await loadHourly(cacheDir);
  const fx = aggregate(await loadHourly(cacheDir, { symbol: 'EURUSDT' }), TF_SEC['1d']);
  const d = aggregate(hourly, TF_SEC['1d']);
  return { '1h': hourly, '6h': aggregate(hourly, TF_SEC['6h']), '1d': d, daily: d, fx, source: 'PAXG, archive Binance' };
}

/**
 * Simulation des stratégies actives d'un marché sur l'historique, gains réinvestis.
 * @param {number} fromYear  année de départ (or : 2021 au plus tôt, Nasdaq : 1986 au plus tôt)
 */
async function historyChart(cfg, { marketId = 'gold', fromYear, cacheDir = CACHE } = {}) {
  const market = marketById(cfg, marketId);
  const year = fromYear || (marketId === 'nas100' ? 2010 : 2021);
  const data = await loadHistory(marketId, cacheDir);
  const strategies = selectStrategies(market.strategies).filter((s) => data[tfOf(s)]);
  const colors = colorize(strategies);
  const fromT = Date.UTC(year, 0, 1) / 1000;
  const results = strategies.map((s, k) => {
    const tf = tfOf(s);
    const candles = data[tf];
    const from = Math.max(0, candles.findIndex((c) => c.t >= fromT));
    const r = backtest(s, candles, {
      daily: data.daily, fx: data.fx, vix: data.vix, barSec: TF_SEC[tf], feePct: market.feePct, financingPct: market.financingPct, from,
      compound: true, capital: market.startCapital, positionPct: market.positionPct,
      curveEvery: Math.max(1, Math.round(86400 / TF_SEC[tf])), // un point par jour
    });
    let peak = 0;
    let dd = 0;
    for (const p of r.curve) {
      peak = Math.max(peak, p.v);
      dd = Math.max(dd, 1 - p.v / peak);
    }
    return { s, r, color: colors[k], dd };
  });
  const png = renderEquityChart(
    results.map(({ s, r, color }) => ({ points: downsample(r.curve), rgb: color.rgb, reference: s.id === 'hold' })),
    { baseline: market.startCapital },
  );
  const last = data['1d'][data['1d'].length - 1];
  const years = Math.max(0.1, (last.t + 86400 - fromT) / (365.25 * 86400));
  const fees = `frais ${market.feePct} %/côté${market.financingPct ? ` + financement ${market.financingPct} %/an` : ''}`;
  for (const x of results) x.stats = tradeStats(x.r, market.startCapital, years);
  results.sort((a, b) => b.r.equity - a.r.equity);

  // Légende de la photo (≤ 1 024 caractères) : valeur finale + rendement annuel
  const caption = [
    `<b>🕰 ${market.emoji} ${esc(market.name)} · historique simulé ${year} → ${date(last.t)}</b>`,
    `<i>Gains réinvestis, ${fees}. Chaque stratégie part de ${money(market.startCapital)} · ${data.source}</i>`,
    '',
    ...results.map(({ s, r, color, stats }) =>
      `${color.emoji} ${esc(s.name)} — <b>${money(r.equity)}</b> (${pct((r.equity / market.startCapital - 1) * 100)}) · <b>${pct(stats.perYear)}/an</b>`),
    '',
    '<i>Détail par trade dans le message suivant. Résultats passés ≠ résultats futurs.</i>',
  ].join('\n').slice(0, 1024);

  // Message détaillé : statistiques par trade et par an
  const details = [
    `<b>📊 ${market.emoji} ${esc(market.name)} · détail ${year} → ${date(last.t)}</b> <i>(${years.toFixed(1)} ans)</i>`,
    ...results.map(({ s, r, color, dd, stats: st }) => {
      const head = `\n${color.emoji} <b>${esc(s.name)}</b> — ${money(r.equity)} · <b>${pct(st.perYear)}/an</b> · pire baisse −${(dd * 100).toFixed(0)} %`;
      if (s.id === 'hold') return `${head}\n   acheté au départ et gardé, sans trade`;
      if (!st.trades) return `${head}\n   aucun trade sur la période`;
      return [
        head,
        `   ${st.trades} trades (${st.perYearTrades.toFixed(0)}/an) · gain moyen <b>${pct(st.avg)}</b> par trade · durée moyenne ${st.days.toFixed(0)} j`,
        `   ${st.winRate.toFixed(0)} % gagnants (moy. ${pct(st.avgWin)}) · perdants moy. ${pct(st.avgLoss)}${st.best ? ` · meilleur ${pct(st.best)}, pire ${pct(st.worst)}` : ''}`,
      ].join('\n');
    }),
    '',
    '<i>« par an » = rendement annuel moyen composé. Gain moyen par trade = frais inclus.</i>',
  ].join('\n');
  return { png, caption, details, results };
}

/** Statistiques par trade et rendement annuel composé d'un backtest. */
function tradeStats(r, startCapital, years) {
  const list = r.list;
  const n = list.length;
  const mean = (arr) => (arr.length ? arr.reduce((a, t) => a + t.pnlPct, 0) / arr.length : 0);
  const wins = list.filter((t) => t.pnlPct > 0);
  const losses = list.filter((t) => t.pnlPct <= 0);
  const pcts = list.map((t) => t.pnlPct);
  return {
    trades: n,
    perYearTrades: n / years,
    avg: mean(list),
    winRate: n ? (wins.length / n) * 100 : 0,
    avgWin: mean(wins),
    avgLoss: mean(losses),
    best: n ? Math.max(...pcts) : 0,
    worst: n ? Math.min(...pcts) : 0,
    days: n ? list.reduce((a, t) => a + (t.exitT - t.entryT) / 86400, 0) / n : 0,
    perYear: (Math.pow(Math.max(r.equity, 0.01) / startCapital, 1 / years) - 1) * 100,
  };
}

module.exports = { liveChart, historyChart, colorize };
