/**
 * Sauvegarde quotidienne des données du bot (comptes simulés, trades, archives, apprentissage de l'IA, jeu) vers la
 * fonction Supabase « bot » (actions backup_put / backup_get), compressée (gzip + base64). Données privées : lecture
 * et écriture avec une clé dérivée du token Telegram du bot (HMAC), qui reste dans le .env même si le serveur perd
 * ses données ; seule son empreinte est enregistrée côté serveur. La sauvegarde précédente est gardée.
 * Au démarrage, si le dossier de données est vide (serveur réinitialisé), le bot restaure tout seul la dernière
 * sauvegarde (BACKUP_RESTORE=1). /backup (admin) : sauvegarde tout de suite ; npm run restore : restauration à la main.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const URL_DEFAULT = 'https://glvxxxoxcxsxdnbofgqf.supabase.co/functions/v1/bot';
const EXCLUDE = new Set(['bot-push-key.json', 'time-machine.json']); // clé du site (secret) ; cache recalculé
const MAX_FILE = 3_000_000;
const DAY_MS = 24 * 3600_000;
const urlOf = (cfg) => cfg.backupUrl || cfg.livePushUrl || URL_DEFAULT;

/** Clé de la sauvegarde, dérivée du token du bot (jamais envoyée telle quelle ailleurs que dans l'en-tête). */
function keyOf(cfg) {
  if (!cfg.telegramToken) return null;
  return crypto.createHmac('sha256', cfg.telegramToken).update('marches-bot-backup-v1').digest('base64url');
}

/** Fichiers de données à sauvegarder : { nom: texte }. */
function collect(dir) {
  const files = {};
  let bytes = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json') || EXCLUDE.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_FILE) continue;
    files[name] = fs.readFileSync(p, 'utf8');
    bytes += st.size;
  }
  return { files, bytes };
}

const pack = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8')).toString('base64');
const unpack = (b64) => JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));

/** Envoie une sauvegarde (au plus une par jour, sauf force). Retourne { ok, files, bytes } ou { skipped } ; ne lève pas. */
async function pushBackup(cfg, store, { force = false, now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  try {
    if (cfg.backup === false || !fetchImpl) return { skipped: 'off' };
    const key = keyOf(cfg);
    if (!key) return { skipped: 'no token' };
    const last = store.getMeta('lastBackup') || 0;
    if (!force && now - last < DAY_MS) return { skipped: 'recent' };
    const { files, bytes } = collect(cfg.dataDir);
    if (!Object.keys(files).length) return { skipped: 'no data' };
    const version = require('./version').version();
    const data = pack({ v: 1, at: now, version, files });
    const res = await fetchImpl(`${urlOf(cfg)}?action=backup_put`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-backup-key': key },
      body: JSON.stringify({ data, files: Object.keys(files).length, bytes, version }), signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    store.setMeta('lastBackup', now);
    store.setMeta('lastBackupInfo', { at: now, files: Object.keys(files).length, bytes, packed: data.length, error: null });
    return { ok: true, files: Object.keys(files).length, bytes, packed: data.length };
  } catch (err) {
    try { store.setMeta('lastBackupInfo', { ...(store.getMeta('lastBackupInfo') || {}), error: err.message, errorAt: now }); } catch { /* rien */ }
    console.warn('[sauvegarde] échec :', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Restaure la sauvegarde dans le dossier de données. Par défaut seulement les fichiers absents (force : tout).
 * Retourne { ok, restored, at, version } ou { ok: false, error }.
 */
async function restoreBackup(cfg, { which = 'daily', force = false, fetchImpl = globalThis.fetch } = {}) {
  try {
    const key = keyOf(cfg);
    if (!key) return { ok: false, error: 'TELEGRAM_BOT_TOKEN missing' };
    const res = await fetchImpl(`${urlOf(cfg)}?action=backup_get${which === 'previous' ? '&which=previous' : ''}`, {
      method: 'POST', headers: { 'x-backup-key': key }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const row = await res.json();
    if (!row?.data) return { ok: false, error: 'no backup yet' };
    const b = unpack(row.data);
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    let restored = 0;
    for (const [name, text] of Object.entries(b.files || {})) {
      if (!/^[\w.-]+\.json$/.test(name) || EXCLUDE.has(name)) continue; // jamais de chemin, jamais la clé du site
      const p = path.join(cfg.dataDir, name);
      if (!force && fs.existsSync(p)) continue;
      fs.writeFileSync(p, text);
      restored++;
    }
    return { ok: true, restored, at: b.at, version: b.version };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Dossier de données vide (serveur réinitialisé) : aucun compte simulé enregistré. */
const looksEmpty = (cfg) => !['ftmo.json', 'lucid.json', 'gold.json'].some((f) => fs.existsSync(path.join(cfg.dataDir, f)));

module.exports = { pushBackup, restoreBackup, looksEmpty, keyOf, collect, pack, unpack };
