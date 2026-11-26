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

/** Prix lisible : 4 décimales sous 10 (EUR/USD), 2 sinon. */
const px = (v) => (Math.abs(v) < 10 ? v.toFixed(4) : v.toFixed(2));

async function safeSend(channel, text, extra, opts) {
  try {
    await channel.sendText(text, extra, opts);
  } catch (err) {
    console.error(`[canal] envoi impossible : ${explainTelegramError(err)}`);
  }
}

async function runCycle({ cfg, store, channel, publish = true, buttons = false }) {
  const ui = buttons ? require('./interactive') : null;
  const all = []; // événements de tous les marchés (compte FTMO simulé)
  const out = { events: 0, byMarket: {} };
  const markets = activeMarkets(cfg);
  const lastBarT = {}; // début de la dernière bougie 5 min de chaque marché (données du signal)

  for (const market of markets) {
    let n = 0;
    try {
      const trader = new MarketTrader(market, store, cfg);
      const evs = await trader.run();
      lastBarT[market.id] = trader.state.lastBarT;
      for (const ev of evs) {
        n++;
        console.log(
          `[${market.id}] ${ev.strategy.id} : ${ev.type === 'open' ? `open ${ev.pos.side} at ${ev.pos.entry.toFixed(2)}` : `close ${ev.trade.pnlPct.toFixed(2)}% (${ev.trade.reason})`}`,
        );
        // Un message par trade (TRADE_MESSAGES=1) ; sinon trades regroupés dans le résumé du jour (DIGEST_ALL / SCALP_DIGEST)
        if (publish && !cfg.publishFtmoOnly && (cfg.tradeMessages || !inDigest(cfg, ev.strategy))) await safeSend(channel, goldEventMessage(ev), ui ? { reply_markup: ui.tradeKeyboard(ev) } : {});
        all.push(ev);
      }
    } catch (err) {
      console.error(`[${market.id}] échec du passage :`, err.message);
    }
    out.byMarket[market.id] = n;
    out.events += n;
  }

  // Compte FTMO simulé : suit les trades des stratégies choisies, applique les règles du challenge
  const accts = cfg.ftmoEnabled ? require('./ftmoAccount').ftmoAccounts(cfg) : [];
  const books = Object.fromEntries(accts.map((a) => [a.id, require('./ftmoAccount').createFtmo({ cfg, store, account: a.id })]));
  // Délai signal → exécution (FILL_DELAY_SEC, 30 s) : entrées et sorties sur signal au cours de ce moment-là
  let fills = null;
  try {
    fills = await require('./fill').delayedFills(cfg, all, Object.values(books), { since: lastBarT });
    if (fills && Object.keys(fills).length) console.log(`[exécution] cours ${cfg.fillDelaySec} s après le signal : ${Object.entries(fills).map(([k, f]) => `${k} ${px(f.price)}`).join(', ')}`);
  } catch (err) {
    console.warn('[exécution] cours après délai indisponible :', err.message);
  }
  const refusedSeen = new Set(); // signaux bloqués par l'IA déjà annoncés pendant ce passage
  for (const acct of accts) {
    try {
      const ftmo = books[acct.id];
      const firm = acct.firm || 'FTMO';
      const name = `Simulated ${firm} account ${acct.emoji} ${acct.label}`;
      const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
      const button = ui && !acct.fundedOnly ? { reply_markup: { inline_keyboard: [[{ text: '🏦 View the account', callback_data: acct.firm === 'Lucid' ? 'm:f:g:l' : `m:f:${acct.id === 'nas100' ? 'n' : 'g'}` }]] } } : {};
      for (const msg of ftmo.onCycle(all, prices, undefined, { fills })) {
        // Chaque trade du compte FTMO (ouverture et clôture) : console + message dans le groupe (FTMO_TRADE_MESSAGES)
        if (msg.type === 'open' || msg.type === 'trade' || msg.type === 'refused' || msg.type === 'refusedResult') {
          // Clôture forcée par la limite de perte : le compte repart ensuite à zéro, on montre le solde du challenge clôturé
          const st0 = ftmo.status(prices);
          const st = msg.type === 'trade' && / rule$/.test(msg.p.reason || '') ? { ...st0, s: msg.s, equity: msg.s.balance, target: null } : st0;
          const text = ftmoTradeMessage(msg, st, marketById(cfg, msg.p.market));
          // Même signal refusé par FTMO et par Lucid dans ce passage : annoncé une seule fois (par FTMO)
          const sigKey = `${msg.type}:${msg.p.market}:${msg.p.sid}:${msg.p.entryT}`;
          if (msg.type === 'refused' || msg.type === 'refusedResult') {
            if (acct.firm === 'Lucid' && refusedSeen.has(sigKey)) continue;
            refusedSeen.add(sigKey);
          }
          console.log(`[${firm.toLowerCase()}] ${{ open: 'open', trade: 'close', refused: 'blocked by the AI', refusedResult: 'blocked trade result' }[msg.type]} ${msg.p.market}:${msg.p.sid} ${msg.p.side}${msg.type === 'trade' ? ` ${usd(msg.p.pnl)}` : ''}${msg.p.ai ? ` (AI ${Math.round(msg.p.ai.p * 100)}%)` : ''}`);
          // Clôture : bouton « 🎬 Vidéo » (PnL card animée, réservé à l'administrateur)
          const extra = msg.type === 'trade' && ui && msg.p.exitT
            ? { reply_markup: { inline_keyboard: [[...(button.reply_markup?.inline_keyboard?.[0] || []), { text: '🎬 Video', callback_data: `v:t:${acct.id === 'gold' || acct.id === 'nas100' ? 'ftmo' : acct.id}:${msg.p.exitT}:${msg.p.sid}`.slice(0, 64) }]] } }
            : button;
          if (publish && cfg.ftmoTradeMessages !== false) await safeSend(channel, text, extra, { dm: true });
          continue;
        }
        if (msg.type === 'fundedStart') {
          const text = `🟣🏁 <b>Lucid: simulated funded account started directly</b>\n${dollars(msg.s.capital)}, no evaluation, running alongside the Lucid evaluation and FTMO: funded-account risk, simulated payouts (5 winning days).\n<i>Simulated account: no real money.</i>`;
          console.log('[lucid] compte financé démarré directement');
          if (publish) await safeSend(channel, text, button, { dm: true });
          continue;
        }
        if (msg.type === 'parallel') {
          // Évaluation Lucid réussie : le compte financé tourne à part, une nouvelle évaluation repart en parallèle
          const text = msg.kept
            ? `🟣🏁 <b>Lucid: separate funded account started</b>\nEvaluation #${msg.s.attempt} becomes a funded account running in parallel (simulated payouts); a <b>new evaluation #${msg.next}</b> starts on the next trading day.\n<i>Simulated account: no real money.</i>`
            : `🟣🏁 <b>Lucid: evaluation #${msg.s.attempt} passed</b>\nA Lucid funded account is already running (1 at a time): it carries on, and a new evaluation #${msg.next} starts on the next trading day.\n<i>Simulated account: no real money.</i>`;
          console.log(`[lucid] évaluation n° ${msg.s.attempt} réussie → ${msg.kept ? 'compte financé à part' : 'compte financé déjà en cours'}, nouvelle évaluation n° ${msg.next}`);
          if (publish) await safeSend(channel, text, button, { dm: true });
          continue;
        }
        if (msg.type === 'payout') {
          const pct = Math.round((msg.trader / msg.amount) * 100);
          const text = `${firm === 'Lucid' ? '🟣' : '🏦'}💸 <b>${name}: simulated payout #${msg.n}</b>\n${dollars(msg.amount)} withdrawn from the funded account → <b>${dollars(msg.trader)} for you</b> (${pct}%) · total ${dollars(msg.total)}\n<i>Simulated account: no real money.</i>`;
          console.log(`[${firm.toLowerCase()}] retrait simulé ${dollars(msg.amount)} (${dollars(msg.trader)} pour le trader)`);
          if (publish) await safeSend(channel, text, button, { dm: true });
          continue;
        }
        if (!publish) continue;
        const { ftmoImage } = require('./cards');
        if (acct.fundedOnly && msg.type === 'fail') {
          const text = `🟣❌ <b>${name}: funded account lost</b>\n${msg.why}. Asleep until the next passed Lucid evaluation (or /financer lucid).\n<i>Simulated account: no real money.</i>`;
          await safeSend(channel, text, button, { dm: true });
          continue;
        }
        const st = ftmo.status(prices);
        const oneStep = st.program?.steps === 1;
        const split = st.program?.split || 80;
        const text = msg.type === 'pass'
          ? (oneStep ? `🏦🏆 <b>${name}: ${firm === 'Lucid' ? 'evaluation' : '1-step challenge'} passed (+${st.program?.target || 10}%), funded account!</b>\nNow tracking monthly gains (${split}% split).`
            : msg.phase === 1 ? `🏦✅ <b>${name}: step 1 passed (+10%)</b>\nMoving to step 2 (verification, +5% target).` : `🏦🏆 <b>${name}: step 2 passed, funded account!</b>\nNow tracking monthly gains (80% split).`)
          : `🏦❌ <b>${name}: ${firm === 'Lucid' ? 'evaluation' : 'challenge'} #${msg.s.attempt} failed</b>\n${msg.why}. A new challenge starts on the next trading day.`;
        await channel.sendPhoto(ftmoImage(st), text, button, { dm: true }).catch((err) => console.error(`[ftmo] ${explainTelegramError(err)}`));
      }
    } catch (err) {
      console.error('[ftmo]', err.message);
    }
  }

  // Portefeuille perso simulé : une fois par jour après la clôture de New York (achats / ventes des poches du bot)
  if (cfg.portfolioEnabled) {
    try {
      const pp = require('./personalPortfolio');
      const evs = await pp.update(cfg, store);
      const st = store.loadJson(pp.FILE, null);
      for (const ev of evs) {
        console.log(`[portefeuille] ${ev.type}${ev.sleeve ? ` ${ev.sleeve.sym} (${ev.sleeve.name})` : ''}`);
        if (publish) await safeSend(channel, pp.eventMessage(ev, st), {});
      }
    } catch (err) {
      console.error('[portefeuille]', err.message);
    }
  }

  // Résumé du jour des trades de scalp (une fois par jour, après la clôture de New York)
  if (publish && !cfg.publishFtmoOnly && cfg.scalpDigest && cfg.channelId) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() >= cfg.digestHourUtc && store.getMeta('lastDigestDay') !== today) {
      try {
        const text = scalpDigest(cfg, store, markets, store.getMeta('lastDigestAt') || Date.now() - 86_400_000);
        if (text) await channel.sendText(text, ui ? { reply_markup: { inline_keyboard: [[{ text: '🎛 Menu', callback_data: 'm:h:n' }, ...(cfg.ftmoEnabled ? [{ text: '🏦 FTMO account', callback_data: 'm:f:n' }] : [])]] } } : {});
        store.setMeta('lastDigestDay', today);
        store.setMeta('lastDigestAt', Date.now());
      } catch (err) {
        console.error(`[résumé] ${explainTelegramError(err)}`);
      }
    }
  }

  if (publish && !cfg.publishFtmoOnly && channel.summaryDue()) {
    for (const market of markets) await safeSend(channel, portfolio(cfg, store, market.id), ui ? { reply_markup: ui.summaryKeyboard(market.id) } : {});
    channel.markSummary();
  }

  // Graphique de l'évolution du portefeuille (une fois par jour par défaut), un par marché
  // Adaptation automatique : revue hebdomadaire (dimanche) de l'IA et des stratégies, annoncée dans le groupe
  if (cfg.ftmoEnabled && require('./adapt').reviewDue(cfg, store)) {
    try {
      const { text } = require('./adapt').weeklyReview(cfg, store);
      console.log(`[adapt] ${text.replace(/<[^>]+>/g, '').split('\n').join(' | ')}`);
      if (publish) await channel.sendText(text, ui ? { reply_markup: { inline_keyboard: [[{ text: '🏦 FTMO account', callback_data: 'm:f:g' }]] } } : {});
    } catch (err) {
      console.error('[adapt] revue impossible :', err.message);
    }
  }

  if (publish && markets.length && channel.chartDue() && cfg.publishFtmoOnly && cfg.ftmoEnabled) {
    // Mode « FTMO seul » : l'image du jour est celle du compte FTMO (panneau interactif si les boutons sont actifs)
    try {
      if (ui) {
        const outF = await ui.render(cfg, store, 'f', 'gold');
        await channel.sendPhoto(outF.png, outF.caption, { reply_markup: outF.keyboard });
      } else {
        const ftmo = require('./ftmoAccount').createFtmo({ cfg, store, account: 'gold' });
        const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
        await channel.sendPhoto(require('./cards').ftmoImage(ftmo.status(prices)), '🏦 <b>Simulated FTMO account</b> · daily status');
      }
    } catch (err) {
      console.error(`[canal] image FTMO impossible : ${explainTelegramError(err)}`);
    }
    channel.markChart();
  } else if (publish && markets.length && channel.chartDue()) {
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
  // Catégorie « Bot » du site : état en direct (non bloquant, au plus toutes les 15 s)
  if (cfg.livePush) require('./livePush').pushLive(cfg, store).catch(() => {});
  return out;
}

