require('dotenv').config();
const path = require('path');

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} doit être un nombre (reçu "${raw}")`);
  return v;
}

function list(name, def) {
  const raw = process.env[name];
  const src = raw === undefined || raw === '' ? def : raw;
  return src.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  channelId: process.env.TELEGRAM_CHANNEL_ID || '',
  allowedUserIds: new Set(list('ALLOWED_TELEGRAM_USER_IDS', '')),

  // Paper trading de l'or (PAXG/USD) — simulation, aucun argent réel
  goldEnabled: num('GOLD_TRADING', 1) === 1,
  goldSizeUsd: num('GOLD_SIZE_USD', 1000),
  goldFeePct: num('GOLD_FEE_PCT', 0.05),
  goldStrategies: list('GOLD_STRATEGIES', 'all'),

  // Fréquence des passages (minutes) et du bilan publié sur le canal (heures, 0 = jamais)
  checkIntervalMin: num('CHECK_INTERVAL_MINUTES', 3),
  summaryHours: num('SUMMARY_HOURS', 4),

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};
