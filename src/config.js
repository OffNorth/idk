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
  'gold:down3,gold:pctb,gold:ema_long,gold:g_yieldfall,eurusd:ibs,spx:down3,spx:n_goldfall',
  'nas100:rsi2,nas100:ibs,nas100:down3,nas100:dip5,nas100:n_low10,nas100:n_drop,nas100:n_2down,nas100:n_dollarfall,nas100:rates,nas100:g_yieldfall',
  'nas100:n_noise,eurusd:ibs,gold:g_orb30',
  'gold:down3,gold:pctb,gold:ema_long,gold:g_yieldfall,eurusd:ibs',
  'nas100:n_noise,eurusd:ibs',
  'gold:x_rsi2,gold:m_bb@5m,gold:m_ibs,gold:m_rsi2x,gold:m_keltner@5m,gold:g_asia,gold:m_down3',
  'nas100:ibs,nas100:cumrsi,nas100:n_dollarfall,nas100:tom,nas100:ema_long,nas100:rsi2,nas100:n_low10,nas100:n_rsi4,nas100:vixspike',
  'nas100:n_noise',
  'gold:x_rsi2,gold:m_bb@5m,gold:m_ibs,gold:m_rsi2x,gold:m_keltner@5m',
  'golden,mom12_1,trendmix,mom12,sma200,lowvol,rates,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,n_rsi4,tom,rsi2,ibs,double7,down3,vixspike,vixcalm,halloween,cumrsi,dip5,dualmom,macro,sox,macd_long,ema_long,x_orb5,x_lasthalf,m_down3,m_vwap,n_overnight,n_preholiday,n_opex,n_yieldfall,sweep,hold',
  'nas100:n_weekrev,nas100:n_low10,nas100:n_drop,nas100:n_dollarfall,nas100:n_rsspx,nas100:n_2down,nas100:n_goldfall,nas100:n_rsi4,nas100:tom',
  'golden,mom12_1,trendmix,mom12,sma200,lowvol,rates,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,n_rsi4,tom,hold',
  'season,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,m_wr@5m,m_keltner@5m,g_ibsh@5m,g_weekrev,g_low10,g_yieldfall,g_asia,g_oilfall,hold',
  'season,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,m_wr@5m,m_keltner@5m,g_weekrev,g_low10,g_yieldfall,g_asia,hold',
  'nas100:n_weekrev,nas100:n_low10,nas100:n_drop,nas100:n_dollarfall,nas100:n_rsspx,nas100:n_2down,nas100:n_goldfall',
  'golden,mom12_1,trendmix,mom12,sma200,lowvol,rates,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,hold',
  'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,m_wr@5m,m_keltner@5m,g_weekrev,g_low10,g_yieldfall,g_silverlead,g_asia,hold',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight,nas100:n_weekrev,nas100:n_low10,nas100:n_drop,nas100:n_dollarfall,nas100:n_rsspx,nas100:n_2down,nas100:n_goldfall',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_preholiday,n_weekrev,n_opex,n_low10,n_drop,n_yieldfall,n_dollarfall,n_rsspx,n_2down,n_goldfall,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight,nas100:n_weekrev,nas100:n_opex,nas100:n_low10,nas100:n_drop,nas100:n_yieldfall,nas100:n_dollarfall,nas100:n_rsspx,nas100:n_2down,nas100:n_goldfall',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_preholiday,n_weekrev,n_opex,n_low10,n_drop,n_yieldfall,n_dollarfall,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight,nas100:n_weekrev,nas100:n_opex,nas100:n_low10,nas100:n_drop,nas100:n_yieldfall,nas100:n_dollarfall',
  'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,m_wr@5m,m_keltner@5m,hold',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_preholiday,n_weekrev,n_opex,n_low10,n_drop,n_yieldfall,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight,nas100:n_weekrev,nas100:n_opex,nas100:n_low10,nas100:n_drop,nas100:n_yieldfall',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_preholiday,n_weekrev,n_opex,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight,nas100:n_weekrev,nas100:n_opex',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,n_overnight,n_preholiday,hold',
  'nas100:m_down3,nas100:x_lasthalf,nas100:x_orb5,nas100:sweep,nas100:n_overnight',
  'golden,mom12_1,macro,trendmix,mom12,sma200,lowvol,vixcalm,halloween,rates,tsmom,macd_long,sweep,m_down3,x_lasthalf,x_orb5,hold',
  'season,seasonplus,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,hold',
  'gold:x_rsi2,gold:m_bb@5m,gold:m_ibs,gold:m_rsi2x',
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