const SCALP_TF = new Set(['1m', '5m', '15m']);
const isScalp = (s) => SCALP_TF.has(s.tf || '1h');
const inDigest = (cfg, s) => cfg.scalpDigest && (cfg.digestAll || isScalp(s));
const usd = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const dollars = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
/** Écart d'exécution (délai signal → ordre) : « +0,8 $ en ta faveur » / « 1,2 $ contre toi ». */
function slip(p, signal, fill, exit = false) {
  const d = (fill - signal) * (p.side === 'long' ? 1 : -1) * (exit ? 1 : -1);
  const v = Math.abs(fill - signal);
  return `${Math.abs(fill) < 10 ? v.toFixed(4) : v.toFixed(2)} ${d >= 0 ? 'in your favor' : 'against you'}`;
}

/** Message d'un trade du compte FTMO : ouverture (`open`) ou clôture (`trade`). */
/** Avis de l'IA validatrice sur un trade du compte FTMO. */
function aiLine(ai) {
  const pc = Math.round(ai.p * 100);
  if (ai.ok) return `🤖 AI: ✅ approved · estimated odds ${pc}%`;
  return `🤖 AI (observe): ⚠️ would have refused · estimated odds ${pc}% (threshold ${Math.round(ai.min * 100)}%)`;
}

