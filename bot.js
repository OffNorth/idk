/**
 * bot.js — Bot Telegram de lancement de tokens Pump.fun
 *
 * Commandes :
 *   /start        — message d'accueil
 *   /launch       — wizard de lancement réel
 *   /preview      — wizard de simulation sans création du token
 *   /draft        — affiche le brouillon sauvegardé
 *   /clear_draft  — supprime le brouillon
 *   /cancel       — annule l'étape en cours
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Bot, session, InlineKeyboard, InputFile } = require('grammy');
const { conversations, createConversation } = require('@grammyjs/conversations');
const {
  launchToken,
  previewLaunch,
  getLaunchStatus,
  buildChannelMessage,
  fetchSolPriceUsd,
} = require('./pump');

if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN manquant');
if (!process.env.TELEGRAM_CHANNEL_ID) throw new Error('TELEGRAM_CHANNEL_ID manquant');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const TELEGRAM_FILE_BASE_URL = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const MAX_DESCRIPTION_LENGTH = readPositiveNumber('MAX_DESCRIPTION_LENGTH', 500);
const MAX_DEV_BUY_SOL = readPositiveNumber('MAX_DEV_BUY_SOL', 10);
const NETWORK_RETRIES = readPositiveNumber('NETWORK_RETRIES', 3);
const NETWORK_RETRY_DELAY_MS = readPositiveNumber('NETWORK_RETRY_DELAY_MS', 750);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DRAFT_DIR = path.join(DATA_DIR, 'drafts');
const DRAFT_IMAGE_DIR = path.join(DRAFT_DIR, 'images');
const LOG_FILE = process.env.LAUNCH_LOG_FILE || path.join(DATA_DIR, 'launches.jsonl');
const ALLOWED_TELEGRAM_USER_IDS = parseAllowedUserIds(process.env.ALLOWED_TELEGRAM_USER_IDS);

class LaunchCancelled extends Error {}

ensureDataDirs();

bot.use(async (ctx, next) => {
  if (!ALLOWED_TELEGRAM_USER_IDS.size || !ctx.from) return next();
  if (ALLOWED_TELEGRAM_USER_IDS.has(String(ctx.from.id))) return next();
  await ctx.reply('Accès refusé : ton ID Telegram n’est pas autorisé pour ce bot.');
});
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} doit être un nombre positif.`);
  }
  return value;
}

function parseAllowedUserIds(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function ensureDataDirs() {
  fs.mkdirSync(DRAFT_IMAGE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

function normalizeOptionalUrl(text) {
  const trimmed = text.trim();
  if (trimmed === '-') return null;

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.')) {
    return null;
  }
  return url.toString();
}

function getUserId(ctx) {
  return String(ctx.from?.id || ctx.chat?.id || 'unknown');
}

function draftPathFor(userId) {
  return path.join(DRAFT_DIR, `${userId}.json`);
}

async function readDraft(userId) {
  try {
    const draft = JSON.parse(await fs.promises.readFile(draftPathFor(userId), 'utf8'));
    if (draft.imagePath && !fs.existsSync(draft.imagePath)) delete draft.imagePath;
    return draft;
  } catch {
    return null;
  }
}

async function saveDraft(userId, draft) {
  await fs.promises.writeFile(
    draftPathFor(userId),
    JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }, null, 2)
  );
}

async function clearDraft(userId) {
  const draft = await readDraft(userId);
  if (draft?.imagePath) await cleanupFile(draft.imagePath);
  await cleanupFile(draftPathFor(userId));
}

async function appendLog(entry) {
  await fs.promises.appendFile(LOG_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function publicLaunchData(data) {
  return {
    name: data.name,
    symbol: data.symbol,
    description: data.description,
    socials: data.socials,
    devBuySol: data.devBuySol,
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, label, attempts = NETWORK_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(NETWORK_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`${label} échoué après ${attempts} tentative(s) : ${lastError?.message || lastError}`);
}

async function waitText(conversation) {
  const ctx = await conversation.waitFor('message:text');
  const text = ctx.msg.text.trim();
  if (text === '/cancel') {
    await ctx.reply('Lancement annulé. Le brouillon reste sauvegardé.', { reply_markup: { remove_keyboard: true } });
    throw new LaunchCancelled();
  }
  return { ctx, text };
}

async function waitAction(conversation, actions) {
  while (true) {
    const ctx = await conversation.waitFor(['callback_query:data', 'message:text']);
    const data = ctx.callbackQuery?.data;
    const text = ctx.msg?.text?.trim();

    if (data) {
      await ctx.answerCallbackQuery();
      const [, action] = data.split(':');
      if (actions.includes(action)) return { ctx, action };
    }

    if (text === '/cancel' || text === '❌ ANNULER') {
      await ctx.reply('Lancement annulé. Le brouillon reste sauvegardé.', { reply_markup: { remove_keyboard: true } });
      throw new LaunchCancelled();
    }

    await ctx.reply('Choisis un bouton ou tape /cancel.');
  }
}

async function downloadTelegramFile(ctx, fileId, extension, userId, previousPath) {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram n’a pas renvoyé de chemin de fichier.');

  await cleanupFile(previousPath);
  const imagePath = path.join(DRAFT_IMAGE_DIR, `${userId}_${Date.now()}_${Math.random().toString(36).slice(2)}.${extension}`);
  const res = await withRetry(
    () => fetch(`${TELEGRAM_FILE_BASE_URL}/${file.file_path}`),
    'Téléchargement image Telegram'
  );
  if (!res.ok) throw new Error(`Téléchargement image Telegram échoué : ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(imagePath, buffer);
  return imagePath;
}

async function cleanupFile(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); } catch {}
}

async function waitImage(conversation, userId, previousPath) {
  while (true) {
    const imgCtx = await conversation.waitFor(['message:photo', 'message:document', 'message:text']);
    const msg = imgCtx.msg;

    if (msg.text?.trim() === '/cancel') {
      await imgCtx.reply('Lancement annulé. Le brouillon reste sauvegardé.');
      throw new LaunchCancelled();
    }

    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      return downloadTelegramFile(imgCtx, photo.file_id, 'jpg', userId, previousPath);
    }

    const document = msg.document;
    if (document?.mime_type?.startsWith('image/')) {
      const extension = document.mime_type.includes('jpeg') || document.mime_type.includes('jpg') ? 'jpg' : 'png';
      return downloadTelegramFile(imgCtx, document.file_id, extension, userId, previousPath);
    }

    await imgCtx.reply('Ce fichier n’est pas une image PNG/JPG. Envoie une image ou tape /cancel.');
  }
}

function formatDraftSummary(data, status) {
  const solBalance = status ? `${status.balanceSol.toFixed(4)} SOL` : 'non vérifiée';
  const estimated = status ? `${status.estimatedRequiredSol.toFixed(4)} SOL` : 'non vérifié';
  const enough = status ? (status.hasEnoughBalance ? 'OK' : 'INSUFFISANT') : 'non vérifié';

  return [
    `📋 <b>Récapitulatif</b>`,
    ``,
    `Nom : <b>${escapeHtml(data.name)}</b>`,
    `Ticker : <b>$${escapeHtml(data.symbol)}</b>`,
    `Description : ${data.description ? escapeHtml(data.description) : '—'}`,
    `Twitter : ${data.socials?.twitter ? escapeHtml(data.socials.twitter) : '—'}`,
    `Telegram : ${data.socials?.telegram ? escapeHtml(data.socials.telegram) : '—'}`,
    `Site : ${data.socials?.website ? escapeHtml(data.socials.website) : '—'}`,
    `Dev buy : ${data.devBuySol > 0 ? `${data.devBuySol} SOL` : 'aucun'}`,
    ``,
    `🔐 <b>Contrôle wallet</b>`,
    `Wallet : <code>${status ? status.creator : 'non vérifié'}</code>`,
    `Balance : ${solBalance}`,
    `Besoin estimé : ${estimated}`,
    `Solde : <b>${enough}</b>`,
    `RPC : <code>${escapeHtml(status?.rpcUrl || 'non vérifié')}</code>`,
    `Métadonnées : <code>${escapeHtml(status?.metadataProvider || 'non vérifié')}</code>`,
  ].join('\n');
}

function launchActionsKeyboard(canLaunch) {
  const kb = new InlineKeyboard()
    .text('🔎 Preview IPFS', 'launch:preview')
    .row();

  if (canLaunch) kb.text('✅ LANCER', 'launch:launch');
  else kb.text('Balance insuffisante', 'launch:disabled');

  return kb.text('❌ ANNULER', 'launch:cancel');
}

function resumeKeyboard() {
  return new InlineKeyboard()
    .text('↩️ Reprendre', 'draft:resume')
    .text('🆕 Nouveau', 'draft:new')
    .row()
    .text('❌ Annuler', 'draft:cancel');
}

function draftOverview(draft) {
  return [
    `Brouillon sauvegardé :`,
    `Nom : ${draft.name || '—'}`,
    `Ticker : ${draft.symbol ? `$${draft.symbol}` : '—'}`,
    `Image : ${draft.imagePath ? 'oui' : 'non'}`,
    `Dev buy : ${Number.isFinite(draft.devBuySol) ? `${draft.devBuySol} SOL` : '—'}`,
    `Dernière mise à jour : ${draft.updatedAt || '—'}`,
  ].join('\n');
}

async function collectLaunchData(conversation, ctx, baseDraft = {}) {
  const userId = getUserId(ctx);
  const draft = { socials: {}, ...baseDraft, userId };

  async function update(partial) {
    Object.assign(draft, partial);
    await saveDraft(userId, draft);
  }

  if (!draft.name) {
    await ctx.reply(`1️⃣ Quel est le <b>nom</b> du token ? (ex : Chill House)`, { parse_mode: 'HTML' });
    const { text } = await waitText(conversation);
    if (!text || text.length > 32) throw new Error('Nom invalide : il doit contenir entre 1 et 32 caractères.');
    await update({ name: text });
  }

  if (!draft.symbol) {
    await ctx.reply('2️⃣ Quel est le <b>ticker</b> ? (ex : CHILL)', { parse_mode: 'HTML' });
    const { text } = await waitText(conversation);
    const symbol = text.replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(symbol)) {
      throw new Error('Ticker invalide : utilise 1 à 10 caractères, lettres A-Z et chiffres uniquement.');
    }
    await update({ symbol });
  }

  if (typeof draft.description !== 'string') {
    await ctx.reply('3️⃣ Donne une <b>description</b> (ou tape <code>-</code> pour ignorer) :', { parse_mode: 'HTML' });
    const { text } = await waitText(conversation);
    if (text !== '-' && text.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Description trop longue (max ${MAX_DESCRIPTION_LENGTH} caractères).`);
    }
    await update({ description: text === '-' ? '' : text });
  }

  if (!draft.imagePath || !fs.existsSync(draft.imagePath)) {
    await ctx.reply('4️⃣ Envoie <b>l’image</b> du token (PNG/JPG, carrée de préférence) :', { parse_mode: 'HTML' });
    const imagePath = await waitImage(conversation, userId, draft.imagePath);
    await update({ imagePath });
  }

  for (const [key, label] of [['twitter', 'Twitter/X'], ['telegram', 'Telegram'], ['website', 'Site web']]) {
    if (typeof draft.socials?.[key] === 'string') continue;

    await ctx.reply(`5️⃣ Lien <b>${label}</b> (ou tape <code>-</code> pour ignorer) :`, { parse_mode: 'HTML' });
    const { text } = await waitText(conversation);
    const url = normalizeOptionalUrl(text);
    if (text !== '-' && !url) throw new Error(`Lien ${label} invalide.`);
    await update({ socials: { ...draft.socials, [key]: url || '' } });
  }

  if (!Number.isFinite(draft.devBuySol)) {
    await ctx.reply(
      '6️⃣ <b>Dev buy</b> : combien de SOL veux-tu investir au lancement ?\n' +
      '(ex : 0.5 — tape <code>0</code> pour aucun achat initial)',
      { parse_mode: 'HTML' }
    );
    const { text } = await waitText(conversation);
    const devBuySol = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(devBuySol) || devBuySol < 0 || devBuySol > MAX_DEV_BUY_SOL) {
      throw new Error(`Montant invalide : choisis entre 0 et ${MAX_DEV_BUY_SOL} SOL.`);
    }
    await update({ devBuySol });
  }

  return draft;
}

async function maybeLoadDraft(conversation, ctx) {
  const userId = getUserId(ctx);
  const draft = await readDraft(userId);
  if (!draft) return {};

  await ctx.reply(draftOverview(draft), { reply_markup: resumeKeyboard() });
  const { action } = await waitAction(conversation, ['resume', 'new', 'cancel']);
  if (action === 'cancel') throw new LaunchCancelled();
  if (action === 'new') {
    await clearDraft(userId);
    return {};
  }
  return draft;
}

async function verifyTelegramChannel() {
  const chat = await bot.api.getChat(CHANNEL_ID);
  return { id: chat.id, title: chat.title || chat.username || String(chat.id) };
}

async function runPreview(data, ctx) {
  const preview = await previewLaunch(data);
  const channel = await verifyTelegramChannel();
  await appendLog({
    type: 'preview',
    userId: getUserId(ctx),
    username: ctx.from?.username || null,
    launch: publicLaunchData(data),
    uri: preview.uri,
    status: preview.status,
    channel,
  });

  return [
    `✅ <b>Preview OK, aucun token créé.</b>`,
    ``,
    `Wallet : <code>${preview.status.creator}</code>`,
    `Balance : ${preview.status.balanceSol.toFixed(4)} SOL`,
    `Besoin estimé : ${preview.status.estimatedRequiredSol.toFixed(4)} SOL`,
    `Canal : ${escapeHtml(channel.title)}`,
    `URI métadonnées : ${preview.uri ? escapeHtml(preview.uri) : 'non uploadée'}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

async function launchWizard(conversation, ctx) {
  let data;

  try {
    await ctx.reply(
      `🚀 <b>Lancement d'un token Pump.fun</b>\n\n` +
      `Répondez aux questions, ou tapez /cancel pour annuler. Un brouillon est sauvegardé automatiquement.`,
      { parse_mode: 'HTML' }
    );

    data = await collectLaunchData(conversation, ctx, await maybeLoadDraft(conversation, ctx));
    const status = await getLaunchStatus({ devBuySol: data.devBuySol });

    await ctx.replyWithPhoto(new InputFile(data.imagePath), {
      caption: formatDraftSummary(data, status),
      parse_mode: 'HTML',
      reply_markup: launchActionsKeyboard(status.hasEnoughBalance),
    });

    while (true) {
      const { ctx: actionCtx, action } = await waitAction(conversation, ['preview', 'launch', 'cancel', 'disabled']);

      if (action === 'cancel') {
        await actionCtx.reply('Lancement annulé. Le brouillon reste sauvegardé.');
        return;
      }

      if (action === 'disabled') {
        await actionCtx.reply('Balance insuffisante : recharge le wallet ou baisse le dev buy, puis relance /launch.');
        continue;
      }

      if (action === 'preview') {
        const message = await runPreview(data, actionCtx);
        await actionCtx.reply(message, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
        continue;
      }

      const progressMsg = await actionCtx.reply('⏳ Upload IPFS + création du token sur Solana…');
      try {
        const result = await launchToken(data);
        const solPriceUsd = await fetchSolPriceUsd();
        const channelMsg = buildChannelMessage(result, solPriceUsd);

        await bot.api.sendPhoto(CHANNEL_ID, new InputFile(data.imagePath), {
          caption: channelMsg,
          parse_mode: 'HTML',
        });

        await appendLog({
          type: 'launch_success',
          userId: getUserId(actionCtx),
          username: actionCtx.from?.username || null,
          launch: publicLaunchData(data),
          result,
        });
        await clearDraft(getUserId(actionCtx));

        await progressMsg.editText(
          `✅ <b>Token lancé !</b>\n\nMint : <code>${result.mint}</code>\n` +
          `https://pump.fun/coin/${result.mint}\n\nLe récap a été publié sur le canal.`,
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
        );
        return;
      } catch (err) {
        await appendLog({
          type: 'launch_failure',
          userId: getUserId(actionCtx),
          username: actionCtx.from?.username || null,
          launch: publicLaunchData(data),
          error: String(err.message || err),
        });
        throw err;
      }
    }
  } catch (err) {
    if (err instanceof LaunchCancelled) return;
    console.error(err);
    await ctx.reply(`❌ <b>Échec</b>\n\n<code>${escapeHtml(String(err.message || err).slice(0, 900))}</code>`, {
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
    });
  }
}

async function previewWizard(conversation, ctx) {
  try {
    await ctx.reply(
      `🔎 <b>Preview Pump.fun</b>\n\n` +
      `Je vérifie wallet, RPC, canal Telegram, image/IPFS et balance, sans créer le token.`,
      { parse_mode: 'HTML' }
    );

    const data = await collectLaunchData(conversation, ctx, await maybeLoadDraft(conversation, ctx));
    const message = await runPreview(data, ctx);
    await ctx.replyWithPhoto(new InputFile(data.imagePath), {
      caption: message,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    if (err instanceof LaunchCancelled) return;
    console.error(err);
    await ctx.reply(`❌ <b>Preview échoué</b>\n\n<code>${escapeHtml(String(err.message || err).slice(0, 900))}</code>`, {
      parse_mode: 'HTML',
    });
  }
}

bot.use(createConversation(launchWizard));
bot.use(createConversation(previewWizard));

/* ------------------------------------------------------------------ */
/* Commandes                                                           */
/* ------------------------------------------------------------------ */

