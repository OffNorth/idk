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
        if (p.sl && (long ? p.sl >= p.entry : p.sl <= p.entry) && sid !== 'hold') issues.push(`${m.emoji} ${sid} : stop ${fmt(p.sl)} du mauvais côté de l'entrée ${fmt(p.entry)} (${long ? 'achat' : 'vente'})`);
        if (px && p.sl && sid !== 'hold' && (long ? px <= p.sl : px >= p.sl)) issues.push(`${m.emoji} ${sid} : position ${long ? 'achat' : 'vente'} encore ouverte alors que le cours ${fmt(px)} a franchi le stop ${fmt(p.sl)} (entrée ${fmt(p.entry)} le ${when(p.entryT)})`);
      }
      for (const t of acc.closed || []) {
        trades++;
        const dir = t.side === 'long' ? 1 : -1;
        const raw = dir * (t.exit / t.entry - 1) * 100;
        // pnlPct = brut − 2 × frais − financement : l'écart doit rester petit (frais ≤ 0,1 % par côté, financement)
        const gap = raw - t.pnlPct;
        if (gap < -0.001 || gap > 0.25 + (t.financingPct || 0) * 100) issues.push(`${m.emoji} ${sid} : gain enregistré ${t.pnlPct.toFixed(3)} % ≠ calcul ${raw.toFixed(3)} % (${when(t.exitT)})`);
        const sl = t.sl ?? t.initSl;
        if (/^stop loss$/.test(t.reason) && sl && Math.abs(t.exit / sl - 1) > 0.0005) issues.push(`${m.emoji} ${sid} : clôture « stop loss » à ${fmt(t.exit)} au lieu du stop ${fmt(sl)} (${when(t.exitT)})`);
      }
    }
  }
  const ftmo = store.loadJson('ftmo.json', null);
  let ftmoOpen = 0;
  for (const p of Object.values(ftmo?.open || {})) {
    ftmoOpen++;
    const acc = papers[p.market]?.accounts?.[p.sid];
    if (acc && !(acc.position && Math.abs(acc.position.entryT - p.entryT) < 2)) issues.push(`🏦 FTMO ${p.market}:${p.sid} : position ${p.side === 'long' ? 'achat' : 'vente'} ouverte sur le compte FTMO mais plus en paper trading (réparée au prochain passage)`);
    const px = papers[p.market]?.lastPrice;
    if (px && p.sl && (p.side === 'long' ? px <= p.sl : px >= p.sl)) issues.push(`🏦 FTMO ${p.market}:${p.sid} : cours ${fmt(px)} au-delà du stop ${fmt(p.sl)} (clôturée au prochain passage)`);
  }
  return { issues, checked: { trades, positions, ftmoOpen, ftmoClosed: (ftmo?.closed || []).length } };
}

/** Rapport texte (HTML Telegram). */
function verifyReport(cfg, store) {
  const { issues, checked } = verify(cfg, store);
  const head = `🔎 <b>Vérification des trades</b> · ${checked.trades} trades clôturés, ${checked.positions} positions ouvertes en paper · compte FTMO : ${checked.ftmoOpen} ouvertes, ${checked.ftmoClosed} clôturées`;
  if (!issues.length) return `${head}\n✅ Aucune incohérence trouvée.`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const shown = issues.slice(0, 25).map((x) => `• ${esc(x)}`);
  return [head, `⚠️ ${issues.length} incohérence(s) :`, ...shown, issues.length > 25 ? `… et ${issues.length - 25} autres` : ''].filter(Boolean).join('\n').slice(0, 4000);
}

module.exports = { verify, verifyReport };
