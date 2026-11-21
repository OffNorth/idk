/**
 * Commandes Telegram des vidéos PnL (admin) :
 *   /video          → choix d'un des 10 derniers trades clôturés (comptes FTMO et Lucid), puis du fond, puis envoi
 *   /video dernier  → dernier trade, dernier fond choisi
 *   /fond <nom>     → en légende d'une vidéo (ou en réponse à une vidéo) : l'enregistre comme fond
 *   /fonds          → liste des fonds, avec suppression
 * Boutons : v:t:<compte>:<sortie>:<stratégie> (trade), v:b:…:<n° de fond> (fond), v:x:<nom> (supprimer un fond).
 */
const { InputFile } = require('grammy');
const V = require('./pnlVideo');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('fr-FR')} $`;
const NAME = { gold: 'Or', nas100: 'Nasdaq', spx: 'S&P 500', eurusd: 'EUR/USD' };

/** Trades clôturés des comptes simulés (challenge en cours + archive), du plus récent au plus ancien. */
function recentTrades(cfg, store, n = 10) {
  const { createFtmo, accountOf } = require('./ftmoAccount');
  const out = [];
  for (const id of ['gold', 'lucid']) {
    const A = accountOf(cfg, id);
    if (!A.enabled) continue;
    const f = createFtmo({ cfg, store, account: id });
    const s = f.load();
    const P = (A.program || require('./ftmoAccount').programOf(cfg));
    const acct = id === 'lucid' ? 'lucid' : 'ftmo';
    for (const t of [...(s.closed || []), ...f.archived()]) {
      out.push({ ...t, acct, account: A.firm || 'FTMO', program: P.label || '', capital: s.capital });
    }
  }
  const seen = new Set();
  return out.filter((t) => { const k = `${t.acct}:${t.exitT}:${t.sid}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => b.exitT - a.exitT).slice(0, n);
}
const keyOf = (t) => `${t.acct}:${t.exitT}:${t.sid}`;
const findTrade = (cfg, store, acct, exitT, sid) => recentTrades(cfg, store, 400).find((t) => t.acct === acct && String(t.exitT) === String(exitT) && t.sid === sid);

