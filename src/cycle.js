/**
 * Un passage, partagé par bot.js (serveur) et once.js (GitHub Actions), pour chaque marché actif (or, Nasdaq 100) :
 *   1. paper trading, toutes stratégies (ouvertures / clôtures publiées)
 *   2. bilan publié sur le canal si c'est l'heure
 *   3. graphique de l'évolution du portefeuille si c'est l'heure
 * Avec buttons = true (bot.js), boutons sous les messages : carte du trade, cours, panneau interactif.
 */
const { MarketTrader, activeMarkets, marketById } = require('./markets');
const { goldEventMessage, portfolioMessage } = require('./format');
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
        if (publish) await safeSend(channel, goldEventMessage(ev), ui ? { reply_markup: ui.tradeKeyboard(ev) } : {});
      }
    } catch (err) {
      console.error(`[${market.id}] échec du passage :`, err.message);
    }
    out.byMarket[market.id] = n;
    out.events += n;
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

/** Bilan texte d'un marché (or par défaut). */
function portfolio(cfg, store, marketId = 'gold') {
  return portfolioMessage(new MarketTrader(marketById(cfg, marketId), store, cfg).stats(), cfg);
}

module.exports = { runCycle, portfolio };
