/**
 * Publication sur le canal / groupe Telegram (partagé entre bot.js et once.js).
 */
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };

function explainTelegramError(err) {
  const d = err?.description || err?.message || String(err);
  if (/upgraded to a supergroup/i.test(d)) return `${d} → le groupe est devenu un « supergroupe » : son ID a changé (nouvel ID : ${err?.parameters?.migrate_to_chat_id ?? '?'}) ; mets-le dans TELEGRAM_CHANNEL_ID.`;
  if (/can't parse entities/i.test(d)) return `${d} → message mal formé (HTML) : signale-le pour correction.`;
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
function createChannel(api, cfg, store, { onError = null, dm = null } = {}) {
  // Groupe devenu supergroupe (nouvel ID) : l'ID mémorisé remplace celui du .env tant que celui-ci n'a pas changé
  const moved = store.getMeta('channelMoved');
  if (moved && String(cfg.channelId) === String(moved.from)) cfg.channelId = String(moved.to);

  /**
   * Envoi sur le groupe avec suivi : dernier envoi réussi / dernière erreur (affichés par /version et /testcanal),
   * nouvel essai automatique si le groupe est devenu un supergroupe, alerte (onError) en cas d'échec.
   */
  async function deliver(send) {
    try {
      const out = await send(cfg.channelId);
      store.setMeta('channelLastError', null);
      store.setMeta('channelLastOk', Date.now());
      return out;
    } catch (err) {
      const to = err?.parameters?.migrate_to_chat_id;
      if (to) {
        store.setMeta('channelMoved', { from: String(cfg.channelId), to: String(to) });
        console.warn(`[canal] groupe devenu supergroupe : ${cfg.channelId} → ${to} (mets ${to} dans TELEGRAM_CHANNEL_ID)`);
        cfg.channelId = String(to);
        const out = await send(cfg.channelId);
        store.setMeta('channelLastOk', Date.now());
        return out;
      }
      store.setMeta('channelLastError', { at: Date.now(), text: explainTelegramError(err) });
      if (onError) Promise.resolve(onError(err)).catch(() => {});
      throw err;
    }
  }

  /**
   * Message HTML sur le canal. opts.dm (messages de trade) : copie en privé aux admins (fonction `dm`) si le groupe
   * ne le reçoit pas (pas de canal, erreur) — ou toujours avec TRADE_DM=always.
   */
  async function sendText(text, extra = {}, opts = {}) {
    return withCopy(opts, () => api.sendMessage(cfg.channelId, text, { ...HTML, ...extra }), () => dm({ text, extra }));
  }

  async function withCopy(opts, toGroup, toDm) {
    const copy = opts.dm && dm && cfg.tradeDm !== 'off';
    if (!cfg.channelId) {
      store.setMeta('channelSkipped', (store.getMeta('channelSkipped') || 0) + 1);
      if (copy) await toDm().catch(() => {});
      return null;
    }
    try {
      const out = await deliver(() => toGroup());
      if (copy && cfg.tradeDm === 'always') await toDm().catch(() => {});
      return out;
    } catch (err) {
      if (copy) await toDm().catch(() => {});
      throw err;
    }
  }

  /** État des envois au groupe (objet, pour le diagnostic envoyé au site). */
  function diag() {
    const id = String(cfg.channelId || '');
    return {
      set: !!id, id: id ? `${id.slice(0, 4)}…${id.slice(-3)}` : null, lastOk: store.getMeta('channelLastOk') || null,
      lastError: store.getMeta('channelLastError') || null, skipped: store.getMeta('channelSkipped') || 0, moved: !!store.getMeta('channelMoved'),
    };
  }

  /** État des envois au groupe (une ligne, pour /version et /testcanal). */
  function status() {
    if (!cfg.channelId) return '📬 Groupe : TELEGRAM_CHANNEL_ID non défini → aucun message envoyé';
    const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} j`; };
    const ok = store.getMeta('channelLastOk');
    const bad = store.getMeta('channelLastError');
    return `📬 Groupe ${cfg.channelId} : ${ok ? `dernier envoi réussi il y a ${ago(ok)}` : 'aucun envoi réussi enregistré'}${bad && (!ok || bad.at > ok) ? ` · ❌ dernière erreur il y a ${ago(bad.at)} : ${bad.text}` : ''}`;
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

  /** Image PNG (Buffer) avec légende HTML (extra : boutons…). */
  async function sendPhoto(png, caption, extra = {}, opts = {}) {
    const { InputFile } = require('grammy');
    return withCopy(opts, () => api.sendPhoto(cfg.channelId, new InputFile(png, 'image.png'), { caption, parse_mode: 'HTML', ...extra }), () => dm({ png, caption, extra }));
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

  return { sendText, sendPhoto, summaryDue, markSummary, chartDue, markChart, check, status, diag };
}

module.exports = { createChannel, explainTelegramError, HTML };
