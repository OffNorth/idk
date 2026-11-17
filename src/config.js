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
  'season,sma200,mom12,tsmom,high52,macd@1d,hold',
  'mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,hold',
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
  goldStrategies: list('GOLD_STRATEGIES', 'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,hold'),

  // Financement de nuit annuel (%) — 0 pour le PAXG (pas de levier)
  goldFinancingPct: num('GOLD_FINANCING_PCT', 0),

  // Paper trading du Nasdaq 100 (indice ^NDX, Yahoo Finance) — CFD NAS100 simulé
  nasEnabled: num('NAS_TRADING', 1) === 1,
  // Retenues par le banc d'essai (npm run research -- nas100), en version achat seul + référence
  nasStrategies: list('NAS_STRATEGIES', 'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,hold'),
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

  // Mini-app de suivi (page web servie par le bot, commande /app)
  webEnabled: num('WEB_APP', 1) === 1,
  // Port : WEB_PORT, sinon le port attribué par l'hébergeur (SERVER_PORT sur Bot-Hosting / Pterodactyl, PORT ailleurs)
  webPort: num('WEB_PORT', num('SERVER_PORT', num('PORT', 8080))),
  // Adresse publique de l'app (ex. http://1.2.3.4:25565 ou https://…) ; vide = devinée (IP publique + port)
  webUrl: (process.env.WEB_URL || '').replace(/\/+$/, ''),
  // Clé facultative exigée par l'API (?k=…) ; le lien envoyé par /app la contient
  webToken: process.env.WEB_TOKEN || '',
  // 1 = lien HTTPS gratuit via un tunnel Cloudflare (nécessaire pour l'ouvrir DANS Telegram)
  webTunnel: num('WEB_TUNNEL', 0) === 1,

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};
