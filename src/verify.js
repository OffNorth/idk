/**
 * Vérification de cohérence des trades (commande /verif, admins) : paper trading des marchés actifs et compte FTMO.
 *   - position ouverte dont le stop est déjà franchi au cours actuel ;
 *   - trade clôturé « stop loss » dont la sortie n'est pas au niveau du stop ;
 *   - gain enregistré différent du calcul (sens × (sortie / entrée − 1), frais et financement inclus, tolérance) ;
 *   - stop du mauvais côté de l'entrée ;
 *   - position FTMO sans position paper correspondante (même stratégie, même date d'entrée).
 * Ne modifie rien : les positions FTMO incohérentes sont réparées par la réconciliation de chaque passage.
 */
const { activeMarkets } = require('./markets');

const fmt = (v) => (Math.abs(v) < 10 ? v.toFixed(4) : v.toFixed(2));
const when = (t) => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

/** Retourne { issues: [texte], checked: { trades, positions } } pour l'état stocké. */
function verify(cfg, store) {
  const issues = [];
  let trades = 0;
  let positions = 0;
  const papers = {};
  for (const m of activeMarkets(cfg)) {
    const st = store.loadJson(m.file, null);
    papers[m.id] = st;
    if (!st?.accounts) continue;
    const px = st.lastPrice;
    for (const [sid, acc] of Object.entries(st.accounts)) {
      const p = acc.position;
      if (p) {
        positions++;
        const long = p.side === 'long';
        if (p.sl && (long ? p.sl >= p.entry : p.sl <= p.entry) && sid !== 'hold') issues.push(`${m.emoji} ${sid}: stop ${fmt(p.sl)} on the wrong side of the entry ${fmt(p.entry)} (${long ? 'buy' : 'sell'})`);
        if (px && p.sl && sid !== 'hold' && (long ? px <= p.sl : px >= p.sl)) issues.push(`${m.emoji} ${sid}: ${long ? 'buy' : 'sell'} position still open although the price ${fmt(px)} crossed the stop ${fmt(p.sl)} (entry ${fmt(p.entry)} on ${when(p.entryT)})`);
      }
      for (const t of acc.closed || []) {
        trades++;
        const dir = t.side === 'long' ? 1 : -1;
        const raw = dir * (t.exit / t.entry - 1) * 100;
        // pnlPct = brut − 2 × frais − financement : l'écart doit rester petit (frais ≤ 0,1 % par côté, financement)
        const gap = raw - t.pnlPct;
        if (gap < -0.001 || gap > 0.25 + (t.financingPct || 0) * 100) issues.push(`${m.emoji} ${sid}: recorded gain ${t.pnlPct.toFixed(3)}% ≠ computed ${raw.toFixed(3)}% (${when(t.exitT)})`);
        const sl = t.sl ?? t.initSl;
        if (/^stop loss$/.test(t.reason) && sl && Math.abs(t.exit / sl - 1) > 0.0005) issues.push(`${m.emoji} ${sid}: "stop loss" close at ${fmt(t.exit)} instead of the stop ${fmt(sl)} (${when(t.exitT)})`);
      }
    }
  }
  const ftmo = store.loadJson('ftmo.json', null);
  let ftmoOpen = 0;
  for (const p of Object.values(ftmo?.open || {})) {
    ftmoOpen++;
    const acc = papers[p.market]?.accounts?.[p.sid];
    if (acc && !(acc.position && Math.abs(acc.position.entryT - p.entryT) < 2)) issues.push(`🏦 FTMO ${p.market}:${p.sid}: ${p.side === 'long' ? 'buy' : 'sell'} position open on the FTMO account but no longer in paper trading (fixed on the next pass)`);
    const px = papers[p.market]?.lastPrice;
    if (px && p.sl && (p.side === 'long' ? px <= p.sl : px >= p.sl)) issues.push(`🏦 FTMO ${p.market}:${p.sid}: price ${fmt(px)} beyond the stop ${fmt(p.sl)} (closed on the next pass)`);
  }
  return { issues, checked: { trades, positions, ftmoOpen, ftmoClosed: (ftmo?.closed || []).length } };
}

/** Rapport texte (HTML Telegram). */
/** Source des bougies intraday de chaque marché et âge de la dernière bougie 5 min (retard des données). */
function feedLines(cfg, store) {
  const { activeMarkets, useOanda } = require('./markets');
  const lines = [`📡 Intraday candles: ${useOanda(cfg) ? 'OANDA (real time)' : cfg.intradayFeed === 'yahoo' ? 'Yahoo (INTRADAY_FEED=yahoo)' : cfg.binanceFeed !== false ? 'gold and silver: Binance (public, real time) if reachable, otherwise Yahoo; indices: Yahoo' : 'Yahoo (gold delayed by about 10 min)'}`];
  for (const m of activeMarkets(cfg)) {
    const st = store.loadJson(m.file, {});
    if (!st.lastUpdate) continue;
    const age = st.lastBarT ? Math.round((st.lastUpdate / 1000 - st.lastBarT) / 60) : null;
    lines.push(`  • ${m.emoji} ${m.name}: ${{ oanda: 'OANDA', binance: 'Binance' }[st.feed] || 'Yahoo'}${age !== null ? ` · last 5-min candle opened ${age} min before the last pass${age > 15 ? ' (market closed or data delayed)' : ''}` : ''}`);
  }
  return lines;
}

function verifyReport(cfg, store) {
  const { issues, checked } = verify(cfg, store);
  const head = [`🔎 <b>Trade check</b> · ${checked.trades} closed trades, ${checked.positions} open paper positions · FTMO account: ${checked.ftmoOpen} open, ${checked.ftmoClosed} closed`, ...feedLines(cfg, store)].join('\n');
  if (!issues.length) return `${head}\n✅ No inconsistency found.`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const shown = issues.slice(0, 25).map((x) => `• ${esc(x)}`);
  const text = [head, `⚠️ ${issues.length} inconsistency(ies):`, ...shown, issues.length > 25 ? `… and ${issues.length - 25} more` : ''].filter(Boolean).join('\n');
  return require('./htmlSplit').truncHtml(text, 4000);
}

module.exports = { verify, verifyReport };
