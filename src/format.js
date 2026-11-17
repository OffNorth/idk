const { fmtUsd } = require('./scoring');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

function fmtAge(h) {
  if (h === null || h === undefined) return '?';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} j`;
}

function scoreBar(s) {
  const n = Math.round(s / 10);
  return '🟩'.repeat(n) + '⬜'.repeat(10 - n);
}

function links(t) {
  const out = [`<a href="${esc(t.url)}">DexScreener</a>`];
  if (t.chain === 'solana') {
    if (t.address.endsWith('pump')) out.push(`<a href="https://pump.fun/coin/${esc(t.address)}">Pump.fun</a>`);
    out.push(`<a href="https://rugcheck.xyz/tokens/${esc(t.address)}">RugCheck</a>`);
    out.push(`<a href="https://solscan.io/token/${esc(t.address)}">Solscan</a>`);
  }
  if (t.twitter) out.push(`<a href="${esc(t.twitter)}">X</a>`);
  if (t.telegram) out.push(`<a href="${esc(t.telegram)}">Telegram</a>`);
  if (t.website) out.push(`<a href="${esc(t.website)}">Site</a>`);
  return out.join(' · ');
}

/** Message Telegram (HTML) complet pour un token. */
function tokenMessage({ token: t, result: r, rug }, { rank, title } = {}) {
  const b = r.breakdown;
  const lines = [];
  if (title) lines.push(`<b>${esc(title)}</b>`, '');
  lines.push(
    `${rank ? `#${rank} ` : ''}<b>${esc(t.name)}</b> ($${esc(t.symbol)}) — ${esc(t.chain)} / ${esc(t.dex)}`,
    `<code>${esc(t.address)}</code>`,
    '',
    `⭐ Score : <b>${Math.round(r.total)}/100</b>  ${scoreBar(r.total)}`,
    '',
    `💰 MC : <b>${fmtUsd(t.marketCap)}</b>   💧 Liq : ${fmtUsd(t.liquidity)} (${(r.liqRatio * 100).toFixed(0)}%)`,
    `📊 Vol 1h : ${fmtUsd(t.vol.h1)}   Vol 24h : ${fmtUsd(t.vol.h24)}`,
    `📈 Prix : 5m ${pct(t.change.m5)} · 1h ${pct(t.change.h1)} · 6h ${pct(t.change.h6)} · 24h ${pct(t.change.h24)}`,
    `🔁 Tx 1h : ${t.txns.h1.buys} achats / ${t.txns.h1.sells} ventes   (24h : ${t.txns.h24.total})`,
    `⏱ Âge : ${fmtAge(t.ageHours)}   🔎 Source : ${esc((t.sources || []).join(', ') || '?')}`,
  );
  if (rug && rug.available) {
    const risks = rug.risks.length ? rug.risks.map((x) => `${x.level === 'danger' ? '🔴' : '🟠'} ${esc(x.name)}`).join(', ') : 'aucun';
    const lp = rug.lpLockedPct !== null ? ` · LP verrouillée ${Math.round(rug.lpLockedPct)}%` : '';
    lines.push(`🛡 RugCheck : ${rug.score}/100 de risque${lp}`, `   Risques : ${risks}`);
  } else if (t.chain === 'solana') {
    lines.push('🛡 RugCheck : indisponible');
  }
  lines.push(
    '',
    `<i>Détail : activité ${b.activity.toFixed(0)}/20 · momentum ${b.momentum.toFixed(0)}/15 · achats ${b.buyPressure.toFixed(0)}/20 · prix ${b.price.toFixed(0)}/15 · liquidité ${b.liquidity.toFixed(0)}/15 · social ${b.social}/10 · traders ${b.traders.toFixed(0)}/5${r.rugPenalty ? ` · pénalité risque −${r.rugPenalty.toFixed(0)}` : ''}</i>`,
    '',
    links(t),
    '',
    '<i>⚠️ Pas un conseil financier. Les meme coins peuvent perdre 100 % de leur valeur.</i>',
  );
  return lines.join('\n');
}

/** Résumé compact du classement (commande /top). */
function topMessage(ranked, stats, cfg, limit = 10, { channel = false } = {}) {
  const head = `<b>🏆 Top meme coins ${fmtUsd(cfg.minMarketCap)} – ${fmtUsd(cfg.maxMarketCap)}</b>\n` +
    `<i>${stats.discovered} découverts · ${stats.watched} suivis · ${stats.inRange} dans la fourchette · ${ranked.length} retenus</i>\n`;
  if (!ranked.length) return `${head}\nAucun token ne passe les filtres pour le moment.`;
  const rows = ranked.slice(0, limit).map(({ token: t, result: r }, i) =>
    `${i + 1}. <b>${esc(t.symbol)}</b> — ${Math.round(r.total)}/100 · MC ${fmtUsd(t.marketCap)} · 1h ${pct(t.change.h1)} · Vol24h ${fmtUsd(t.vol.h24)}\n` +
    `    <a href="${esc(t.url)}">chart</a> · <code>${esc(t.address)}</code>`,
  );
  const footer = channel
    ? '<i>⚠️ Pas un conseil financier. DYOR.</i>'
    : 'Détail d\'un token : /check &lt;adresse&gt;';
  return `${head}\n${rows.join('\n')}\n\n${footer}`;
}

/** Ligne console pour `npm run scan`. */
function consoleRow({ token: t, result: r, rug }, i) {
  const rugTxt = rug?.available ? `rug ${rug.score}` : 'rug -';
  return [
    String(i + 1).padStart(2),
    String(Math.round(r.total)).padStart(3),
    t.symbol.slice(0, 12).padEnd(12),
    fmtUsd(t.marketCap).padStart(8),
    fmtUsd(t.liquidity).padStart(8),
    fmtUsd(t.vol.h24).padStart(8),
    pct(t.change.h1).padStart(8),
    fmtAge(t.ageHours).padStart(7),
    rugTxt.padEnd(7),
    t.url,
  ].join('  ');
}

/* ------------------------------------------------------------------ */
/* Paper trading                                                       */
/* ------------------------------------------------------------------ */

function fmtPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return '$0';
  if (p >= 1) return `$${p.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `$${p.toPrecision(4)}`;
}