bot.command('start', async (ctx) => {
  await ctx.reply(
    `👋 <b>Pump.fun Launch Bot</b>\n\n` +
    `/launch — lancer un nouveau token\n` +
    `/preview — simuler sans créer le token\n` +
    `/draft — afficher le brouillon\n` +
    `/clear_draft — supprimer le brouillon\n` +
    `/cancel — annuler une opération en cours`,
    { parse_mode: 'HTML' }
  );
});

bot.command('launch', async (ctx) => {
  await ctx.conversation.enter('launchWizard');
});

bot.command('preview', async (ctx) => {
  await ctx.conversation.enter('previewWizard');
});

bot.command('draft', async (ctx) => {
  const draft = await readDraft(getUserId(ctx));
  await ctx.reply(draft ? draftOverview(draft) : 'Aucun brouillon sauvegardé.');
});

bot.command('clear_draft', async (ctx) => {
  await clearDraft(getUserId(ctx));
  await ctx.reply('Brouillon supprimé.');
});

bot.command('cancel', async (ctx) => {
  await ctx.reply('Rien à annuler ici. Si un wizard est ouvert, tape /cancel dedans.');
});

bot.catch((err) => console.error('Erreur bot :', err));

function startBot() {
  bot.start({
    onStart: (info) => console.log(`🤖 Bot démarré : @${info.username}`),
  });

  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());
}

if (require.main === module) {
  startBot();
}

module.exports = {
  bot,
  launchWizard,
  previewWizard,
  normalizeOptionalUrl,
  escapeHtml,
  startBot,
  readDraft,
  saveDraft,
  clearDraft,
  formatDraftSummary,
};