// Formule du challenge FTMO : 1step (défaut), 2step, swing — voir PROGRAMS dans src/ftmoAccount.js (npm run ftmo-formulas).
// Les risques par défaut en dépendent (1 étape : perte du jour limitée à 3 %, donc moins de risque).
const FTMO_PROGRAM = process.env.FTMO_PROGRAM || '1step';
const ONE = FTMO_PROGRAM === '1step';
/** Réglage dont l'ancienne valeur par défaut (copiée de .env.example) suit désormais la formule du challenge. */
const upgraded = (name, oldDefault, def) => ([].concat(oldDefault).includes((process.env[name] || '').trim()) ? def : num(name, def));

module.exports = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  channelId: process.env.TELEGRAM_CHANNEL_ID || '',
  allowedUserIds: new Set(list('ALLOWED_TELEGRAM_USER_IDS', '')),
  // Copie en privé des messages de trade (achat, vente, réussite, échec, retrait) : « fallback » (défaut) = seulement
  // quand le groupe ne les reçoit pas (pas de TELEGRAM_CHANNEL_ID, erreur Telegram) ; « always » = toujours ; « off »
  tradeDm: ['always', 'off'].includes((process.env.TRADE_DM || '').trim()) ? process.env.TRADE_DM.trim() : 'fallback',

  // Paper trading de l'or (PAXG/USD) — simulation, aucun argent réel
  goldEnabled: num('GOLD_TRADING', 1) === 1,
  // Capital de départ de chaque stratégie ; chaque trade mise GOLD_POSITION_PCT % du capital du moment
  // (les gains sont réinvestis). GOLD_SIZE_USD reste accepté pour compatibilité.
  goldStartCapital: num('GOLD_START_CAPITAL', num('GOLD_SIZE_USD', 1000)),
  goldPositionPct: num('GOLD_POSITION_PCT', 100),
  get goldSizeUsd() {
    return this.goldStartCapital;
  },
  // Source des cours de l'or : future (GC=F Yahoo, comme l'or au comptant d'un compte FTMO, défaut) ou paxg (ancien)
  goldFeed: process.env.GOLD_FEED || 'future',
  // Bougies intraday (1 / 5 / 15 min) en temps réel via OANDA (compte démo gratuit) : OANDA_TOKEN dans le .env ;
  // sans jeton, Yahoo (or GC=F retardé d'environ 10 min). INTRADAY_FEED=yahoo pour forcer Yahoo.
  oandaToken: (process.env.OANDA_TOKEN || '').trim(),
  oandaEnv: process.env.OANDA_ENV === 'live' ? 'live' : 'practice',
  intradayFeed: (process.env.INTRADAY_FEED || '').trim() === 'yahoo' ? 'yahoo' : 'auto',
  goldFeePct: num('GOLD_FEE_PCT', 0.05),
  goldScalpFeePct: num('GOLD_SCALP_FEE_PCT', 0.005), // stratégies 1 / 5 / 15 min (CFD)
  // Par défaut : les combinaisons retenues par le banc d'essai (npm run research) + la référence
  // Retenues par le banc d'essai sur 25 ans d'or (npm run research -- goldlong) + référence
  goldStrategies: list('GOLD_STRATEGIES', 'season,golden,trendmix,sma200,mom12_1,mom12,tsmom,high52,macd@1d,x_rsi2,m_bb@5m,m_ibs,m_rsi2x,m_wr@5m,m_keltner@5m,g_ibsh@5m,g_weekrev,g_low10,g_yieldfall,g_asia,g_asiabrk,g_oilfall,rsi2,ibs,double7,down3,vixspike,vixcalm,dualmom,season200,seasonplus,silver,macd_long,ema_long,x_orb5,x_lasthalf,m_down3,m_vwap,g_silverlead,hold'),

  // Financement de nuit annuel (%) — 0 pour le PAXG (pas de levier)
  goldFinancingPct: num('GOLD_FINANCING_PCT', 0),

  // Paper trading du Nasdaq 100 (indice ^NDX, Yahoo Finance) — CFD NAS100 simulé
  // EUR/USD (journalier, Yahoo EURUSD=X) — marché à l'essai (npm run ftmo-markets : ibs +68 % · +85 % · +84 %, 2003–2026)
  // S&P 500 (journalier, Yahoo ^GSPC ; CFD « US500 » chez FTMO) — stratégies choisies par npm run ftmo-real (EXTRA=1)
  spxEnabled: num('SPX_TRADING', 1) === 1,
  spxStrategies: list('SPX_STRATEGIES', 'rsi2,ibs,double7,down3,cumrsi,n_low10,hold'),
  spxStartCapital: num('SPX_START_CAPITAL', 1000),
  spxPositionPct: num('SPX_POSITION_PCT', 100),
  spxFeePct: num('SPX_FEE_PCT', 0.003),
  spxFinancingPct: num('SPX_FINANCING_PCT', 6),
  // Argent (future SI=F) et Dow Jones (^DJI) : marchés du compte Lucid (npm run markets-research, 25/11/2026), seulement
  // des stratégies intraday de la séance de New York (LUCID_INTRADAY_STRATEGIES) ; 0 = marché coupé
  silverEnabled: num('SILVER_TRADING', 1) === 1,
  silverStrategies: list('SILVER_STRATEGIES', 'n_wvb05_t075,hold'),
  silverStartCapital: num('SILVER_START_CAPITAL', 1000),
  silverFeePct: num('SILVER_FEE_PCT', 0.003),
  dowEnabled: num('DOW_TRADING', 1) === 1,
  dowStrategies: list('DOW_STRATEGIES', 'n_mom10_t1be,hold'),
  dowStartCapital: num('DOW_START_CAPITAL', 1000),
  dowFeePct: num('DOW_FEE_PCT', 0.003),
  // Russell 2000 (^RUT, micro M2K) : journalières du compte Lucid seulement
  russellEnabled: num('RUSSELL_TRADING', 1) === 1,
  russellStrategies: list('RUSSELL_STRATEGIES', 'n_low10,hold'),
  russellStartCapital: num('RUSSELL_START_CAPITAL', 1000),
  russellFeePct: num('RUSSELL_FEE_PCT', 0.003),
  // Actions / ETF du compte FTMO (src/stocks.js) : STOCKS_TRADING=0 pour les couper
  stocksEnabled: num('STOCKS_TRADING', 1) === 1,
  eurusdEnabled: num('EURUSD_TRADING', 1) === 1,
  eurusdStrategies: list('EURUSD_STRATEGIES', 'ibs,hold'),
  eurusdStartCapital: num('EURUSD_START_CAPITAL', 1000),
  eurusdPositionPct: num('EURUSD_POSITION_PCT', 100),
  eurusdFeePct: num('EURUSD_FEE_PCT', 0.002),
  eurusdFinancingPct: num('EURUSD_FINANCING_PCT', 3),
  nasEnabled: num('NAS_TRADING', 1) === 1,
  // Retenues par le banc d'essai (npm run research -- nas100), en version achat seul + référence
  nasStrategies: list('NAS_STRATEGIES', 'golden,mom12_1,trendmix,mom12,sma200,lowvol,rates,n_weekrev,n_low10,n_drop,n_dollarfall,n_rsspx,n_2down,n_goldfall,n_rsi4,tom,rsi2,ibs,double7,down3,vixspike,vixcalm,halloween,cumrsi,dip5,dualmom,macro,sox,macd_long,ema_long,x_orb5,x_lasthalf,m_down3,m_vwap,n_overnight,n_preholiday,n_opex,n_yieldfall,sweep,n_mom10,n_orb15,n_orb5s,hold'),
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

  // Trades de scalp (bougies 1 / 5 / 15 min) : 1 = un seul résumé par jour à DIGEST_HOUR_UTC, 0 = un message par trade
  // Le groupe ne voit QUE le compte FTMO (trades, réussite / échec, image du jour) ; les trades paper de chaque
  // stratégie sont toujours calculés et gardés (panneau, /historique, /verif) mais plus publiés. 0 = tout publier.
  publishFtmoOnly: num('PUBLISH_FTMO_ONLY', 1) === 1,
  tradeMessages: num('TRADE_MESSAGES', 1) === 1, // un message par trade (ouverture et clôture), en plus du résumé du jour
  scalpDigest: num('SCALP_DIGEST', 1) === 1,
  digestHourUtc: Math.min(23, Math.max(0, num('DIGEST_HOUR_UTC', 21))),
  // 1 = toutes les stratégies dans le résumé (aussi les journalières), 0 = seulement le scalp
  digestAll: num('DIGEST_ALL', 1) === 1,

  // Compte FTMO simulé : suit les trades des stratégies listées (marché:id) avec une taille au risque
  ftmoEnabled: num('FTMO', 1) === 1,
  // Or réel (npm run ftmo-real, XAU/USD 2009–2026) : les scalps choisis sur PAXG perdent sur l'or au comptant ; restent des
  // stratégies JOURNALIÈRES sur l'or (GC=F), le Nasdaq et l'EUR/USD (les « gold:… » de cette liste peuvent viser un autre marché)
  // + stratégies INTRADAY (≈ 5 trades par jour demandés) : momentum or sur l'or réel et Nasdaq, à FTMO_INTRADAY_RISK_PCT
  ftmoStrategies: list('FTMO_STRATEGIES', 'gold:down3,gold:pctb,gold:ema_long,gold:g_yieldfall,eurusd:ibs,spx:down3,spx:n_goldfall,gold:g_orb30,gold:g_orb60,gold:g_mom8,gold:g_gap,gold:g_asiabrk,gold:g_nypdl,spx:s_crabel7_30,tlt:n_crabel7_15,googl:n_crabel7_30,pltr:n_orb15,pltr:n_crabel7_15,pltr:n_wvb05,lly:n_orb5s,ba:n_crabel7_15'),
  // npm run lucid-tune : intraday 0,15 % + journalières 2 % → réussite < 1 an 64 % / 67 % / 83 % (2009–19 / 2020–26 / nov. 24–26)
  // contre 37 % / 46 % / 44 % avec 0,5 % + 1,5 % (l'intraday ajoute surtout de la variance : on le garde, en petit)
  ftmoIntradayRisk: upgraded('FTMO_INTRADAY_RISK_PCT', ['0.5'], 0.15),
  // Un message dans le groupe à chaque ouverture et clôture du compte FTMO simulé (0 = seulement réussite / échec)
  ftmoTradeMessages: num('FTMO_TRADE_MESSAGES', 1) === 1,
  // Stop suiveur du compte FTMO (npm run ftmo-tsl, 26/11/2026) : dès +2 R, stop à 1 R du meilleur cours (toutes les
  // stratégies) → réussite < 1 an 50 / 51 / 67 % → 55 / 57 / 73 % (2009–19 / 2020–26 / nov. 24–26), délai médian
  // un peu plus long (55 → 76 j récent). FTMO_TRAIL_ACT_R=0 pour le couper.
  ftmoTrailActR: num('FTMO_TRAIL_ACT_R', 2),
  ftmoTrailDistR: num('FTMO_TRAIL_DIST_R', 1),
  // Compte FTMO FINANCÉ : sorties partielles (npm run ftmo-partial, 26/11/2026) — ⅓ fermé à +1 R, ⅓ à +2 R, le reste au
  // stop suiveur : comptes perdus en 12 mois 95 → 87 %, retraits un peu plus élevés ; rien en évaluation (aucun gain).
  // Vide = désactivé.
  ftmoFundedPartials: list('FTMO_FUNDED_PARTIALS', '1,2'),
  // Le compte FTMO n'est jamais acheteur et vendeur du même marché en même temps (le 2e signal, opposé, est ignoré)
  ftmoNoHedge: num('FTMO_NO_HEDGE', 1) === 1,
  // 2e compte FTMO simulé, 100 % Nasdaq (npm run ftmo-nas-port)
  // Compte FTMO UNIQUE or + Nasdaq (par défaut) : or au risque FTMO_RISK_PCT, Nasdaq au risque FTMO_COMBO_NAS_RISK_PCT.
  // npm run ftmo-combo : 74 % de réussite en < 6 mois (récent 45 %) contre 74 % / 39 % pour l'or seul.
  ftmoCombined: num('FTMO_COMBINED', 1) === 1,
  ftmoComboNasRisk: upgraded('FTMO_COMBO_NAS_RISK_PCT', ['1', '0.5', '1.5'], 2),
  ftmoEurRisk: upgraded('FTMO_EUR_RISK_PCT', ['1.5'], 2),
  ftmoSpxRisk: upgraded('FTMO_SPX_RISK_PCT', ['1.5'], 2),
  ftmoNasEnabled: num('FTMO_NAS', 1) === 1,
  ftmoNasStrategies: list('FTMO_NAS_STRATEGIES', 'nas100:rsi2,nas100:ibs,nas100:down3,nas100:dip5,nas100:n_low10,nas100:n_drop,nas100:n_2down,nas100:n_dollarfall,nas100:rates,nas100:g_yieldfall,nas100:n_noise,nas100:n_orb5s,nas100:n_mom10,nas100:n_orb15'),
  ftmoNasRisk: process.env.FTMO_NAS_RISK_PCT === '0.5' ? 3 : num('FTMO_NAS_RISK_PCT', 3), // 0,5 = ancienne valeur par défaut, mise à jour ; // npm run ftmo-nas-port : 3 % → 42 % · 43 % · 39 % de challenges réussis
  ftmoCapital: num('FTMO_CAPITAL', 100000),
  // Compte Lucid simulé (LucidFlex, micro-futures) à côté du compte FTMO : mêmes signaux, règles Lucid (/lucid)
  lucidEnabled: num('LUCID', 1) === 1,
  lucidCapital: num('LUCID_CAPITAL', 50000), // 50000 ou 100000
  // npm run lucid-tune : Lucid sans intraday, journalières à 2,5 % → 62 % / 67 % / 73 % (contre 13 % / 11 % / 21 %)
  lucidRiskMul: upgraded('LUCID_RISK_MUL', ['1'], 1.25), // × le risque des journalières du compte FTMO (2 % → 2,5 %)
  // Intraday sur Lucid : seulement l'intraday Nasdaq (LUCID_INTRADAY_STRATEGIES) à LUCID_INTRADAY_RISK_PCT (0 = aucun).
  // Recherche (nov. 2026, 40 % de régularité) : Nasdaq noise + orb5s + mom10 à 0,2 % → 88 % de réussite < 1 an sur
  // nov. 24–26 (71 % sans) ; l'intraday or (cassures de Londres) fait chuter la réussite (perte max 2 000 $ trop serrée)
  // 0,45 % (24/11/2026, choix de l'utilisateur) : à 0,2 %, 1 micro MNQ dépassait presque toujours le risque prévu
  // (n_orb5s 237 $, n_mom10 507 $ pour 107 $ prévus) → Lucid ne tradait plus. Nov. 24–26 : 67 % de réussite < 1 an
  // (79 j médians) contre 88 % à 0,2 %.
  lucidIntradayRisk: upgraded('LUCID_INTRADAY_RISK_PCT', ['0.2'], 0.45),
  // Objectif « réussir en 2 semaines » (npm run twoweeks, 25/11/2026, choix de l'utilisateur : × 3) : PENDANT
  // L'ÉVALUATION, risque intraday Lucid × LUCID_EVAL_INTRADAY_MUL (0,45 → 1,35 %) ; retour à LUCID_INTRADAY_RISK_PCT une
  // fois le compte financé. Nov. 24–26 (départ chaque jour) : réussie en ≤ 14 j 1 % → 22 %, en ≤ 30 j 24 % → 38 %, mais
  // 48 % des évaluations échouent dans les 14 jours (≈ 2,3 évaluations achetées par compte financé, contre 1,1).
  // 1 = désactivé ; × 2 : 19 % en ≤ 14 j, 52 % en ≤ 30 j, 23 % d'échecs en 14 j (1,6 évaluation)
  lucidEvalIntradayMul: num('LUCID_EVAL_INTRADAY_MUL', 3),
  // Gestion de la journée Lucid PENDANT L'ÉVALUATION (npm run lucid-research5, 26/11/2026) : plus de nouveau trade quand le
  // gain du jour atteint 25 % de l'objectif (750 $ sur 3 000 $ : règle du meilleur jour ≤ 40 %) ou après 1 trade perdant
  // dans la journée. Nov. 24–26 : réussie en ≤ 14 j 20 → 25 %, en ≤ 30 j 34 → 42 %, échecs en ≤ 14 j 51 → 47 %,
  // 2,6 → 2,2 évaluations achetées par compte financé (0 = désactivé)
  lucidDayProfitCapPct: num('LUCID_DAY_PROFIT_CAP_PCT', 25),
  lucidMaxLossesDay: num('LUCID_MAX_LOSSES_DAY', 1),
  // Variantes « objectif 0,5 R » (npm run lucid-research, 24/11/2026) : 66 % de gagnants, ≤ 6 pertes de suite →
  // évaluation réussie 49 / 49 départs sur nov. 24–26 (contre 49 % avec les originales + n_pdlbrk). Pas d'intraday or
  // (1 micro MGC trop gros pour la perte max de 2 000 $), pas de n_pdlbrk (négative sur la séance seule).
  // 25/11/2026 (npm run speed, choix de l'utilisateur) : sans les variantes à faible avantage (n_noise_t05, n_orb5s_t05 :
  // < +0,03 R par trade) → évaluation ≈ 3 semaines plus rapide sur nov. 24–26 (71 j contre 90 j médians), réussite égale
  // + n_orb10l_t075, n_orb30l_t075, n_or60_t05 (npm run lucid-research2, 25/11/2026) : 3 trades intraday / jour au lieu
  // de 0,9, évaluation ≈ 55 j au lieu de 70 j, réussite 96 % (pire série 9 pertes)
  // + n_crabel4_t05 (Toby Crabel, npm run traders, 25/11/2026) : réussite 100 % en 50 j (contre 98 % en 54 j)
  // + n_crabel7_15_t075, n_wvb05_t075, n_wvb07_t05 (Crabel NR7, Williams 0,5 / 0,7, npm run traders, 25/11/2026) :
  // Lucid ≈ 2 semaines plus rapide (37 j au lieu de 50 j sur nov. 24–26), réussite 94 % au lieu de 100 % ; pas sur FTMO
  // (réussite récente 67 → 57 %)
  // + argent (silver:n_wvb05_t075, micro SIL) et Dow Jones (dow:n_mom10_t05, micro MYM) (npm run markets-research,
  // 25/11/2026) : réussite inchangée (55 / 72 / 94 % sur 2009–19 / 2020–26 / nov. 24–26), 34 j au lieu de 37 j ; pétrole,
  // Bitcoin, Russell et EUR/USD intraday font baisser Lucid, et chaque nouveau marché fait baisser FTMO
  lucidIntradayStrategies: list('LUCID_INTRADAY_STRATEGIES', 'nas100:n_mom10_t05,nas100:n_orb15_t05,nas100:n_orb10l_t075,nas100:n_orb30l_t075,nas100:n_or60_t05,nas100:n_crabel4_t05,nas100:n_crabel7_15_t075,nas100:n_wvb05_t075,nas100:n_wvb07_t05,silver:n_wvb05_t075,dow:n_mom10_t1be,spx:n_mom10_t1be'),
  // + spx:n_mom10_t1be (micro MES, npm run lucid-research6, 26/11/2026) : nov. 24–26 51 → 53 %, ≤ 30 j 42 → 43 %, rien ne baisse
  // Journalières propres au compte Lucid (npm run lucid-research4, 25/11/2026) : Double 7 et RSI 2 sur le S&P 500
  // (micro MES), au risque des journalières Lucid ; avec le Dow en break-even (dow:n_mom10_t1be, objectif 1 R) : réussite
  // 56 / 76 / 100 % (74 / 85 / 37 j) contre 55 / 72 / 94 % (85 / 110 / 34 j) sur 2009–19 / 2020–26 / nov. 24–26
  // 26/11/2026 : Lucid n'a pas de micro-devises (M6E) → l'IBS EUR/USD (gros contributeur) ne passe plus en 6E standard
  // (137 000 $ le contrat) : réussite réelle 45 / 46 / 76 %. Remplacée par 3 journalières sur des micros Lucid (npm run
  // lucid-research4) : plus bas de 10 j sur le Russell (M2K), Double 7 Nasdaq (MNQ) et argent (SIL) → 50 / 62 / 78 %
  lucidDailyStrategies: list('LUCID_DAILY_STRATEGIES', 'spx:double7,spx:rsi2,russell:n_low10,nas100:double7,silver:double7'),
  // Stratégies du compte FTMO que Lucid ne prend pas (avantage < +0,03 R)
  lucidExclude: list('LUCID_EXCLUDE', 'nas100:ibs'),
  // Multiplicateur du risque du compte FTMO (pas de Lucid) : 1,25 = challenge ≈ 2–3 semaines plus rapide (npm run speed),
  // réussite < 1 an 50 / 51 / 65 % contre 56 / 47 / 69 % (2009–19 / 2020–26 / nov. 24–26)
  ftmoRiskMul: num('FTMO_RISK_MUL', 1.25),
  // Règle de régularité de l'évaluation LucidFlex : meilleur jour ≤ 40 % du gain (40 % depuis le 19/10/2026, 50 % en option payante)
  lucidConsistency: num('LUCID_CONSISTENCY_PCT', 40),
  // Retraits LucidFlex (compte financé) : après 5 jours gagnants ≥ LUCID_PAYOUT_MIN_DAY $, ≤ 50 % du gain, 2 000 $ (50K) /
  // 3 000 $ (100K) au plus, 500 $ au moins ; partage 90 %
  lucidPayoutMinDay: num('LUCID_PAYOUT_MIN_DAY', 150),
  // Délai entre le signal et l'exécution sur les comptes FTMO / Lucid (comme un vrai ordre) : l'entrée et les sorties sur
  // signal se font au cours FILL_DELAY_SEC secondes plus tard ; stops et objectifs (ordres posés à l'avance) restent au niveau
  // Time Machine (src/timeMachine.js) : chances du compte en cours dans /ftmo et /lucid (coupé pendant les tests)
  timeMachine: num('TIME_MACHINE', 1) === 1 && !process.env.NODE_TEST_CONTEXT,
  fillDelaySec: process.env.NODE_TEST_CONTEXT && !process.env.FILL_DELAY_SEC ? 0 : Math.max(0, num('FILL_DELAY_SEC', 30)),
  ftmoRisk: upgraded('FTMO_RISK_PCT', ['0.5', '0.35', '1.5'], 2), // % du solde risqué par trade (distance au stop)
  ftmoLeverage: num('FTMO_LEVERAGE', 30),
  // Levier dynamique (src/sizing.js) : « plusieurs positions → moins » = risque ÷ 2 dès 2 positions déjà ouvertes
  // (npm run ftmo-sizing : supprime les échecs sur la perte du jour, réussite égale) ; « fixe » = risque constant
  // « objectif : dégressif doux » (défaut) : en plus, risque × (1 − 0,75 × avance vers l'objectif), au moins × 0,4
  // (npm run ftmo-protect : réussite < 1 an 26 → 37 % sur 2009–2019, 30 → 46 % sur 2020–2026, au prix d'une durée plus longue)
  // Défaut (nov. 2026, demande de l'utilisateur) : « plusieurs positions → moins », sans réduction à l'approche de
  // l'objectif — challenges ≈ 1 mois plus rapides ; réussite FTMO 58 / 54 / 71 % contre 64 / 68 / 82 % avec le
  // dégressif doux, Lucid 57 / 71 / 100 % contre 63 / 66 / 71 % (FTMO_SIZING=objectif : dégressif doux pour le remettre)
  ftmoSizing: (process.env.FTMO_SIZING || '').trim() || 'plusieurs positions → moins',
  // IA validatrice (src/aiFilter.js, npm run ai-train) : block (défaut, refuse les signaux sous le seuil), observe
  // (avis seulement) ou off ; FTMO_AI_MIN : seuil de probabilité (défaut : celui du modèle, ≈ 20 % des signaux refusés)
  ftmoAi: ['observe', 'block', 'off'].includes((process.env.FTMO_AI || '').trim()) ? process.env.FTMO_AI.trim() : 'block',
  ftmoAiMin: process.env.FTMO_AI_MIN ? Number(process.env.FTMO_AI_MIN) : NaN,
  // Adaptation automatique (src/adapt.js) : revue chaque dimanche — IA ré-apprise sur les signaux live, poids des
  // stratégies selon leurs trades live, candidates suivies en paper et promues si elles font mieux
  // Catégorie « Bot » du site : état en direct envoyé à la fonction Supabase « bot » (désactivé pendant les tests)
  livePush: num('LIVE_PUSH', 1) === 1 && !process.env.NODE_TEST_CONTEXT,
  livePushUrl: process.env.LIVE_PUSH_URL || '',
  siteUrl: process.env.SITE_URL || 'https://marches-eight.vercel.app',
  autoAdapt: num('AUTO_ADAPT', 1) === 1,
  // Poids des stratégies et candidates : coupé par défaut (npm run adapt-sim : n'améliore pas la réussite sur 2015–2026)
  adaptStrategies: num('ADAPT_STRATEGIES', 0) === 1,
  adaptCandidates: list('ADAPT_CANDIDATES', 'gold:g_low10,gold:g_weekrev,gold:g_oilfall,nas100:n_weekrev,nas100:n_rsi4,nas100:n_rsspx,nas100:tom,spx:ibs,spx:rsi2'),
  ftmoProgram: FTMO_PROGRAM,
  ftmoDayStop: upgraded('FTMO_DAY_STOP_PCT', '2', ONE ? 1 : 2), // plus de nouveau trade dans la journée après −2 % (0 = jamais)
  ftmoFeeGold: num('FTMO_FEE_GOLD_PCT', 0.005),
  ftmoFeeNas: num('FTMO_FEE_NAS_PCT', 0.003),

  // Jeu du groupe « Pronostic du jour » : hausse ou baisse, chaque jour de semaine à GAME_HOUR_UTC
  gameEnabled: num('GAME', 1) === 1,
  gameHourUtc: Math.min(23, Math.max(0, num('GAME_HOUR_UTC', 13))),
  gameVoteHours: Math.max(0.5, num('GAME_VOTE_HOURS', 3)),

  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
};

