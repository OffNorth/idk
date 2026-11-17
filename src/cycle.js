/**
 * Un cycle complet, partagé par bot.js (serveur) et once.js (GitHub Actions) :
 *   1. paper trades meme coins (si PAPER_TRADING=1)
 *   2. alertes meme coins (si SCANNER=1)
 *   3. paper trading de l'or, toutes stratégies
 *   4. résumé + bilan paper trading si c'est l'heure
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

/** res = résultat du scan meme coins, ou null si le scanner est désactivé. */
async function runCycle({ cfg, store, channel, res, alertsEnabled = true }) {
  const out = { sent: 0, paperClosed: 0, goldEvents: 0 };
  const book = cfg.paperEnabled ? new PaperBook(store, cfg) : null;

  // 1. Paper trades meme coins
  if (book) {
    for (const trade of await book.update()) {
      out.paperClosed++;
      console.log(`[paper] ${trade.symbol} clôturé ${trade.pnlPct.toFixed(1)}% (${trade.reason})`);
      if (alertsEnabled) await safeSend(channel, paperCloseMessage(trade));
    }
  }

  // 2. Alertes meme coins
  if (alertsEnabled && res) {
    out.sent = await channel.postAlerts(res, {
      extra: (item) =>
        book && !book.isOpen(`${item.token.chain}:${item.token.address}`) && item.token.priceUsd > 0
          ? paperOpenLine({ size: cfg.paperSizeUsd, entryPrice: item.token.priceUsd }, cfg)
          : '',
      onSent: (item) => book && book.open(item),
    });
  }

  // 3. Or
  if (cfg.goldEnabled) {
    try {
      for (const ev of await new GoldTrader(store, cfg).run()) {
        out.goldEvents++;
        console.log(
          `[or] ${ev.strategy.id} : ${ev.type === 'open' ? `ouverture ${ev.pos.side} à ${ev.pos.entry.toFixed(2)}` : `clôture ${ev.trade.pnlPct.toFixed(2)}% (${ev.trade.reason})`}`,
        );
        if (alertsEnabled) await safeSend(channel, goldEventMessage(ev));
      }
    } catch (err) {
      console.error('[or] échec :', err.message);
    }
  }

  // 4. Résumé périodique
  if (alertsEnabled && channel.topSummaryDue()) {
    try {
      if (res) await channel.postTop(res);
      else store.setMeta('lastTopSummaryAt', Date.now());
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
