/**
 * Publication sur le canal Telegram (partagé entre bot.js et once.js).
 */
const { tokenMessage, topMessage } = require('./format');

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

function explainTelegramError(err) {
  const d = err?.description || err?.message || String(err);
  if (err?.error_code === 401 || /unauthorized/i.test(d)) return `${d} → TELEGRAM_BOT_TOKEN invalide (vérifie le token donné par @BotFather).`;
  if (/chat not found/i.test(d)) return `${d} → TELEGRAM_CHANNEL_ID est faux (utilise @nom_du_canal ou l'ID -100…).`;
  if (/not enough rights|need administrator|have no rights|not a member|kicked/i.test(d)) {
    return `${d} → ajoute le bot comme ADMINISTRATEUR du canal avec le droit « Publier des messages ».`;
  }
  return d;
}

/**
 * @param {import('grammy').Api} api
 * @param {object} cfg
 * @param {import('./store').Store} store
 */
function createChannel(api, cfg, store) {
  /** Envoie un message HTML sur le canal, avec l'image du token en aperçu si possible. */
  async function send(text, imageUrl) {
    const preview =
      cfg.alertWithImage && imageUrl
        ? { link_preview_options: { url: imageUrl, prefer_large_media: true, show_above_text: true } }
        : {};
    try {
      return await api.sendMessage(cfg.channelId, text, { ...HTML, ...preview });
    } catch (err) {
      if (!imageUrl || !cfg.alertWithImage) throw err;
      return api.sendMessage(cfg.channelId, text, HTML); // l'aperçu image a échoué → texte seul
    }
  }

  /** Publie les nouveaux tokens au-dessus du score minimum (sans doublon). */
  async function postAlerts(res, { extra = () => '', onSent = () => {} } = {}) {
    if (!cfg.channelId) return 0;
    let sent = 0;
    for (const item of res.ranked) {
      if (sent >= cfg.maxAlertsPerScan) break;
      if (item.result.total < cfg.minAlertScore) break; // classement trié : les suivants sont plus bas
      const key = `${item.token.chain}:${item.token.address}`;
      if (!store.canAlert(key, cfg.alertCooldownHours)) continue;
      try {
        await send(tokenMessage(item, { title: '🚨 Nouveau meme coin détecté' }) + extra(item), item.token.imageUrl);
        store.markAlerted(key, { score: Math.round(item.result.total), marketCap: item.token.marketCap });
        onSent(item);
        sent++;
      } catch (err) {
        console.error(`[canal] envoi impossible pour ${item.token.symbol} : ${explainTelegramError(err)}`);
        if (err?.error_code === 401 || err?.error_code === 400 || err?.error_code === 403) throw err;
      }
    }
    return sent;
  }

  /** Publie le résumé du top 10. */
  async function postTop(res) {
    if (!cfg.channelId) return;
    await api.sendMessage(cfg.channelId, topMessage(res.ranked, res, cfg, 10, { channel: true }), HTML);
    store.setMeta('lastTopSummaryAt', Date.now());
  }

  /** Le résumé du top est-il dû (selon TOP_SUMMARY_HOURS) ? */
  function topSummaryDue() {
    if (!cfg.channelId || cfg.topSummaryHours <= 0) return false;
    const last = store.getMeta('lastTopSummaryAt') || 0;
    return Date.now() - last >= cfg.topSummaryHours * 3_600_000;
  }

  /** Vérifie que le bot peut publier sur le canal. */
  async function check() {
    if (!cfg.channelId) {
      console.warn('⚠️  TELEGRAM_CHANNEL_ID non défini : aucune publication sur canal.');
      return false;
    }
    try {
      const chat = await api.getChat(cfg.channelId);
      const me = await api.getMe();
      const member = await api.getChatMember(chat.id, me.id);
      const isGroup = chat.type === 'group' || chat.type === 'supergroup';
      const canPost =
        member.status === 'creator' ||
        (member.status === 'administrator' && (isGroup || member.can_post_messages !== false)) ||
        (isGroup && member.status === 'member') ||
        (isGroup && member.status === 'restricted' && member.can_send_messages);
      if (!canPost) {
        const where = isGroup ? 'du groupe' : 'du canal';
        console.error(
          `❌ Le bot ne peut pas publier dans « ${chat.title} » (type : ${chat.type}, statut du bot : ${member.status}). ` +
            `Ajoute-le comme ADMINISTRATEUR ${where} avec le droit « Publier des messages ».`,
        );
        return false;
      }
      console.log(`✅ Canal « ${chat.title} » (${chat.id}) : publication autorisée.`);
      return true;
    } catch (err) {
      console.error(`❌ Canal inaccessible : ${explainTelegramError(err)}`);
      return false;
    }
  }

  /** Message texte simple sur le canal. */
  const sendText = (text) => api.sendMessage(cfg.channelId, text, HTML);

  return { send, sendText, postAlerts, postTop, topSummaryDue, check };
}

module.exports = { createChannel, explainTelegramError, HTML };
