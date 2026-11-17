/**
 * Un passage, partagé par bot.js (serveur) et once.js (GitHub Actions) :
 *   1. paper trading de l'or, toutes stratégies (ouvertures / clôtures publiées)
 *   2. bilan publié sur le canal si c'est l'heure
 *   3. graphique de l'évolution du portefeuille si c'est l'heure
 */
const { GoldTrader } = require('./gold');
const { goldEventMessage, portfolioMessage } = require('./format');
const { explainTelegramError } = require('./channel');

async function safeSend(channel, text) {
  try {
    await channel.sendText(text);
  } catch (err) {
    console.error(`[canal] envoi impossible : ${explainTelegramError(err)}`);
  }
}

async function runCycle({ cfg, store, channel, publish = true }) {
  const out = { events: 0 };

  if (cfg.goldEnabled) {
    for (const ev of await new GoldTrader(store, cfg).run()) {
      out.events++;
      console.log(
        `[or] ${ev.strategy.id} : ${ev.type === 'open' ? `ouverture ${ev.pos.side} à ${ev.pos.entry.toFixed(2)}` : `clôture ${ev.trade.pnlPct.toFixed(2)}% (${ev.trade.reason})`}`,
      );
      if (publish) await safeSend(channel, goldEventMessage(ev));
    }
  }

  if (publish && channel.summaryDue()) {
    await safeSend(channel, portfolio(cfg, store));
    channel.markSummary();
  }

  // Graphique de l'évolution du portefeuille (une fois par jour par défaut)
  if (publish && cfg.goldEnabled && channel.chartDue()) {
    try {
      const { liveChart } = require('./portfolio');
      const { png, caption } = liveChart(store, cfg);
      await channel.sendPhoto(png, caption);
    } catch (err) {
      console.error(`[canal] graphique impossible : ${explainTelegramError(err)}`);
    }
    channel.markChart();
  }
  return out;
}

function portfolio(cfg, store) {
  return portfolioMessage(new GoldTrader(store, cfg).stats(), cfg);
}

module.exports = { runCycle, portfolio };
