/**
 * Messages Telegram (HTML) du paper trading de l'or.
 */

/** Prix lisible : 4 décimales sous 10 (EUR/USD), 2 sinon. */
const px = (v) => (Math.abs(v) < 10 ? v.toFixed(4) : v.toFixed(2));
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const signedUsd = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

function fmtDuration(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

/** Ouverture ou clôture d'une position simulée. */
function goldEventMessage(ev) {
  const name = esc(ev.strategy.name);
  const mk = ev.market?.emoji || '🥇';
  const mn = esc(ev.market?.name || 'Gold');
  if (ev.type === 'open' && ev.strategy.id === 'hold') {
    return [
      `${mk} <b>${mn} · ${name}</b>`,
      `Simulated benchmark buy at <b>$${px(ev.pos.entry)}</b> · size $${ev.pos.size}, held with no time limit`,
      `<i>For comparison: a strategy must beat simply holding ${ev.market?.id === 'nas100' ? 'the index (like an ETF, no financing)' : 'gold'}.</i>`,
    ].join('\n');
  }
  if (ev.type === 'open') {
    const p = ev.pos;
    return [
      `${mk} <b>${mn} · ${name}</b>`,
      `${p.side === 'long' ? '📈 <b>BUY</b> (long)' : '📉 <b>SELL SHORT</b> (short)'} simulated at <b>$${px(p.entry)}</b> · size $${p.size}`,
      `Stop: $${px(p.sl)}${ev.strategy.trail ? ' (trailing)' : ''} · Target: ${p.tp ? `$${px(p.tp)}` : 'exit signal'}`,
      `<i>${ev.rsi != null ? `RSI ${Number(ev.rsi).toFixed(0)} · ` : ""}paper trading, no real money</i>`,
    ].join('\n');
  }
  const t = ev.trade;
  return [
    `${mk} ${t.pnlUsd >= 0 ? '🟢' : '🔴'} <b>${mn} · ${name}</b> — ${t.side === 'long' ? 'long' : 'short'} closed`,
    `$${px(t.entry)} → $${px(t.exit)} · <b>${signedPct(t.pnlPct)}</b> (${signedUsd(t.pnlUsd)} on $${t.size})`,
    `Reason: ${esc(t.reason)} · duration ${fmtDuration((t.exitT - t.entryT) * 1000)} · <i>paper trading, fees included</i>`,
    ...(ev.capital !== undefined
      ? [`Strategy capital: <b>${money(ev.capital)}</b> (${signedPct((ev.capital / ev.start - 1) * 100)} since start)`]
      : []),
  ].join('\n');
}

const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

/** Bilan de toutes les stratégies (gains réinvestis : valeur de chaque compte). */
function portfolioMessage(gold) {
  const strat = gold.rows.filter((r) => r.strategy.id !== 'hold');
  const ref = gold.rows.find((r) => r.strategy.id === 'hold');
  const total = strat.reduce((s, r) => s + r.equity, 0);
  const start = gold.start * strat.length;
  const lines = [
    `<b>📒 Paper trading report — ${gold.market?.emoji || '🥇'} ${esc(gold.market?.name || 'Gold')}</b> <i>(simulation, gains reinvested)</i>`,
    `Price: ${gold.price ? `$${px(gold.price)}` : '?'} · ${strat.length} strategies × ${money(gold.start)}`,
    `Portfolio value: <b>${money(total)}</b> (${signedPct((total / start - 1) * 100)})`,
  ];
  if (ref) lines.push(`Buy-and-hold benchmark: ${money(ref.equity)} (${signedPct(ref.returnPct)})`);
  for (const r of [...strat].sort((a, b) => b.equity - a.equity)) {
    const pos = r.position
      ? `${r.position.side === 'long' ? '📈 long' : '📉 short'} since $${px(r.position.entry)} (${signedUsd(r.unrealized)})`
      : 'no position';
    lines.push(
      '',
      `<b>${esc(r.strategy.name)}</b> — ${money(r.equity)} (${signedPct(r.returnPct)})`,
      `  ${r.trades} trades · ${r.winRate.toFixed(0)}% winners${r.profitFactor ? ` · PF ${r.profitFactor.toFixed(2)}` : ''} · ${pos}`,
    );
  }
  return lines.join('\n');
}

/** Résultat d'un backtest (commande /backtest). */
function backtestMessage(results, info, cfg) {
  const lines = [
    `<b>🧪 Gold backtest · ${info.days} days (1 h candles)</b>`,
    `$${info.from.toFixed(0)} → $${info.to.toFixed(0)} · buy-and-hold ${signedPct(info.buyHold)}`,
    `$${cfg.goldSizeUsd} per trade · fees ${cfg.goldFeePct}% per side`,
    '',
  ];
  for (const { strategy, r } of results) {
    lines.push(
      `<b>${esc(strategy.name)}</b>`,
      `  ${r.trades} trades · ${r.winRate.toFixed(0)}% winners · <b>${signedUsd(r.pnlUsd)}</b> · PF ${r.profitFactor ? r.profitFactor.toFixed(2) : '-'} · DD max $${r.maxDrawdown.toFixed(0)}`,
    );
  }
  lines.push('', '<i>PF > 1 = profitable over the period. Past results ≠ future results.</i>');
  return lines.join('\n');
}

module.exports = { esc, goldEventMessage, portfolioMessage, backtestMessage };
