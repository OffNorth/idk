/**
 * Commandes Telegram des vidéos PnL (admin) :
 *   /video          → choix d'un des 10 derniers trades clôturés (comptes FTMO et Lucid), puis du fond, puis envoi
 *   /video dernier  → dernier trade, dernier fond choisi
 *   /fond <nom>     → en légende d'une vidéo (ou en réponse à une vidéo) : l'enregistre comme fond
 *   /fonds          → liste des fonds, avec suppression
 *   Envoie une vidéo au bot (en privé, ou avec la légende /video dans un groupe) → il demande le trade et renvoie
 *   ta vidéo avec la PnL card transparente par-dessus (format, durée ≤ 30 s et son gardés).
 * Boutons : v:t:<compte>:<sortie>:<stratégie> (trade), v:b:…:<n° de fond> (fond), v:x:<nom> (supprimer un fond).
 */
const { InputFile } = require('grammy');
const V = require('./pnlVideo');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const NAME = { gold: 'Gold', nas100: 'Nasdaq', spx: 'S&P 500', eurusd: 'EUR/USD', silver: 'Silver', dow: 'Dow Jones', russell: 'Russell 2000',
  ...Object.fromEntries(Object.entries(require('./stocks').STOCKS).map(([k, v]) => [k, v.name])) };