// FTMO_ONLY=1 (par défaut) : le bot ne fait tourner QUE les stratégies des comptes FTMO simulés (or et Nasdaq),
// plus la référence « garder le marché » ; GOLD_STRATEGIES et NAS_STRATEGIES sont alors ignorées.
{
  const cfg = module.exports;
  cfg.ftmoOnly = num('FTMO_ONLY', 1) === 1;
  // Stratégies à l'essai : suivies en paper trading (et publiées) mais PAS par le compte FTMO
  // (n_noise et g_orb30, d'abord à l'essai, sont passées sur le compte FTMO avec les autres stratégies intraday)
  // (g_asiabrk et g_nypdl, d'abord à l'essai, sont passées sur le compte FTMO le 24/11/2026 ; n_pdlbrk retirée le 25/11 :
  // négative sur la séance seule de New York, comme en direct)
  cfg.trialStrategies = list('TRIAL_STRATEGIES', '');
  if (cfg.ftmoOnly) {
    const all = [...(cfg.ftmoEnabled ? cfg.ftmoStrategies : []), ...(cfg.ftmoEnabled && (cfg.ftmoNasEnabled || cfg.ftmoCombined) ? cfg.ftmoNasStrategies : []),
      ...(cfg.ftmoEnabled && cfg.lucidEnabled ? [...cfg.lucidIntradayStrategies, ...cfg.lucidDailyStrategies] : [])]; // stratégies propres au compte Lucid
    // + candidates de l'adaptation automatique (suivies en paper sans être publiées, promues si elles font mieux)
    const cand = cfg.autoAdapt && cfg.adaptStrategies ? cfg.adaptCandidates : [];
    const of = (m) => [...new Set([...all, ...cfg.trialStrategies, ...cand].filter((x) => x.startsWith(`${m}:`)).map((x) => x.slice(m.length + 1))), 'hold'];
    cfg.goldStrategies = of('gold');
    cfg.nasStrategies = of('nas100');
    cfg.eurusdStrategies = of('eurusd');
    cfg.spxStrategies = of('spx');
    cfg.silverStrategies = of('silver');
    cfg.dowStrategies = of('dow');
    cfg.russellStrategies = of('russell');
    // Actions / ETF (FTMO) : un marché par titre, ses stratégies prises dans FTMO_STRATEGIES
    for (const id of require('./stocks').STOCK_IDS) {
      cfg[`${id}Enabled`] = cfg.stocksEnabled; cfg[`${id}Strategies`] = of(id); cfg[`${id}StartCapital`] = 1000; cfg[`${id}FeePct`] = 0.005;
    }
  }
}
