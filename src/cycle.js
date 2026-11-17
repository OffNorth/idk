/**
 * Un cycle complet, partagé par bot.js (serveur) et once.js (GitHub Actions) :
 *   1. clôture des paper trades meme coins selon leurs règles
 *   2. publication des nouvelles alertes + ouverture d'un paper trade par alerte
 *   3. paper trading de l'or
 *   4. résumé du top + bilan paper trading si c'est l'heure
 */
const { PaperBook } = require('./paper');
const { GoldTrader } = require('./gold');
const { paperOpenLine, paperCloseMessage, goldEventMessage, portfolioMessage } = require('./format');
const { explainTelegramError } = require('./channel');

async function safeSend(channel, text) {
  try {
    await channel.sendText(text);
  } catch (err) {
    console.error(`[canal] envoi impossible : ${explainTelegramError(err)}`);
  }
}

async function runCycle({ cfg, store, channel, res, alertsEnabled = true }) {
  const book = new PaperBook(store, cfg);
  const gold = new GoldTrader(store, cfg);
  const out = { sent: 0, paperClosed: 0, goldEvents: 0 };

  // 1. Paper trades meme coins
  if (cfg.paperEnabled) {
    for (const trade of await book.update()) {
      out.paperClosed++;
      console.log(`[paper] ${trade.symbol} clôturé ${trade.pnlPct.toFixed(1)}% (${trade.reason})`);
      if (alertsEnabled) await safeSend(channel, paperCloseMessage(trade));
    }
  }

  // 2. Alertes (+ ouverture des paper trades)
  if (alertsEnabled) {
    out.sent = await channel.postAlerts(res, {
      extra: (item) =>
        cfg.paperEnabled && !book.isOpen(`${item.token.chain}:${item.token.address}`) && item.token.priceUsd > 0
          ? paperOpenLine({ size: cfg.paperSizeUsd, entryPrice: item.token.priceUsd }, cfg)
          : '',
      onSent: (item) => book.open(item),
    });
  }

  // 3. Or
  if (cfg.goldEnabled) {
    try {
      for (const ev of await gold.run()) {
        out.goldEvents++;
        console.log(`[or] ${ev.type === 'open' ? `ouverture ${ev.pos.side} à ${ev.pos.entry}` : `clôture ${ev.trade.pnlPct.toFixed(2)}%`}`);
        if (alertsEnabled) await safeSend(channel, goldEventMessage(ev));
      }
    } catch (err) {
      console.error('[or] échec :', err.message);
    }
  }

  // 4. Résumé périodique
  if (alertsEnabled && channel.topSummaryDue()) {
    try {
      await channel.postTop(res);
      if (cfg.paperEnabled || cfg.goldEnabled) await safeSend(channel, portfolio(cfg, store));
    } catch (err) {
      console.error(`[canal] résumé impossible : ${explainTelegramError(err)}`);
    }
  }
  return out;
}

function portfolio(cfg, store) {
  return portfolioMessage(
    cfg.paperEnabled ? new PaperBook(store, cfg).stats() : null,
    cfg.goldEnabled ? new GoldTrader(store, cfg).stats() : null,
    cfg,
  );
}

module.exports = { runCycle, portfolio };