/** Trades clôturés des comptes simulés (challenge en cours + archive), du plus récent au plus ancien. */
function recentTrades(cfg, store, n = 10) {
  const { createFtmo, accountOf } = require('./ftmoAccount');
  const out = [];
  for (const id of ['gold', 'lucid', 'lucid2', 'lucidf']) {
    const A = accountOf(cfg, id);
    if (!A.enabled) continue;
    const f = createFtmo({ cfg, store, account: id });
    const s = f.load();
    const P = (A.program || require('./ftmoAccount').programOf(cfg));
    const acct = id === 'gold' ? 'ftmo' : id;
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
  const d = new Date(t.exitT * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
  return `${t.acct === 'ftmo' ? '🏦' : '🟣'} ${d} · ${NAME[t.market] || t.market} ${t.side === 'long' ? 'buy' : 'sell'} · ${money(t.pnl)}`;
}

function attachVideo(bot, { cfg, store, isAdmin }) {
  // ffmpeg préparé dès le démarrage (téléchargé par le bot s'il manque), pour que la 1re vidéo soit rapide
  V.ensureFfmpeg(cfg).then((p) => console.log(`[vidéo] ffmpeg prêt : ${p}`), (err) => console.warn(`[vidéo] ${err.message}`));
  const state = store.loadJson('video.json', { bg: 'uni' });
  // Signature des vidéos : /signature, sinon VIDEO_HANDLE, sinon @realzigg ; « aucune » = sans signature
  const handle = () => (state.handle !== undefined ? state.handle : process.env.VIDEO_HANDLE ?? '@realzigg');
  const saveState = () => store.saveJson('video.json', state);
  // Vidéo en préparation quand le bot a été coupé (serveur à court de mémoire, redémarrage) : rien n'a été envoyé et
  // aucune erreur n'a pu s'afficher → on prévient au redémarrage, et la prochaine vidéo est faite en qualité allégée
  if (state.inflight && Date.now() - state.inflight.at < 6 * 3600_000) {
    const f = state.inflight;
    state.light = true;
    state.inflight = null;
    saveState();
    setTimeout(() => bot.api.sendMessage(f.chat, `❌ <b>The video ${esc(f.label)} was not sent</b>: the bot was stopped while preparing it (the server is probably short on memory, or it restarted).\nRun /video again: the next one will be made in lighter quality (540 px).`, { parse_mode: 'HTML' }).catch(() => {}), 5000);
  } else if (state.inflight) {
    state.inflight = null;
    saveState();
  }

  const bgKeyboard = (t) => {
    const list = V.backgrounds(cfg);
    const rows = [];
    // 1er choix : ta propre vidéo (le bot attend que tu l'envoies), puis les fonds intégrés et enregistrés
    rows.push([{ text: '📤 My video (I’ll send it)', callback_data: `v:w:${keyOf(t)}`.slice(0, 64) }]);
    for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((b, j) => ({ text: `${b.id === state.bg ? '• ' : ''}${b.label}`, callback_data: `v:b:${keyOf(t)}:${i + j}`.slice(0, 64) })));
    return { inline_keyboard: rows };
  };

  async function render(ctx, t, bgId, sourceFile = null, ack = null) {
    if (!sourceFile) { state.bg = bgId; saveState(); }
    const what = sourceFile ? 'on your video' : `background "${esc(V.backgrounds(cfg).find((b) => b.id === bgId)?.label || bgId)}"`;
    const msg = `⏳ Preparing the video (${esc(tradeLabel(t))}, ${what})… about 10 to 60 s.`;
    // accusé de réception déjà affiché : on le modifie plutôt que d'envoyer un nouveau message
    const wait = ack
      ? await ctx.api.editMessageText(ack.chat.id, ack.message_id, `${ack.head}\n${msg}`, { parse_mode: 'HTML' }).then(() => ack, () => ack)
      : await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => null);
    await ctx.replyWithChatAction('upload_video').catch(() => {});
    const R = t.risk > 0 ? ` · ${(t.pnl / t.risk).toFixed(1)} R` : '';
    const caption = `🎬 <b>${esc(NAME[t.market] || t.market)}</b> · ${t.side === 'long' ? 'buy' : 'sell'} · <b>${money(t.pnl)}</b>${R}\n${esc(t.account)} · ${esc(t.program)} · <i>simulated account, fake money</i>`;
    const chat = ctx.chat?.id;
    state.inflight = { chat, at: Date.now(), label: tradeLabel(t) };
    saveState();
    const t0 = Date.now();
    try {
      const buf = await V.makeVideo(cfg, t, bgId, { sourceFile, handle: handle(), light: !!state.light });
      console.log(`[vidéo] prête en ${Math.round((Date.now() - t0) / 1000)} s (${(buf.length / 1e6).toFixed(1)} Mo${state.light ? ', qualité allégée' : ''}), envoi…`);
      try {
        await ctx.replyWithVideo(new InputFile(buf, 'pnl.mp4'), { caption, parse_mode: 'HTML', supports_streaming: true });
      } catch (err) {
        // Envoi en vidéo refusé (format, taille, délai) : même fichier en document, avec la raison
        console.warn(`[vidéo] envoi en vidéo refusé (${err.description || err.message}), envoi en fichier`);
        await ctx.replyWithDocument(new InputFile(buf, 'pnl.mp4'), { caption: `${caption}\n⚠️ Sent as a file (${esc(err.description || err.message)})`, parse_mode: 'HTML' });
      }
      if (state.light && Date.now() - t0 < 60_000) state.light = false; // le serveur a tenu : retour à la qualité normale
    } catch (err) {
      if (err.code === 'NOFFMPEG') {
        const png = await V.cardPng(t, { handle: handle() }).catch(() => null);
        if (png) await ctx.replyWithPhoto(new InputFile(png, 'pnl.png'), { caption: `${caption}\n⚠️ Video failed: ${esc(err.message)}. Card as an image.`, parse_mode: 'HTML' });
        else await ctx.reply('❌ Video failed: ffmpeg missing on the server, and candles unavailable.');
      } else {
        await ctx.reply(`❌ Video failed: ${esc(err.message)}`, { parse_mode: 'HTML' });
      }
    } finally {
      state.inflight = null;
      saveState();
      if (wait) ctx.api.deleteMessage(wait.chat.id, wait.message_id).catch(() => {});
    }
  }
  /** Préparation en arrière-plan : le bot continue de répondre aux autres commandes pendant la vidéo. */
  const jobs = new Set();
  const renderLater = (...a) => {
    const p = render(...a).catch((err) => console.error('[vidéo]', err.message)).finally(() => jobs.delete(p));
    jobs.add(p);
  };

  bot.command('video', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Command reserved for the bot admin.');
    const trades = recentTrades(cfg, store);
    if (!trades.length) return ctx.reply('No closed trade on the FTMO / Lucid accounts yet.');
    if (/dernier|last/i.test(ctx.match || '')) return renderLater(ctx, trades[0], state.bg || 'uni');
    return ctx.reply('🎬 <b>PnL video</b>: pick a trade, then "📤 My video" to put the card on your video (or a built-in background).\n<i>Tip: in private, send a video straight to the bot.</i>', {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: trades.map((t) => [{ text: tradeLabel(t), callback_data: `v:t:${keyOf(t)}`.slice(0, 64) }]) },
    });
  });

  // Vidéo de fond : légende « /fond nom » sur une vidéo, ou réponse « /fond nom » à une vidéo
  async function saveFond(ctx, name, video) {
    if (!isAdmin(ctx)) return ctx.reply('Command reserved for the bot admin.');
    if (!video) return ctx.reply('Send a video with the caption "/fond name", or reply "/fond name" to a video.');
    if ((video.file_size || 0) > 20 * 1024 * 1024) return ctx.reply('❌ Video too large: 20 MB max (Telegram limit for bots).');
    if (!name) return ctx.reply('Give the background a name: "/fond beach".');
    try {
      const file = await ctx.api.getFile(video.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${cfg.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
      const n = V.saveBackground(cfg, name, Buffer.from(await res.arrayBuffer()));
      state.bg = `u:${n}`;
      saveState();
      return ctx.reply(`✅ Background "${esc(n)}" saved (now the default). /video to use it.`, { parse_mode: 'HTML' });
    } catch (err) {
      return ctx.reply(`❌ Background not saved: ${esc(err.message)}`, { parse_mode: 'HTML' });
    }
  }
  const videoOf = (m) => m?.video || (m?.document && /^video\//.test(m.document.mime_type || '') ? m.document : null) || m?.animation || null;
  // Vidéo envoyée au bot : « /fond nom » → fond enregistré ; sinon (en privé, ou légende /video en groupe) → la PnL
  // card transparente est posée sur cette vidéo, pour le trade choisi
  const pending = new Map(); // chat → { file, at } : vidéo reçue, trade à choisir
  const awaiting = new Map(); // chat → { trade, at } : trade choisi, vidéo attendue (bouton « Ma vidéo »)
  const tmpDir = require('path').join(cfg.dataDir, 'tmp');
  async function download(video) {
    const file = await bot.api.getFile(video.file_id);
    const res = await fetch(`https://api.telegram.org/file/bot${cfg.telegramToken}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  bot.on(['message:video', 'message:document', 'message:animation'], async (ctx, next) => {
    const cap = (ctx.message.caption || '').trim();
    const m = cap.match(/^\/fond(?:@\w+)?\s*(.*)$/i);
    if (m) return saveFond(ctx, m[1].trim(), videoOf(ctx.message));
    const video = videoOf(ctx.message);
    const asked = /^\/video\b/i.test(cap);
    const wait = awaiting.get(String(ctx.chat.id));
    const waited = wait && Date.now() - wait.at < 15 * 60_000;
    if (!video || (ctx.chat.type !== 'private' && !asked && !waited)) return next();
    if (!isAdmin(ctx)) return asked ? ctx.reply('Reserved for the bot admin.') : next();
    if ((video.file_size || 0) > 20 * 1024 * 1024) return ctx.reply('❌ Video too large: 20 MB max (Telegram limit for bots). Shorten it or lower its quality.');
    const trades = recentTrades(cfg, store);
    if (!trades.length) return ctx.reply('No closed trade on the FTMO / Lucid accounts yet.');
    // Accusé de réception immédiat (avant le téléchargement), avec ce que Telegram dit de la vidéo
    const info = [
      video.duration ? `${video.duration} s` : null,
      video.file_size ? `${(video.file_size / 1024 / 1024).toFixed(1)} MB` : null,
      video.width && video.height ? `${video.width}×${video.height}` : null,
    ].filter(Boolean).join(' · ');
    const head = `✅ <b>Video received</b>${info ? ` (${info})` : ''}${video.duration > 30 ? '\n<i>Only the first 30 seconds will be used.</i>' : ''}`;
    const ackMsg = await ctx.reply(`📥 <b>Video received</b>${info ? ` (${info})` : ''} — downloading…`, { parse_mode: 'HTML' }).catch(() => null);
    const edit = (text, extra = {}) => (ackMsg ? ctx.api.editMessageText(ackMsg.chat.id, ackMsg.message_id, text, { parse_mode: 'HTML', ...extra }).catch(() => ctx.reply(text, { parse_mode: 'HTML', ...extra })) : ctx.reply(text, { parse_mode: 'HTML', ...extra }));
    try {
      const fsx = require('fs');
      fsx.mkdirSync(tmpDir, { recursive: true });
      // ménage : vidéos de plus d'une heure
      for (const f of fsx.readdirSync(tmpDir)) { const pth = require('path').join(tmpDir, f); if (Date.now() - fsx.statSync(pth).mtimeMs > 3600_000) fsx.rmSync(pth, { force: true }); }
      const file = require('path').join(tmpDir, `src-${ctx.chat.id}.mp4`);
      fsx.writeFileSync(file, await download(video));
      pending.set(String(ctx.chat.id), { file, at: Date.now() });
      const ack = ackMsg ? { chat: ackMsg.chat, message_id: ackMsg.message_id, head } : null;
      if (waited) { awaiting.delete(String(ctx.chat.id)); return renderLater(ctx, wait.trade, null, file, ack); }
      if (/dernier|last/i.test(cap)) return renderLater(ctx, trades[0], null, file, ack);
      return edit(`${head}\n🎬 Which trade should go on it?`, { reply_markup: { inline_keyboard: trades.map((t) => [{ text: tradeLabel(t), callback_data: `v:o:${keyOf(t)}`.slice(0, 64) }]) } });
    } catch (err) {
      return edit(`❌ Video received but not downloaded: ${esc(err.message)}. Send it again (20 MB max).`);
    }
  });
  bot.command('fond', (ctx) => saveFond(ctx, (ctx.match || '').trim(), videoOf(ctx.message.reply_to_message)));

  bot.command('signature', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Command reserved for the bot admin.');
    const arg = (ctx.match || '').trim();
    if (!arg) return ctx.reply(`✍️ Video signature: ${handle() ? esc(handle()) : 'none'}\nChange: /signature @name · remove: /signature none`, { parse_mode: 'HTML' });
    state.handle = /^(aucune|non|off|none)$/i.test(arg) ? '' : arg.slice(0, 40);
    saveState();
    return ctx.reply(`✅ Video signature: ${state.handle ? esc(state.handle) : 'none'}`, { parse_mode: 'HTML' });
  });

  bot.command('fonds', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Command reserved for the bot admin.');
    const own = V.backgrounds(cfg).filter((b) => b.id.startsWith('u:'));
    return ctx.reply([
      '🎞 <b>Video backgrounds</b>',
      `Built-in: ${Object.values(V.BUILTIN).join(', ')}`,
      own.length ? `Your videos: ${own.map((b) => esc(b.id.slice(2))).join(', ')}` : 'No video of yours: send a video with the caption "/fond name".',
      `Default background: ${esc(V.backgrounds(cfg).find((b) => b.id === state.bg)?.label || 'Plain')}`,
    ].join('\n'), { parse_mode: 'HTML', reply_markup: own.length ? { inline_keyboard: own.map((b) => [{ text: `🗑 Delete ${b.id.slice(2)}`, callback_data: `v:x:${b.id.slice(2)}`.slice(0, 64) }]) } : undefined });
  });

  bot.callbackQuery(/^v:/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Reserved for the bot admin.' }).catch(() => {});
    const p = ctx.callbackQuery.data.split(':');
    if (p[1] === 'x') {
      V.deleteBackground(cfg, p[2]);
      if (state.bg === `u:${V.safeName(p[2])}`) { state.bg = 'uni'; saveState(); }
      return ctx.answerCallbackQuery({ text: `Background "${p[2]}" deleted` }).catch(() => {});
    }
    const t = findTrade(cfg, store, p[2], p[3], p[4]);
    if (!t) return ctx.answerCallbackQuery({ text: 'Trade introuvable (trop ancien ?)' }).catch(() => {});
    if (p[1] === 't') {
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply(`🎞 Video background for ${esc(tradeLabel(t))}:`, { parse_mode: 'HTML', reply_markup: bgKeyboard(t) });
    }
    if (p[1] === 'w') {
      awaiting.set(String(ctx.chat?.id), { trade: t, at: Date.now() });
      await ctx.answerCallbackQuery().catch(() => {});
      return ctx.reply(`📤 Now send your video here (20 MB max): the PnL card of ${esc(tradeLabel(t))} will be placed on it, keeping its format, length (30 s max) and sound.`, { parse_mode: 'HTML' });
    }
    if (p[1] === 'o') {
      const pend = pending.get(String(ctx.chat?.id));
      if (!pend || !require('fs').existsSync(pend.file) || Date.now() - pend.at > 3600_000) return ctx.answerCallbackQuery({ text: 'Video expired: send it to the bot again.' }).catch(() => {});
      await ctx.answerCallbackQuery({ text: '🎬 Preparing the video…' }).catch(() => {});
      return renderLater(ctx, t, null, pend.file);
    }
    if (p[1] === 'b') {
      const bg = V.backgrounds(cfg)[Number(p[5])];
      await ctx.answerCallbackQuery({ text: '🎬 Preparing the video…' }).catch(() => {});
      return renderLater(ctx, t, bg ? bg.id : 'uni');
    }
    return ctx.answerCallbackQuery().catch(() => {});
  });
  /** Attend la fin des vidéos en préparation (tests). */
  return { idle: () => Promise.all([...jobs]) };
}

module.exports = { attachVideo, recentTrades, tradeLabel };