function ftmoTradeMessage(msg, st, market) {
  const p = msg.p;
  const mk = market ? `${market.emoji} ${market.id === 'nas100' ? 'Nasdaq' : market.name}` : p.market;
  const name = `<b>${esc(p.name || p.sid)}</b> <code>${esc(p.sid)}</code>`;
  const tag = st.account?.id === 'lucidf' ? '🟣 <b>Lucid funded</b>' : st.account?.firm === 'Lucid' ? '🟣 <b>Lucid</b>' : '🏦 <b>FTMO</b>';
  if (msg.type === 'open') {
    const pct = st.s.balance ? ((p.risk || 0) / st.s.balance) * 100 : 0;
    return [
      `${tag} · ${p.side === 'long' ? '📈 <b>BUY</b>' : '📉 <b>SELL</b>'} ${mk}`,
      name,
      `Entry $${px(p.entry)}${p.signal ? ` (signal $${px(p.signal)}, ${slip(p, p.signal, p.entry)})` : ''} · stop $${px(p.sl)} · ${p.n ? `${p.n} micro contract${p.n > 1 ? 's' : ''} ${p.contract} (${dollars(p.notional)})` : `${dollars(p.notional)} committed (leverage ${p.lev.toFixed(1)})`}`,
      `Risk ${dollars(p.risk || 0)} (${pct.toFixed(2)}% of the account) · <i>simulated account</i>`,
      ...(p.ai ? [aiLine(p.ai)] : []),
    ].join('\n');
  }
  if (msg.type === 'refused') {
    return [
      `${tag} · 🤖⛔ <b>Trade blocked by the AI</b> ${mk}`,
      name,
      `${p.side === 'long' ? 'Buy' : 'Sell'} at $${px(p.entry)} · stop $${px(p.sl)} · ${dollars(p.notional)} · risk avoided ${dollars(p.risk || 0)}`,
      `Estimated odds ${Math.round(p.ai.p * 100)}% (threshold ${Math.round(p.ai.min * 100)}%) → no trade, refused by the AI. The result will be posted when the shadow trade ends.`,
    ].join('\n');
  }
  if (msg.type === 'refusedResult') {
    return [
      `${tag} · 🤖 <b>Result of a trade blocked by the AI</b> ${mk}`,
      name,
      `${p.side === 'long' ? 'Buy' : 'Sell'} $${px(p.entry)} → $${px(p.exit)}${p.reason ? ` (${esc(p.reason)})` : ''}: it would have made <b>${usd(p.pnl)}</b>`,
      `${p.pnl < 0 ? '✅ The AI was right: loss avoided' : '❌ The AI was wrong: missed gain'} · <i>simulated account</i>`,
    ].join('\n');
  }
  const goal = st.target ? ` · target ${dollars(st.target)} (${Math.round(Math.min(1, Math.max(0, st.progress)) * 100)} %)` : '';
  return [
    `${tag} · ${p.pnl >= 0 ? '🟢' : '🔴'} close ${mk}`,
    name,
    `$${px(p.entry)} → $${px(p.exit)}${p.signalExit ? ` (signal $${px(p.signalExit)}, ${slip(p, p.signalExit, p.exit, true)})` : ''} · <b>${usd(p.pnl)}</b>`,
    `Account ${dollars(st.equity)} (${((st.equity / st.s.capital - 1) * 100).toFixed(2)}%)${goal} · <i>simulated account</i>`,
  ].join('\n');
}

