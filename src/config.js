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
  topSummaryHours: num('TOP_SUMMARY_HOURS', 4),
  alertWithImage: num('ALERT_WITH_IMAGE', 1) === 1,
  minAlertScore: num('MIN_ALERT_SCORE', 65),
  maxAlertsPerScan: num('MAX_ALERTS_PER_SCAN', 3),
  alertCooldownHours: num('ALERT_COOLDOWN_HOURS', 12),
  watchHours: num('WATCH_HOURS', 48),

  // Paper trading des calls (simulation, aucun argent réel)
  paperEnabled: num('PAPER_TRADING', 1) === 1,
  paperSizeUsd: num('PAPER_SIZE_USD', 100),
  paperTpPct: num('PAPER_TP_PCT', 100),
  paperSlPct: num('PAPER_SL_PCT', 40),
  paperTrailStartPct: num('PAPER_TRAIL_START_PCT', 50),
  paperTrailPct: num('PAPER_TRAIL_PCT', 30),
  paperMaxHoldHours: num('PAPER_MAX_HOLD_HOURS', 48),
  paperFeePct: num('PAPER_FEE_PCT', 2),

  // Paper trading de l'or (PAXG ≈ 1 once d'or)
  goldEnabled: num('GOLD_TRADING', 1) === 1,
  goldSizeUsd: num('GOLD_SIZE_USD', 1000),
  goldAtrSl: num('GOLD_ATR_SL', 1.5),
  goldAtrTp: num('GOLD_ATR_TP', 3),
  goldFeePct: num('GOLD_FEE_PCT', 0.1),

  searchQueries: list('SEARCH_QUERIES', 'pump,meme,sol,dog,cat,ai'),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};

if (config.minMarketCap >= config.maxMarketCap) {
  throw new Error('MIN_MARKET_CAP doit être inférieur à MAX_MARKET_CAP');
}

module.exports = config;
