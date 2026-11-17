# 🥇 Gold Paper Bot

Bot Telegram qui **trade l'or en simulation** (paper trading) avec **5 stratégies en parallèle** et publie chaque
entrée, chaque sortie et un bilan régulier sur un canal Telegram.

> ⚠️ **Simulation uniquement.** Aucun ordre réel n'est passé, aucun compte de trading n'est utilisé.
> Ce n'est pas un conseil financier.

## Fonctionnement

```
Toutes les 3 minutes
  │
  ├─ Prix de l'or : PAXG/USD (1 PAXG = 1 once d'or) — Coinbase, secours Kraken (gratuit, sans clé)
  ├─ Stops / objectifs : vérifiés sur les bougies 5 min
  ├─ Signaux : chaque stratégie est évaluée à la clôture de chaque bougie 1 h
  │
  └─► Ouvertures / clôtures publiées sur le canal + bilan toutes les SUMMARY_HOURS
```

- Chaque stratégie a **son propre compte simulé** : `GOLD_SIZE_USD` (1 000 $ par défaut) par trade, long ou short.
- Frais / spread simulés : 0,05 % à l'entrée et à la sortie.
- Les positions sont gardées dans `data/gold.json` (elles survivent à un redémarrage).

## Les 5 stratégies

| Stratégie | Type | Entrée | Sortie |
|---|---|---|---|
| **Tendance EMA 20/50** (`ema`) | suivi de tendance | croisement EMA 20 / EMA 50 (filtre RSI) | SL 1,5 ATR · TP 3 ATR · croisement inverse |
| **Cassure Donchian 20** (`breakout`) | breakout | cassure du plus haut / plus bas des 20 dernières heures | stop suiveur 2,5 ATR · canal 10 h opposé |
| **Retour à la moyenne** (`meanrev`) | contre-tendance | sortie des bandes de Bollinger + RSI < 30 / > 70 | retour sur la moyenne 20 h · SL 1,5 ATR |
| **MACD + EMA 200** (`macd`) | momentum | croisement MACD / signal dans le sens de l'EMA 200 | SL 2 ATR · TP 4 ATR · croisement inverse |
| **Supertrend (10, 3)** (`supertrend`) | suivi de tendance | changement de direction du Supertrend | stop sur la ligne du Supertrend |

Pour n'en garder que certaines : `GOLD_STRATEGIES=ema,supertrend`.

## Résultats passés (backtest du 17/11/2026)

Sur **90 jours** (or de 4 485 $ à 3 862 $, soit −14 %), 1 000 $ par trade :

| Stratégie | Trades | Gagnants | PnL |
|---|---|---|---|
| Tendance EMA 20/50 | 39 | 26 % | −76 $ |
| Cassure Donchian 20 | 86 | 22 % | −97 $ |
| Retour à la moyenne | 66 | 39 % | −44 $ |
| MACD + EMA 200 | 73 | 27 % | −107 $ |
| Supertrend | 60 | 22 % | −135 $ |

Sur 180 jours, seul le Supertrend finit légèrement positif (+28 $). **Aucune stratégie n'a montré d'avantage fiable** :
le paper trading en direct sert à vérifier dans le temps. Pour refaire le test : `npm run backtest`
(90 jours), `npm run backtest -- 180`, ou `/backtest 180` dans Telegram.

## Commandes Telegram

| Commande | Rôle |
|---|---|
| `/gold` | Bilan de chaque stratégie (trades, % gagnants, PnL, position en cours) |
| `/strategies` | Description de chaque stratégie |
| `/backtest [jours]` | Backtest sur l'historique (90 jours par défaut, 365 max) |
| `/bilan` | Publie le bilan sur le canal maintenant |
| `/testcanal` | Message de test sur le canal |
| `/settings` | Paramètres actifs |
| `/pause` / `/resume` | Coupe / relance les publications (le paper trading continue) |

## Ce dont le bot a besoin

| Besoin | Pourquoi |
|---|---|
| Un hébergement allumé 24h/24 (ex : Bot-Hosting, serveur **Node.js**) | vérifier les stops toutes les 3 min |
| Node.js 20 ou plus | faire tourner le code |
| Token du bot (@BotFather) + canal / groupe Telegram où le bot peut publier | publier les trades |
| Accès internet à Coinbase / Kraken | prix de l'or (gratuit, sans clé) |
| ~100 Mo de RAM, quelques Mo de disque | mémoire des positions |

Pour trader un jour en **argent réel**, il faudrait en plus un compte chez un broker avec API pour l'or
(CFD XAU/USD, ou PAXG sur un exchange), des clés API, du capital et des limites de risque. Ce n'est pas branché.

## Installation

```bash
git clone https://github.com/OffNorth/idk.git && cd idk
npm install
cp .env.example .env   # renseigner TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID, ALLOWED_TELEGRAM_USER_IDS
npm start
```

Au démarrage, la console affiche `✅ Canal « … » : publication autorisée.` puis `Bot @… démarré.`

Sur **Bot-Hosting** : créer un serveur de type **Node.js** (pas Java), fichier de démarrage `bot.js`, créer `.env`
dans *Files*, puis *Restart*. Le serveur gratuit doit être renouvelé tous les 4 jours.

### Mode secours : GitHub Actions
`.github/workflows/scanner.yml` (« Paper trading or ») fait un passage toutes les 10 min sur les serveurs de GitHub,
sans les commandes Telegram. À n'activer **que si le bot ne tourne pas ailleurs**, sinon les trades sont publiés en
double. Secrets à créer : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`.

## Réglages (`.env`)

| Variable | Défaut | Rôle |
|---|---|---|
| `GOLD_SIZE_USD` | 1000 | Montant simulé par trade et par stratégie |
| `GOLD_FEE_PCT` | 0.05 | Frais / spread par côté (%) |
| `GOLD_STRATEGIES` | `all` | Stratégies actives |
| `CHECK_INTERVAL_MINUTES` | 3 | Fréquence de vérification |
| `SUMMARY_HOURS` | 4 | Bilan sur le canal (0 = jamais) |

## Structure

```
bot.js             Bot Telegram + passage toutes les CHECK_INTERVAL_MINUTES
once.js            Un seul passage (GitHub Actions / cron)
backtest.js        Backtest des stratégies en console
src/gold.js        Moteur de paper trading + backtest
src/strategies.js  Les 5 stratégies
src/indicators.js  EMA, RSI, ATR, Bollinger, MACD, Donchian, Supertrend
src/cycle.js       Un passage : trading + bilan
src/channel.js     Publication Telegram
src/format.js      Messages Telegram
src/store.js       Fichiers JSON du dossier data/
src/config.js      Lecture du .env
```
