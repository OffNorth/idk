/**
 * Messages Telegram (HTML) du paper trading de l'or.
 */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const signedUsd = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

function fmtDuration(ms) {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} j`;
}

/** Ouverture ou clôture d'une position simulée. */
function goldEventMessage(ev) {
  const name = esc(ev.strategy.name);
  if (ev.type === 'open' && ev.strategy.id === 'hold') {
    return [
      `🥇 <b>Or · ${name}</b>`,
      `Achat de référence simulé à <b>$${ev.pos.entry.toFixed(2)}</b> · taille $${ev.pos.size}, gardé sans limite de durée`,
      '<i>Sert à comparer : une stratégie doit faire mieux que simplement détenir l’or.</i>',
    ].join('\n');
  }
  if (ev.type === 'open') {
    const p = ev.pos;
    return [
      `🥇 <b>Or · ${name}</b>`,
      `${p.side === 'long' ? '📈 <b>ACHAT</b> (long)' : '📉 <b>VENTE À DÉCOUVERT</b> (short)'} simulé à <b>$${p.entry.toFixed(2)}</b> · taille $${p.size}`,
      `Stop : $${p.sl.toFixed(2)}${ev.strategy.trail ? ' (suiveur)' : ''} · Objectif : ${p.tp ? `$${p.tp.toFixed(2)}` : 'signal de sortie'}`,
      `<i>RSI ${Number(ev.rsi ?? 0).toFixed(0)} · paper trading, aucun argent réel</i>`,
    ].join('\n');
  }
  const t = ev.trade;
  return [
    `🥇 ${t.pnlUsd >= 0 ? '🟢' : '🔴'} <b>Or · ${name}</b> — ${t.side === 'long' ? 'long' : 'short'} clôturé`,
    `$${t.entry.toFixed(2)} → $${t.exit.toFixed(2)} · <b>${signedPct(t.pnlPct)}</b> (${signedUsd(t.pnlUsd)} sur $${t.size})`,
    `Raison : ${esc(t.reason)} · durée ${fmtDuration((t.exitT - t.entryT) * 1000)} · <i>paper trading, frais inclus</i>`,
  ].join('\n');
}

/** Bilan de toutes les stratégies. */
function portfolioMessage(gold, cfg) {
  const lines = [
    '<b>📒 Bilan paper trading — Or</b> <i>(simulation, aucun argent réel)</i>',
    `Prix : ${gold.price ? `$${gold.price.toFixed(2)}` : '?'} · $${cfg.goldSizeUsd} par trade`,
    `PnL total : <b>${signedUsd(gold.totalPnl)}</b>`,
  ];
  for (const r of gold.rows) {
    const pos = r.position
      ? `${r.position.side === 'long' ? '📈 long' : '📉 short'} depuis $${r.position.entry.toFixed(2)} (${signedUsd(r.unrealized)})`
      : 'pas de position';
    lines.push(
      '',
      `<b>${esc(r.strategy.name)}</b>`,
      `  ${r.trades} trades · ${r.winRate.toFixed(0)}% gagnants · PnL <b>${signedUsd(r.pnlUsd)}</b>${r.profitFactor ? ` · PF ${r.profitFactor.toFixed(2)}` : ''}`,
      `  ${pos}`,
    );
  }
  return lines.join('\n');
}

/** Résultat d'un backtest (commande /backtest). */
function backtestMessage(results, info, cfg) {
  const lines = [
    `<b>🧪 Backtest or · ${info.days} jours (bougies 1 h)</b>`,
    `$${info.from.toFixed(0)} → $${info.to.toFixed(0)} · achat-conservation ${signedPct(info.buyHold)}`,
    `$${cfg.goldSizeUsd} par trade · frais ${cfg.goldFeePct}% par côté`,
    '',
  ];
  for (const { strategy, r } of results) {
    lines.push(
      `<b>${esc(strategy.name)}</b>`,
      `  ${r.trades} trades · ${r.winRate.toFixed(0)}% gagnants · <b>${signedUsd(r.pnlUsd)}</b> · PF ${r.profitFactor ? r.profitFactor.toFixed(2) : '-'} · DD max $${r.maxDrawdown.toFixed(0)}`,
    );
  }
  lines.push('', '<i>PF > 1 = rentable sur la période. Résultats passés ≠ résultats futurs.</i>');
  return lines.join('\n');
}

module.exports = { esc, goldEventMessage, portfolioMessage, backtestMessage };