function tradeLabel(t) {
  const d = new Date(t.exitT * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
  return `${t.acct === 'lucid' ? '🟣' : '🏦'} ${d} · ${NAME[t.market] || t.market} ${t.side === 'long' ? 'achat' : 'vente'} · ${money(t.pnl)}`;
}

function attachVideo(bot, { cfg, store, isAdmin }) {
  const state = store.loadJson('video.json', { bg: 'uni' });
  const saveState = () => store.saveJson('video.json', state);

  const bgKeyboard = (t) => {
    const list = V.backgrounds(cfg);
    const rows = [];
    for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((b, j) => ({ text: `${b.id === state.bg ? '• ' : ''}${b.label}`, callback_data: `v:b:${keyOf(t)}:${i + j}`.slice(0, 64) })));
    return { inline_keyboard: rows };
  };

  async function render(ctx, t, bgId) {
    state.bg = bgId;
    saveState();
    const wait = await ctx.reply(`⏳ Vidéo en préparation (${esc(tradeLabel(t))}, fond « ${esc(V.backgrounds(cfg).find((b) => b.id === bgId)?.label || bgId)} »)… environ 10 à 30 s.`, { parse_mode: 'HTML' }).catch(() => null);
    await ctx.replyWithChatAction('upload_video').catch(() => {});
    const R = t.risk > 0 ? ` · ${(t.pnl / t.risk).toFixed(1).replace('.', ',')} R` : '';
    const caption = `🎬 <b>${esc(NAME[t.market] || t.market)}</b> · ${t.side === 'long' ? 'achat' : 'vente'} · <b>${money(t.pnl)}</b>${R}\n${esc(t.account)} · ${esc(t.program)} · <i>compte simulé, argent fictif</i>`;
    try {
      const buf = await V.makeVideo(cfg, t, bgId);
      await ctx.replyWithVideo(new InputFile(buf, 'pnl.mp4'), { caption, parse_mode: 'HTML', width: 1080, height: 1920, supports_streaming: true });
    } catch (err) {
      if (err.code === 'NOFFMPEG') {
        const png = await V.cardPng(t).catch(() => null);
        if (png) await ctx.replyWithPhoto(new InputFile(png, 'pnl.png'), { caption: `${caption}\n⚠️ Vidéo impossible (ffmpeg absent sur le serveur) : carte en image.`, parse_mode: 'HTML' });
        else await ctx.reply('❌ Vidéo impossible : ffmpeg absent sur le serveur, et bougies indisponibles.');
      } else {
        await ctx.reply(`❌ Vidéo impossible : ${esc(err.message)}`, { parse_mode: 'HTML' });
      }
    } finally {
      if (wait) ctx.api.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    }
  }

  bot.command('video', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Commande réservée à l’administrateur du bot.');
    const trades = recentTrades(cfg, store);
    if (!trades.length) return ctx.reply('Aucun trade clôturé sur les comptes FTMO / Lucid pour l’instant.');
    if (/dernier|last/i.test(ctx.match || '')) return render(ctx, trades[0], state.bg || 'uni');
    return ctx.reply('🎬 <b>Vidéo PnL</b> : choisis un trade.', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: trades.map((t) => [{ text: tradeLabel(t), callback_data: `v:t:${keyOf(t)}`.slice(0, 64) }]) },
    });
  });

  // Vidéo de fond : légende « /fond nom » sur une vidéo, ou réponse « /fond nom » à une vidéo
  async function saveFond(ctx, name, video) {
    if (!isAdmin(ctx)) return ctx.reply('Commande réservée à l’administrateur du bot.');
    if (!video) return ctx.reply('Envoie une vidéo avec la légende « /fond nom », ou réponds « /fond nom » à une vidéo.');
    if ((video.file_size || 0) > 20 * 1024 * 1024) return ctx.reply('❌ Vidéo trop lourde : 20 Mo au plus (limite de Telegram pour les bots).');
    if (!name) return ctx.reply('Donne un nom au fond : « /fond plage ».');
    try {
      const file = await ctx.api.getFile(video.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${cfg.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`téléchargement : HTTP ${res.status}`);
      const n = V.saveBackground(cfg, name, Buffer.from(await res.arrayBuffer()));
      state.bg = `u:${n}`;
      saveState();
      return ctx.reply(`✅ Fond « ${esc(n)} » enregistré (choisi par défaut). /video pour l’utiliser.`, { parse_mode: 'HTML' });
    } catch (err) {
      return ctx.reply(`❌ Fond non enregistré : ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  const videoOf = (m) => m?.video || (m?.document && /^video\//.test(m.document.mime_type || '') ? m.document : null) || m?.animation || null;
  bot.on(['message:video', 'message:document', 'message:animation'], async (ctx, next) => {
    const cap = ctx.message.caption || '';
    const m = cap.match(/^\/fond(?:@\w+)?\s*(.*)$/i);
    if (!m) return next();
    return saveFond(ctx, m[1].trim(), videoOf(ctx.message));
  });
  bot.command('fond', (ctx) => saveFond(ctx, (ctx.match || '').trim(), videoOf(ctx.message.reply_to_message)));

  bot.command('fonds', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Commande réservée à l’administrateur du bot.');
    const own = V.backgrounds(cfg).filter((b) => b.id.startsWith('u:'));
    return ctx.reply([
      '🎞 <b>Fonds des vidéos</b>',
      `Intégrés : ${Object.values(V.BUILTIN).join(', ')}`,
      own.length ? `Tes vidéos : ${own.map((b) => esc(b.id.slice(2))).join(', ')}` : 'Aucune vidéo à toi : envoie une vidéo avec la légende « /fond nom ».',
      `Fond par défaut : ${esc(V.backgrounds(cfg).find((b) => b.id === state.bg)?.label || 'Uni')}`,
    ].join('\n'), { parse_mode: 'HTML', reply_markup: own.length ? { inline_keyboard: own.map((b) => [{ text: `🗑 Supprimer ${b.id.slice(2)}`, callback_data: `v:x:${b.id.slice(2)}`.slice(0, 64) }]) } : undefined });
  });

  bot.callbackQuery(/^v:/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Réservé à l’administrateur du bot.' }).catch(() => {});
    const p = ctx.callbackQuery.data.split(':');
    if (p[1] === 'x') {
      V.deleteBackground(cfg, p[2]);
      if (state.bg === `u:${V.safeName(p[2])}`) { state.bg = 'uni'; saveState(); }
      return ctx.answerCallbackQuery({ text: `Fond « ${p[2]} » supprimé` }).catch(() => {});
    }
    const t = findTrade(cfg, store, p[2], p[3], p[4]);
    if (!t) return ctx.answerCallbackQuery({ text: 'Trade introuvable (trop ancien ?)' }).catch(() => {});
    if (p[1] === 't') {
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply(`🎞 Fond de la vidéo pour ${esc(tradeLabel(t))} :`, { parse_mode: 'HTML', reply_markup: bgKeyboard(t) });
    }
    if (p[1] === 'b') {
      const bg = V.backgrounds(cfg)[Number(p[5])];
      await ctx.answerCallbackQuery({ text: '🎬 Vidéo en préparation…' }).catch(() => {});
      return render(ctx, t, bg ? bg.id : 'uni');
    }
    return ctx.answerCallbackQuery().catch(() => {});
  });
}

module.exports = { attachVideo, recentTrades, tradeLabel };
