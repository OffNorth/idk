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
  const src = raw === undefined ? def : raw;
  return src.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  channelId: process.env.TELEGRAM_CHANNEL_ID || '',
  allowedUserIds: new Set(list('ALLOWED_TELEGRAM_USER_IDS', '')),

  minMarketCap: num('MIN_MARKET_CAP', 100_000),
  maxMarketCap: num('MAX_MARKET_CAP', 2_000_000),

  chains: list('CHAINS', 'solana').map((c) => c.toLowerCase()),
  minLiquidity: num('MIN_LIQUIDITY_USD', 15_000),
  minVolume24h: num('MIN_VOLUME_24H_USD', 30_000),
  minTxns24h: num('MIN_TXNS_24H', 150),
  minAgeHours: num('MIN_PAIR_AGE_HOURS', 1),
  maxAgeHours: num('MAX_PAIR_AGE_HOURS', 720),
  maxPriceChange24h: num('MAX_PRICE_CHANGE_24H', 1500),
  rugcheckEnabled: num('RUGCHECK_ENABLED', 1) === 1,
  rugcheckMaxScore: num('RUGCHECK_MAX_SCORE', 50),

  scanIntervalMin: num('SCAN_INTERVAL_MINUTES', 3),
  minAlertScore: num('MIN_ALERT_SCORE', 65),
  maxAlertsPerScan: num('MAX_ALERTS_PER_SCAN', 3),
  alertCooldownHours: num('ALERT_COOLDOWN_HOURS', 12),
  watchHours: num('WATCH_HOURS', 48),

  searchQueries: list('SEARCH_QUERIES', 'pump,meme,sol,dog,cat,ai'),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};

if (config.minMarketCap >= config.maxMarketCap) {
  throw new Error('MIN_MARKET_CAP doit être inférieur à MAX_MARKET_CAP');
}

module.exports = config;