const signedUsd = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const dur = (ms) => fmtAge(ms / 3_600_000);

/** Ligne ajoutée sous une alerte quand un paper trade est ouvert. */
function paperOpenLine(pos, cfg) {
  return (
    `\n\n📝 <b>Paper trade</b> : achat simulé de $${pos.size} à ${fmtPrice(pos.entryPrice)} ` +
    `(TP +${cfg.paperTpPct}% · SL −${cfg.paperSlPct}% · trailing −${cfg.paperTrailPct}% après +${cfg.paperTrailStartPct}%)`
  );
}

function paperCloseMessage(t) {
  const icon = t.pnlUsd >= 0 ? '🟢' : '🔴';
  return [
    `${icon} <b>Paper trade clôturé — $${esc(t.symbol)}</b>`,
    `Entrée ${fmtPrice(t.entryPrice)} (MC ${fmtUsd(t.entryMc)}) → sortie ${fmtPrice(t.exitPrice)}${t.lastMc ? ` (MC ${fmtUsd(t.lastMc)})` : ''}`,
    `Résultat : <b>${signedPct(t.pnlPct)}</b> (${signedUsd(t.pnlUsd)} sur $${t.size}) · plus haut ${signedPct(t.peakPct)}`,
    `Raison : ${esc(t.reason)} · durée ${dur(t.exitAt - t.entryAt)} · score d'entrée ${t.score}/100`,
    `<a href="${esc(t.url)}">chart</a> · <i>simulation, frais inclus</i>`,
  ].join('\n');
}

function goldEventMessage(ev) {
  if (ev.type === 'open') {
    const p = ev.pos;
    return [
      `🥇 <b>Or — ${p.side === 'long' ? '📈 ACHAT (long)' : '📉 VENTE (short)'} simulé</b>`,
      `Entrée : $${p.entry.toFixed(2)} · taille $${p.size}`,
      `Stop loss : $${p.sl.toFixed(2)} · Take profit : $${p.tp.toFixed(2)}`,
      `<i>Signal : croisement EMA 20/50 en 1 h · RSI ${p.rsi.toFixed(0)} · paper trading</i>`,
    ].join('\n');
  }
  const t = ev.trade;
  return [
    `🥇 ${t.pnlUsd >= 0 ? '🟢' : '🔴'} <b>Or — position ${t.side === 'long' ? 'long' : 'short'} clôturée</b>`,
    `$${t.entry.toFixed(2)} → $${t.exit.toFixed(2)} · <b>${signedPct(t.pnlPct)}</b> (${signedUsd(t.pnlUsd)} sur $${t.size})`,
    `Raison : ${esc(t.reason)} · durée ${dur(t.exitAt - t.entryAt)} · <i>paper trading</i>`,
  ].join('\n');
}

/** Bilan complet du paper trading (memes + or). */
function portfolioMessage(memes, gold, cfg) {
  const lines = ['<b>📒 Bilan paper trading</b> <i>(simulation, aucun argent réel)</i>', ''];
  if (memes) {
    lines.push(
      `<b>Calls meme coins</b> ($${cfg.paperSizeUsd} par call)`,
      `Trades clôturés : ${memes.trades} · gagnants ${memes.wins} (${memes.winRate.toFixed(0)}%)`,
      `PnL réalisé : <b>${signedUsd(memes.realized)}</b>${memes.invested ? ` (${signedPct((memes.realized / memes.invested) * 100)} du capital engagé)` : ''}`,
      `Positions ouvertes : ${memes.open.length} · latent ${signedUsd(memes.unrealized)}`,
    );
    if (memes.best) {
      lines.push(`Meilleur : $${esc(memes.best.symbol)} ${signedPct(memes.best.pnlPct)} · Pire : $${esc(memes.worst.symbol)} ${signedPct(memes.worst.pnlPct)}`);
    }
    for (const p of memes.open.slice(0, 8)) {
      lines.push(`  • $${esc(p.symbol)} ${signedPct((p.last / p.entryPrice - 1) * 100)} depuis ${dur(Date.now() - p.entryAt)}`);
    }
    lines.push('');
  }
  if (gold) {
    lines.push(
      `<b>Or</b> ($${cfg.goldSizeUsd} par trade) · prix ${gold.lastPrice ? `$${gold.lastPrice.toFixed(2)}` : '?'}`,
      `Trades clôturés : ${gold.trades} · gagnants ${gold.wins} (${gold.winRate.toFixed(0)}%) · PnL <b>${signedUsd(gold.realized)}</b>`,
      gold.position
        ? `Position : ${gold.position.side} depuis $${gold.position.entry.toFixed(2)} · latent ${signedUsd(gold.unrealized)}`
        : "Position : aucune (attente d'un croisement EMA 20/50)",
    );
  }
  return lines.join('\n');
}

module.exports = {
  tokenMessage,
  topMessage,
  consoleRow,
  esc,
  fmtPrice,
  paperOpenLine,
  paperCloseMessage,
  goldEventMessage,
  portfolioMessage,
};
