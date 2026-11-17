/**
 * Publication sur le canal / groupe Telegram (partagé entre bot.js et once.js).
 */
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
  /** Message HTML sur le canal (ignoré si aucun canal n'est configuré). */
  async function sendText(text) {
    if (!cfg.channelId) return null;
    return api.sendMessage(cfg.channelId, text, HTML);
  }

  /** Le bilan périodique est-il dû (selon SUMMARY_HOURS) ? */
  function summaryDue() {
    if (!cfg.channelId || cfg.summaryHours <= 0) return false;
    const last = store.getMeta('lastSummaryAt') || 0;
    return Date.now() - last >= cfg.summaryHours * 3_600_000;
  }

  function markSummary() {
    store.setMeta('lastSummaryAt', Date.now());
  }

  /** Image PNG (Buffer) avec légende HTML. */
  async function sendPhoto(png, caption) {
    if (!cfg.channelId) return null;
    const { InputFile } = require('grammy');
    return api.sendPhoto(cfg.channelId, new InputFile(png, 'portefeuille.png'), { caption, parse_mode: 'HTML' });
  }

  /** Le graphique du portefeuille est-il dû (selon CHART_HOURS) ? */
  function chartDue() {
    if (!cfg.channelId || cfg.chartHours <= 0) return false;
    return Date.now() - (store.getMeta('lastChartAt') || 0) >= cfg.chartHours * 3_600_000;
  }

  function markChart() {
    store.setMeta('lastChartAt', Date.now());
  }

  /** Vérifie que le bot peut publier sur le canal / groupe. */
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

  return { sendText, sendPhoto, summaryDue, markSummary, chartDue, markChart, check };
}

module.exports = { createChannel, explainTelegramError, HTML };
