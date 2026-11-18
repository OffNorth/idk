/**
 * Un passage, partagé par bot.js (serveur) et once.js (GitHub Actions), pour chaque marché actif (or, Nasdaq 100) :
 *   1. paper trading, toutes stratégies (ouvertures / clôtures publiées ; le scalp est regroupé dans un résumé du jour)
 *   2. bilan publié sur le canal si c'est l'heure
 *   3. graphique de l'évolution du portefeuille si c'est l'heure
 * Avec buttons = true (bot.js), boutons sous les messages : carte du trade, cours, panneau interactif.
 */
const { MarketTrader, activeMarkets, marketById } = require('./markets');
const { goldEventMessage, portfolioMessage, esc } = require('./format');
const { explainTelegramError } = require('./channel');

async function safeSend(channel, text, extra) {
  try {
    await channel.sendText(text, extra);
  } catch (err) {
    console.error(`[canal] envoi impossible : ${explainTelegramError(err)}`);
  }
}

async function runCycle({ cfg, store, channel, publish = true, buttons = false }) {
  const ui = buttons ? require('./interactive') : null;
  const all = []; // événements de tous les marchés (compte FTMO simulé)
  const out = { events: 0, byMarket: {} };
  const markets = activeMarkets(cfg);

  for (const market of markets) {
    let n = 0;
    try {
      for (const ev of await new MarketTrader(market, store, cfg).run()) {
        n++;
        console.log(
          `[${market.id}] ${ev.strategy.id} : ${ev.type === 'open' ? `ouverture ${ev.pos.side} à ${ev.pos.entry.toFixed(2)}` : `clôture ${ev.trade.pnlPct.toFixed(2)}% (${ev.trade.reason})`}`,
        );
        // Un message par trade (TRADE_MESSAGES=1) ; sinon trades regroupés dans le résumé du jour (DIGEST_ALL / SCALP_DIGEST)
        if (publish && (cfg.tradeMessages || !inDigest(cfg, ev.strategy))) await safeSend(channel, goldEventMessage(ev), ui ? { reply_markup: ui.tradeKeyboard(ev) } : {});
        all.push(ev);
      }
    } catch (err) {
      console.error(`[${market.id}] échec du passage :`, err.message);
    }
    out.byMarket[market.id] = n;
    out.events += n;
  }

  // Compte FTMO simulé : suit les trades des stratégies choisies, applique les règles du challenge
  for (const acct of cfg.ftmoEnabled ? require('./ftmoAccount').ftmoAccounts(cfg) : []) {
    try {
      const ftmo = require('./ftmoAccount').createFtmo({ cfg, store, account: acct.id });
      const name = `Compte FTMO simulé ${acct.emoji} ${acct.label}`;
      const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
      for (const msg of ftmo.onCycle(all, prices)) {
        if (msg.type === 'trade' || !publish) continue;
        const { ftmoImage } = require('./cards');
        const st = ftmo.status(prices);
        const text = msg.type === 'pass'
          ? (msg.phase === 1 ? `🏦✅ <b>${name} : étape 1 réussie (+10 %)</b>\nPassage à l’étape 2 (vérification, objectif +5 %).` : `🏦🏆 <b>${name} : étape 2 réussie, compte financé !</b>\nOn suit maintenant les gains mensuels (partage 80 %).`)
          : `🏦❌ <b>${name} : challenge n° ${msg.s.attempt} échoué</b>\n${msg.why}. Un nouveau challenge démarre au prochain jour de trading.`;
        await channel.sendPhoto(ftmoImage(st), text, ui ? { reply_markup: { inline_keyboard: [[{ text: '🏦 Voir le compte', callback_data: `m:f:${acct.id === 'nas100' ? 'n' : 'g'}` }]] } } : {}).catch((err) => console.error(`[ftmo] ${explainTelegramError(err)}`));
      }
    } catch (err) {
      console.error('[ftmo]', err.message);
    }
  }

  // Résumé du jour des trades de scalp (une fois par jour, après la clôture de New York)
  if (publish && cfg.scalpDigest && cfg.channelId) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= cfg.digestHourUtc && store.getMeta('lastDigestDay') !== today) {
      try {
        const text = scalpDigest(cfg, store, markets, store.getMeta('lastDigestAt') || Date.now() - 86_400_000);
        if (text) await channel.sendText(text, ui ? { reply_markup: { inline_keyboard: [[{ text: '🎛 Menu', callback_data: 'm:h:n' }, ...(cfg.ftmoEnabled ? [{ text: '🏦 Compte FTMO', callback_data: 'm:f:n' }] : [])]] } } : {});
        store.setMeta('lastDigestDay', today);
        store.setMeta('lastDigestAt', Date.now());
      } catch (err) {
        console.error(`[résumé] ${explainTelegramError(err)}`);
      }
    }
  }

  if (publish && channel.summaryDue()) {
    for (const market of markets) await safeSend(channel, portfolio(cfg, store, market.id), ui ? { reply_markup: ui.summaryKeyboard(market.id) } : {});
    channel.markSummary();
  }

  // Graphique de l'évolution du portefeuille (une fois par jour par défaut), un par marché
  if (publish && markets.length && channel.chartDue()) {
    const { liveChart } = require('./portfolio');
    for (const market of markets) {
      try {
        if (ui) {
          // Graphique du jour = panneau interactif : les boutons changent l'image sur place
          const out = await ui.render(cfg, store, 'h', market.id);
          await channel.sendPhoto(out.png, out.caption, { reply_markup: out.keyboard });
        } else {
          const { png, caption } = liveChart(store, cfg, market.id);
          await channel.sendPhoto(png, caption);
        }
      } catch (err) {
        console.error(`[canal] graphique ${market.id} impossible : ${explainTelegramError(err)}`);
      }
    }
    channel.markChart();
  }
  return out;
}