/** Résumé des trades (clôtures et nouvelles positions) depuis `sinceMs`, par marché et par stratégie (+ compte FTMO simulé). */
function scalpDigest(cfg, store, markets, sinceMs) {
  const since = Math.floor(sinceMs / 1000);
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const lines = [`📋 <b>Daily summary${cfg.digestAll ? '' : ' — scalp'}</b> <i>(${date}, paper trading)</i>`];
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
        rows.push(`  • ${esc(s.name)} : ${fresh.side === 'long' ? '📈 buy' : '📉 sell'} at $${px(fresh.entry)} (stop $${px(fresh.sl)})`);
        opened++;
      }
      if (!done.length) continue;
      const p = done.reduce((a, t) => a + t.pnlUsd, 0);
      const w = done.filter((t) => t.pnlUsd > 0).length;
      n += done.length;
      wins += w;
      pnl += p;
      rows.push(`  • ${esc(s.name)} : ${done.length} trade${done.length > 1 ? 's' : ''}, ${w} winner${w > 1 ? 's' : ''}, <b>${usd(p)}</b> (${usd(acc.capital - market.startCapital)} since start)`);
    }
    lines.push('', `${market.emoji} <b>${esc(market.name)}</b> : ${n ? `${n} trade${n > 1 ? 's' : ''} closed · ${Math.round((wins / n) * 100)}% winners · <b>${usd(pnl)}</b>` : 'no closed trade'}${opened ? ` · ${opened} new position${opened > 1 ? 's' : ''}` : ''}${open ? ` · ${open} open position${open > 1 ? 's' : ''} in total` : ''}`);
    lines.push(...rows);
    if (n || opened) any = true;
  }
  for (const acct of cfg.ftmoEnabled ? require('./ftmoAccount').ftmoAccounts(cfg) : []) {
    const prices = Object.fromEntries(markets.map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
    const book = require('./ftmoAccount').createFtmo({ cfg, store, account: acct.id });
    if (book.asleep()) continue;
    const st = book.status(prices);
    const s = st.s;
    lines.push('', `🏦 <b>Simulated ${acct.firm || 'FTMO'} account ${acct.emoji} ${acct.label}</b>: ${s.phase === 'funded' ? 'funded account' : st.program?.steps === 1 ? '1-step challenge' : `step ${s.phase} of 2`} (challenge #${s.attempt}) · ${usd(st.equity - s.capital)} (${((st.equity / s.capital - 1) * 100).toFixed(2)}%)${st.target ? ` · ${Math.round(Math.min(1, st.progress) * 100)}% of target` : ''} · ${s.days.length} trading day${s.days.length > 1 ? 's' : ''}`);
    any = true;
  }
  lines.push('', '<i>Amounts: each strategy has its own paper trading account. Fake money.</i>');
  return any ? lines.join('\n').slice(0, 4096) : null;
}

/** Bilan texte d'un marché (or par défaut). */
function portfolio(cfg, store, marketId = 'nas100') {
  return portfolioMessage(new MarketTrader(marketById(cfg, marketId), store, cfg).stats(), cfg);
}

module.exports = { runCycle, portfolio, scalpDigest, isScalp, inDigest, ftmoTradeMessage };
