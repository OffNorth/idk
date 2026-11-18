require('dotenv').config();
const path = require('path');

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} doit être un nombre (reçu "${raw}")`);
  return v;
}

// Anciennes listes par défaut (copiées depuis .env.example) : remplacées par la sélection actuelle
const OLD_DEFAULTS = [
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,hold',
  'gold:x_rsi2',
  'season,sma200,mom12,tsmom,high52,macd@1d,hold',
  'mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,hold',
  'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,hold',
  'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,hold',
];

function list(name, def) {
  const raw = (process.env[name] || '').replace(/\s+/g, '');
  const src = raw === '' || OLD_DEFAULTS.includes(raw) ? def : raw;
  return src.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  channelId: process.env.TELEGRAM_CHANNEL_ID || '',
  allowedUserIds: new Set(list('ALLOWED_TELEGRAM_USER_IDS', '')),

  // Paper trading de l'or (PAXG/USD) — simulation, aucun argent réel
  goldEnabled: num('GOLD_TRADING', 1) === 1,
  // Capital de départ de chaque stratégie ; chaque trade mise GOLD_POSITION_PCT % du capital du moment
  // (les gains sont réinvestis). GOLD_SIZE_USD reste accepté pour compatibilité.
  goldStartCapital: num('GOLD_START_CAPITAL', num('GOLD_SIZE_USD', 1000)),
  goldPositionPct: num('GOLD_POSITION_PCT', 100),
  get goldSizeUsd() {
    return this.goldStartCapital;
  },
  goldFeePct: num('GOLD_FEE_PCT', 0.05),
  // Par défaut : les combinaisons retenues par le banc d'essai (npm run research) + la référence
  // Retenues par le banc d'essai sur 25 ans d'or (npm run research -- goldlong) + référence
  goldStrategies: list('GOLD_STRATEGIES', 'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,hold'),

  // Financement de nuit annuel (%) — 0 pour le PAXG (pas de levier)
  goldFinancingPct: num('GOLD_FINANCING_PCT', 0),

  // Paper trading du Nasdaq 100 (indice ^NDX, Yahoo Finance) — CFD NAS100 simulé
  nasEnabled: num('NAS_TRADING', 1) === 1,
  // Retenues par le banc d'essai (npm run research -- nas100), en version achat seul + référence
  nasStrategies: list('NAS_STRATEGIES', 'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,hold'),
  nasStartCapital: num('NAS_START_CAPITAL', num('GOLD_START_CAPITAL', num('GOLD_SIZE_USD', 1000))),
  nasPositionPct: num('NAS_POSITION_PCT', 100),
  nasFeePct: num('NAS_FEE_PCT', 0.01),
  // Coût de financement d'un CFD gardé la nuit (%/an), appliqué au prorata des jours en position
  nasFinancingPct: num('NAS_FINANCING_PCT', 6),

  // Fréquence des passages (minutes) et du bilan publié sur le canal (heures, 0 = jamais)
  checkIntervalMin: num('CHECK_INTERVAL_MINUTES', 3),
  summaryHours: num('SUMMARY_HOURS', 4),
  // Graphique du portefeuille publié sur le canal toutes les X heures (0 = jamais)
  chartHours: num('CHART_HOURS', 24),

  // Compte FTMO simulé : suit les trades des stratégies listées (marché:id) avec une taille au risque
  ftmoEnabled: num('FTMO', 1) === 1,
  ftmoStrategies: list('FTMO_STRATEGIES', 'gold:x_rsi2,gold:m_bb@5m,gold:m_ibs,gold:m_rsi2x'),
  ftmoCapital: num('FTMO_CAPITAL', 100000),
  ftmoRisk: num('FTMO_RISK_PCT', 0.5), // % du solde risqué par trade (distance au stop)
  ftmoLeverage: num('FTMO_LEVERAGE', 30),
  ftmoDayStop: num('FTMO_DAY_STOP_PCT', 2), // plus de nouveau trade dans la journée après −2 % (0 = jamais)
  ftmoFeeGold: num('FTMO_FEE_GOLD_PCT', 0.005),
  ftmoFeeNas: num('FTMO_FEE_NAS_PCT', 0.003),

  // Jeu du groupe « Pronostic du jour » : hausse ou baisse, chaque jour de semaine à GAME_HOUR_UTC
  gameEnabled: num('GAME', 1) === 1,
  gameHourUtc: Math.min(23, Math.max(0, num('GAME_HOUR_UTC', 13))),
  gameVoteHours: Math.max(0.5, num('GAME_VOTE_HOURS', 3)),

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};