const SCALP_TF = new Set(['1m', '5m', '15m']);
const isScalp = (s) => SCALP_TF.has(s.tf || '1h');
const inDigest = (cfg, s) => cfg.scalpDigest && (cfg.digestAll || isScalp(s));
const usd = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Résumé des trades (clôtures et nouvelles positions) depuis `sinceMs`, par marché et par stratégie (+ compte FTMO simulé). */
function scalpDigest(cfg, store, markets, sinceMs) {
  const since = Math.floor(sinceMs / 1000);
  const date = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const lines = [`📋 <b>Résumé du jour${cfg.digestAll ? '' : ' — scalp'}</b> <i>(${date}, paper trading)</i>`];
  let any = false;
  for (const market of markets) {
    const tr = new MarketTrader(market, store, cfg);
    const strats = tr.strategies.filter((s) => inDigest(cfg, s));
    if (!strats.length) continue;
    const rows = [];
    let n = 0;
    let wins = 0;
    let pnl = 0;
    let open = 0;
    let opened = 0;
    for (const s of strats) {
      const acc = tr.account(s.id);
      const done = acc.closed.filter((t) => t.exitT >= since);
      const fresh = acc.position && acc.position.entryT >= since ? acc.position : null;
      if (acc.position) open++;
      if (fresh && !isScalp(s)) {
        // Stratégie journalière : la nouvelle position compte (elle est souvent gardée des semaines)
        rows.push(`  • ${esc(s.name)} : ${fresh.side === 'long' ? '📈 achat' : '📉 vente'} à $${fresh.entry.toFixed(2)} (stop $${fresh.sl.toFixed(2)})`);
        opened++;
      }
      if (!done.length) continue;
      const p = done.reduce((a, t) => a + t.pnlUsd, 0);
      const w = done.filter((t) => t.pnlUsd > 0).length;
      n += done.length;
      wins += w;
      pnl += p;
      rows.push(`  • ${esc(s.name)} : ${done.length} trade${done.length > 1 ? 's' : ''}, ${w} gagnant${w > 1 ? 's' : ''}, <b>${usd(p)}</b> (${usd(acc.capital - market.startCapital)} depuis le début)`);
    }
    lines.push('', `${market.emoji} <b>${esc(market.name)}</b> : ${n ? `${n} trade${n > 1 ? 's' : ''} clôturé${n > 1 ? 's' : ''} · ${Math.round((wins / n) * 100)} % gagnants · <b>${usd(pnl)}</b>` : 'aucun trade clôturé'}${opened ? ` · ${opened} nouvelle${opened > 1 ? 's' : ''} position${opened > 1 ? 's' : ''}` : ''}${open ? ` · ${open} position${open > 1 ? 's' : ''} ouverte${open > 1 ? 's' : ''} au total` : ''}`);
    lines.push(...rows);
    if (n || opened) any = true;
  }
  for (const acct of cfg.ftmoEnabled ? require('./ftmoAccount').ftmoAccounts(cfg) : []) {
    const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
    const st = require('./ftmoAccount').createFtmo({ cfg, store, account: acct.id }).status(prices);
    const s = st.s;
    lines.push('', `🏦 <b>Compte FTMO simulé ${acct.emoji} ${acct.label}</b> : ${s.phase === 'funded' ? 'compte financé' : `étape ${s.phase} sur 2`} (challenge n° ${s.attempt}) · ${usd(st.equity - s.capital)} (${((st.equity / s.capital - 1) * 100).toFixed(2)} %)${st.target ? ` · ${Math.round(Math.min(1, st.progress) * 100)} % de l’objectif` : ''} · ${s.days.length} jour${s.days.length > 1 ? 's' : ''} de trading`);
    any = true;
  }
  lines.push('', '<i>Montants : chaque stratégie a son propre compte de paper trading. Argent fictif.</i>');
  return any ? lines.join('\n').slice(0, 4096) : null;
}

/** Bilan texte d'un marché (or par défaut). */
function portfolio(cfg, store, marketId = 'nas100') {
  return portfolioMessage(new MarketTrader(marketById(cfg, marketId), store, cfg).stats(), cfg);
}

module.exports = { runCycle, portfolio, scalpDigest, isScalp, inDigest };
