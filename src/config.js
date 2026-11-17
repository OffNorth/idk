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
  // Capital de départ de chaque stratégie ; chaque trade mise GOLD_POSITION_PCT % du capital du moment
  // (les gains sont réinvestis). GOLD_SIZE_USD reste accepté pour compatibilité.
  goldStartCapital: num('GOLD_START_CAPITAL', num('GOLD_SIZE_USD', 1000)),
  goldPositionPct: num('GOLD_POSITION_PCT', 100),
  get goldSizeUsd() {
    return this.goldStartCapital;
  },
  goldFeePct: num('GOLD_FEE_PCT', 0.05),
  // Par défaut : les combinaisons retenues par le banc d'essai (npm run research) + la référence
  goldStrategies: list('GOLD_STRATEGIES', 'macd@1d,vote,dollar,tsmom,sma1060@1d,ema@1d,fibo@6h,hold'),

  // Financement de nuit annuel (%) — 0 pour le PAXG (pas de levier)
  goldFinancingPct: num('GOLD_FINANCING_PCT', 0),

  // Paper trading du Nasdaq 100 (indice ^NDX, Yahoo Finance) — CFD NAS100 simulé
  nasEnabled: num('NAS_TRADING', 1) === 1,
  // Retenues par le banc d'essai (npm run research -- nas100), en version achat seul + référence
  nasStrategies: list('NAS_STRATEGIES', 'sma200,vixcalm,macd_long,tsmom,rsi2,double7,tom,hold'),
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

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};
