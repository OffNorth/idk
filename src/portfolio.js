/**
 * Portefeuille : graphique de l'évolution en direct (depuis le lancement) et historique simulé depuis 2020,
 * gains réinvestis dans les deux cas.
 */
const path = require('path');
const { GoldTrader, backtest } = require('./gold');
const { selectStrategies, tfOf, TF_SEC } = require('./strategies');
const { renderEquityChart, downsample, PALETTE, REFERENCE } = require('./chart');
const { esc } = require('./format');

const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;
const date = (t) => new Date(t * 1000).toISOString().slice(0, 10).split('-').reverse().join('/');

/** Couleur de chaque stratégie (la référence achat-conservation en gris). */
function colorize(strategies) {
  let k = 0;
  return strategies.map((s) => (s.id === 'hold' ? REFERENCE : PALETTE[k++ % PALETTE.length]));
}

/** Graphique + légende du portefeuille en direct. */
function liveChart(store, cfg) {
  const trader = new GoldTrader(store, cfg);
  const curves = trader.curves();
  const colors = colorize(curves.map((c) => c.strategy));
  const png = renderEquityChart(
    curves.map((c, k) => ({ points: downsample(c.points), rgb: colors[k].rgb, reference: c.strategy.id === 'hold' })),
    { baseline: cfg.goldStartCapital },
  );
  const st = trader.stats();
  const order = st.rows.map((r, k) => ({ r, color: colors[k] })).sort((a, b) => b.r.equity - a.r.equity);
  const strat = st.rows.filter((r) => r.strategy.id !== 'hold');
  const total = strat.reduce((s, r) => s + r.equity, 0);
  const start = cfg.goldStartCapital * strat.length;
  const lines = [
    '<b>📈 Portefeuille or</b> <i>(simulation, gains réinvestis)</i>',
    `${strat.length} stratégies × ${money(cfg.goldStartCapital)}${st.since ? ` depuis le ${date(st.since)}` : ''}`,
    `Valeur : <b>${money(total)}</b> (${pct((total / start - 1) * 100)}) · or ${st.price ? money(st.price) : '?'}`,
    '',
    ...order.map(({ r, color }) =>
      `${color.emoji} ${esc(r.strategy.name)} — <b>${money(r.equity)}</b> (${pct(r.returnPct)})${r.position ? (r.position.side === 'long' ? ' 📈' : ' 📉') : ''}`,
    ),
  ];
  return { png, caption: lines.join('\n').slice(0, 1024) };
}

/** Charge l'historique long (archive Binance) pour la simulation depuis 2020. */
async function loadHistory(cacheDir) {
  const { loadHourly, aggregate } = require('./history');
  const hourly = await loadHourly(cacheDir);
  const fx = aggregate(await loadHourly(cacheDir, { symbol: 'EURUSDT' }), TF_SEC['1d']);
  return { '1h': hourly, '6h': aggregate(hourly, TF_SEC['6h']), '1d': aggregate(hourly, TF_SEC['1d']), fx };
}

/**
 * Simulation des stratégies actives sur l'historique, gains réinvestis.
 * @param {number} fromYear  année de départ (2021 par défaut : laisse 2020 pour chauffer les moyennes 200 jours)
 */
async function historyChart(cfg, { fromYear = 2021, cacheDir = path.join(__dirname, '..', 'data', 'research') } = {}) {
  const data = await loadHistory(cacheDir);
  const strategies = selectStrategies(cfg.goldStrategies);
  const colors = colorize(strategies);
  const fromT = Date.UTC(fromYear, 0, 1) / 1000;
  const results = strategies.map((s, k) => {
    const tf = tfOf(s);
    const candles = data[tf];
    const from = Math.max(0, candles.findIndex((c) => c.t >= fromT));
    const r = backtest(s, candles, {
      daily: data['1d'], fx: data.fx, barSec: TF_SEC[tf], feePct: cfg.goldFeePct, from,
      compound: true, capital: cfg.goldStartCapital, positionPct: cfg.goldPositionPct,
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
    { baseline: cfg.goldStartCapital },
  );
  const last = data['1d'][data['1d'].length - 1];
  const lines = [
    `<b>🕰 Historique simulé ${fromYear} → ${date(last.t)}</b> <i>(gains réinvestis, frais inclus)</i>`,
    `Chaque stratégie part de ${money(cfg.goldStartCapital)} · or PAXG, archive Binance`,
    '',
    ...results
      .sort((a, b) => b.r.equity - a.r.equity)
      .map(({ s, r, color, dd }) => `${color.emoji} ${esc(s.name)} — <b>${money(r.equity)}</b> (${pct((r.equity / cfg.goldStartCapital - 1) * 100)}) · pire baisse −${(dd * 100).toFixed(0)} %`),
    '',
    '<i>Résultats passés ≠ résultats futurs.</i>',
  ];
  return { png, caption: lines.join('\n').slice(0, 1024), results };
}

module.exports = { liveChart, historyChart, colorize };
