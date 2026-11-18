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
  const mk = ev.market?.emoji || '🥇';
  const mn = esc(ev.market?.name || 'Or');
  if (ev.type === 'open' && ev.strategy.id === 'hold') {
    return [
      `${mk} <b>${mn} · ${name}</b>`,
      `Achat de référence simulé à <b>$${ev.pos.entry.toFixed(2)}</b> · taille $${ev.pos.size}, gardé sans limite de durée`,
      `<i>Sert à comparer : une stratégie doit faire mieux que simplement détenir ${ev.market?.id === 'nas100' ? 'l’indice (comme un ETF, sans financement)' : 'l’or'}.</i>`,
    ].join('\n');
  }
  if (ev.type === 'open') {
    const p = ev.pos;
    return [
      `${mk} <b>${mn} · ${name}</b>`,
      `${p.side === 'long' ? '📈 <b>ACHAT</b> (long)' : '📉 <b>VENTE À DÉCOUVERT</b> (short)'} simulé à <b>$${p.entry.toFixed(2)}</b> · taille $${p.size}`,
      `Stop : $${p.sl.toFixed(2)}${ev.strategy.trail ? ' (suiveur)' : ''} · Objectif : ${p.tp ? `$${p.tp.toFixed(2)}` : 'signal de sortie'}`,
      `<i>${ev.rsi != null ? `RSI ${Number(ev.rsi).toFixed(0)} · ` : ""}paper trading, aucun argent réel</i>`,
    ].join('\n');
  }
  const t = ev.trade;
  return [
    `${mk} ${t.pnlUsd >= 0 ? '🟢' : '🔴'} <b>${mn} · ${name}</b> — ${t.side === 'long' ? 'long' : 'short'} clôturé`,
    `$${t.entry.toFixed(2)} → $${t.exit.toFixed(2)} · <b>${signedPct(t.pnlPct)}</b> (${signedUsd(t.pnlUsd)} sur $${t.size})`,
    `Raison : ${esc(t.reason)} · durée ${fmtDuration((t.exitT - t.entryT) * 1000)} · <i>paper trading, frais inclus</i>`,
    ...(ev.capital !== undefined
      ? [`Capital de la stratégie : <b>${money(ev.capital)}</b> (${signedPct((ev.capital / ev.start - 1) * 100)} depuis le départ)`]
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
    `<b>📒 Bilan paper trading — ${gold.market?.emoji || '🥇'} ${esc(gold.market?.name || 'Or')}</b> <i>(simulation, gains réinvestis)</i>`,
    `Prix : ${gold.price ? `$${gold.price.toFixed(2)}` : '?'} · ${strat.length} stratégies × ${money(gold.start)}`,
    `Valeur du portefeuille : <b>${money(total)}</b> (${signedPct((total / start - 1) * 100)})`,
  ];
  if (ref) lines.push(`Référence achat-conservation : ${money(ref.equity)} (${signedPct(ref.returnPct)})`);
  for (const r of [...strat].sort((a, b) => b.equity - a.equity)) {
    const pos = r.position
      ? `${r.position.side === 'long' ? '📈 long' : '📉 short'} depuis $${r.position.entry.toFixed(2)} (${signedUsd(r.unrealized)})`
      : 'pas de position';
    lines.push(
      '',
      `<b>${esc(r.strategy.name)}</b> — ${money(r.equity)} (${signedPct(r.returnPct)})`,
      `  ${r.trades} trades · ${r.winRate.toFixed(0)}% gagnants${r.profitFactor ? ` · PF ${r.profitFactor.toFixed(2)}` : ''} · ${pos}`,
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
