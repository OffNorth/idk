# 🔎 Bot or + meme coins

Bot Telegram qui **trade l'or en simulation** (5 stratégies) et cherche en continu les **meilleurs meme coins entre 100 k$ et 2 M$ de market cap**
(Solana par défaut). Il les filtre, les note sur 100 et publie les meilleurs sur un canal Telegram.

> ⚠️ **Ce n'est pas un conseil financier.** Le score mesure l'activité et le momentum d'un token,
> il ne prédit pas son prix. La plupart des meme coins finissent à zéro. N'investis que ce que tu peux perdre.
> Le bot **n'achète rien** : il analyse, alerte et fait du **paper trading** (trades simulés, sans argent réel).

## Fonctionnement

```
Toutes les N minutes
  │
  ├─ 1. Découverte  : DexScreener (profils, boosts, top boosts, CTO, recherches)
  │                   + GeckoTerminal (pools tendance / les plus actives)
  ├─ 2. Suivi       : chaque token découvert est suivi 48 h (il peut entrer dans la fourchette plus tard)
  ├─ 3. Données     : prix, MC, liquidité, volume, achats/ventes via DexScreener
  ├─ 4. Filtres     : MC 100k–2M, liquidité, volume, nb de tx, âge, déjà trop pompé,
  │                   liquidité/MC < 2 %, ventes massives sur 1 h
  ├─ 5. Score /100  : voir ci-dessous
  ├─ 6. RugCheck    : rejet si mint/freeze authority actives ou risque trop élevé, sinon pénalité
  │
  └─► Alerte sur le canal pour les tokens au-dessus du score minimum (sans doublon)
```

### Le score (sur 100)

| Critère | Points | Ce qui est mesuré |
|---|---|---|
| Activité | 20 | Volume 24 h ÷ market cap |
| Momentum | 15 | Volume de la dernière heure vs moyenne horaire sur 6 h |
| Pression acheteuse | 20 | Part des achats dans les transactions (1 h et 24 h) |
| Prix | 15 | Tendance 1 h / 6 h positive, pénalisé si déjà +300 % sur 24 h |
| Liquidité | 15 | Liquidité saine (10–35 % de la MC) et montant absolu |
| Social | 10 | X (4), Telegram (3), site web (3) |
| Traders | 5 | Nombre de transactions sur 24 h |
| Risque | −25 max | Pénalité selon le rapport RugCheck |

## 🥇 Paper trading de l'or (simulation)

Le bot trade l'or **en simulation** avec **5 stratégies en parallèle**. Chacune a son propre compte, on peut donc
comparer leurs résultats. Aucun ordre réel n'est passé, aucun compte de trading n'est utilisé.

- Prix : **PAXG/USD** (1 PAXG = 1 once d'or) via Coinbase, secours Kraken. Gratuit, sans clé API.
- Signaux sur les **bougies 1 h clôturées** ; stops et objectifs vérifiés sur les **bougies 5 min**.
- **1 000 $ simulés** par trade et par stratégie, **long ou short**, frais/spread 0,05 % à l'entrée et à la sortie.
- Chaque ouverture et clôture est publiée sur le canal, et un **bilan** par stratégie toutes les `TOP_SUMMARY_HOURS`.

| Stratégie | Type | Entrée | Sortie |
|---|---|---|---|
| **Tendance EMA 20/50** | suivi de tendance | croisement EMA 20 / EMA 50 (filtre RSI) | SL 1,5 ATR · TP 3 ATR · croisement inverse |
| **Cassure Donchian 20** | breakout | cassure du plus haut / plus bas des 20 dernières heures | stop suiveur 2,5 ATR · canal 10 h opposé |
| **Retour à la moyenne** | contre-tendance | sortie des bandes de Bollinger + RSI < 30 / > 70 | retour sur la moyenne 20 h · SL 1,5 ATR |
| **MACD + EMA 200** | momentum | croisement MACD / signal dans le sens de l'EMA 200 | SL 2 ATR · TP 4 ATR · croisement inverse |
| **Supertrend (10, 3)** | suivi de tendance | changement de direction du Supertrend | stop sur la ligne du Supertrend |

### Résultats passés (backtest du 17/11/2026)

Sur **90 jours** (or de 4 485 $ à 3 862 $, soit −14 %), avec 1 000 $ par trade :

| Stratégie | Trades | Gagnants | PnL |
|---|---|---|---|
| Tendance EMA 20/50 | 39 | 26 % | −76 $ |
| Cassure Donchian 20 | 86 | 22 % | −97 $ |
| Retour à la moyenne | 66 | 39 % | −44 $ |
| MACD + EMA 200 | 73 | 27 % | −107 $ |
| Supertrend | 60 | 22 % | −135 $ |

Sur 180 jours, seul le Supertrend finit légèrement positif (+28 $). **Aucune de ces stratégies n'a montré d'avantage
fiable** : c'est justement ce que le paper trading en direct sert à vérifier dans le temps.
Pour refaire le test : `npm run backtest` (90 jours) ou `npm run backtest -- 180`, ou `/backtest 180` dans Telegram.

### Ce dont le bot a besoin

| Besoin | Pourquoi | Statut |
|---|---|---|
| Un hébergement allumé 24h/24 | vérifier les stops toutes les 3 min | Bot-Hosting (renouveler tous les 4 jours) |
| Node.js 20 ou plus | faire tourner le code | fourni par le serveur Node.js |
| Token du bot + canal Telegram | publier les trades | dans `.env` |
| Accès internet à Coinbase / Kraken | prix de l'or | gratuit, sans clé |
| ~100 Mo de RAM, quelques Mo de disque | mémoire des positions (`data/gold.json`) | OK |

Pour passer un jour en **argent réel**, il faudrait en plus : un compte chez un broker qui propose l'or avec une API
(CFD XAU/USD ou PAXG sur un exchange), des clés API, du capital, et des règles de risque (taille de position, perte
max par jour). Ce n'est pas branché : le bot ne fait que simuler.

### Paper trading des calls meme coins (désactivé par défaut)
Avec `PAPER_TRADING=1`, chaque alerte meme coin ouvre aussi un achat simulé de 100 $ (TP +100 %, SL −40 %,
trailing stop, durée max 48 h, rug = −100 %, 2 % de frais par côté).

## Commandes Telegram

| Commande | Rôle |
|---|---|
| `/top` | Classement actuel des meilleurs tokens |
| `/check <adresse>` | Analyse détaillée d'un token, avec les raisons s'il est rejeté |
| `/scan` | Force un scan et publie les alertes tout de suite |
| `/topcanal` | Publie le top 10 actuel sur le canal |
| `/testcanal` | Envoie un message de test sur le canal (pour vérifier la config) |
| `/gold` | Bilan du paper trading de l'or, stratégie par stratégie |
| `/backtest [jours]` | Backtest des stratégies or sur l'historique (90 jours par défaut) |
| `/settings` | Affiche les paramètres actifs |
| `/pause` / `/resume` | Coupe / relance les alertes automatiques du canal |

## Hébergement gratuit sans carte bancaire : GitHub Actions

GitHub lance le scan tout seul toutes les 10 minutes et publie sur ton canal. Pas de serveur, pas de carte.

1. Sur GitHub, ouvre le dépôt → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** :
   - `TELEGRAM_BOT_TOKEN` = le token donné par @BotFather
   - `TELEGRAM_CHANNEL_ID` = `@ton_canal` (ou `-100…`)
2. Onglet **Actions** → si demandé, clique sur **« I understand my workflows, go ahead and enable them »**.
3. Clique sur **Scanner meme coins** → **Run workflow** pour un premier essai. Au bout d'environ 1 min, les alertes arrivent sur le canal.
   Ensuite, ça tourne seul toutes les 10 min.

Limites de ce mode :
- Pas de commandes (`/top`, `/check`…) : seulement les alertes et le résumé du top sur le canal.
- Un scan toutes les 10 min consomme ~4300 min/mois. Dépôt **public** : illimité, aucun souci (tes secrets restent cachés).
  Dépôt **privé** : seulement 2000 min gratuites/mois → le quota est épuisé vers le 14 et les scans s'arrêtent jusqu'au mois
  suivant. Pour rester en privé, remets `*/30 * * * *` dans `.github/workflows/scanner.yml`.
- GitHub peut retarder les lancements de quelques minutes aux heures chargées.
- Réglages optionnels dans l'onglet **Variables** (même page que les secrets) : `MIN_MARKET_CAP`, `MAX_MARKET_CAP`,
  `MIN_ALERT_SCORE`, `MAX_ALERTS_PER_SCAN`, `TOP_SUMMARY_HOURS`, `WATCH_HOURS`.

Pour un scan unique en local : `node once.js` (mêmes variables `.env`).

## Installation (Debian / Ubuntu)

```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

git clone https://github.com/OffNorth/idk.git memecoin-scanner
cd memecoin-scanner
npm install
cp .env.example .env
nano .env   # renseigner TELEGRAM_BOT_TOKEN et TELEGRAM_CHANNEL_ID
```

### Brancher le canal Telegram

1. Crée un bot avec [@BotFather](https://t.me/BotFather) (`/newbot`) → copie le token dans `TELEGRAM_BOT_TOKEN`.
2. Crée ton canal (public ou privé).
3. Canal → *Administrateurs* → *Ajouter un administrateur* → cherche ton bot → laisse le droit **« Publier des messages »** activé.
4. Dans `.env`, mets `TELEGRAM_CHANNEL_ID` :
   - canal public : `@nom_du_canal`
   - canal privé : son ID `-100…` (transfère un message du canal à [@userinfobot](https://t.me/userinfobot) ou ouvre le canal sur web.telegram.org : l'ID est dans l'URL, ajoute `-100` devant).
5. (Conseillé) Mets ton ID Telegram dans `ALLOWED_TELEGRAM_USER_IDS` pour être le seul à piloter le bot.
6. Lance le bot : au démarrage il affiche `✅ Canal « … » : publication autorisée.` Sinon il dit précisément ce qui ne va pas.
   Envoie `/testcanal` au bot en privé pour publier un message de test.

Ce que le bot publie sur le canal :
- une **alerte** par nouveau token qui dépasse `MIN_ALERT_SCORE`, avec l'image du token, la MC, la liquidité, le volume, les achats/ventes, le rapport RugCheck et les liens (DexScreener, Pump.fun, RugCheck, Solscan, X, Telegram, site) ;
- un **résumé du top 10** toutes les `TOP_SUMMARY_HOURS` heures (4 h par défaut, `0` pour désactiver).

### Tester sans Telegram

```bash
npm run scan          # affiche le top 20 dans le terminal
npm run scan -- 50    # top 50
npm test              # tests unitaires des filtres et du score
```

### Lancer le bot

```bash
npm start
```

Pour le garder en marche sur un VPS :

```bash
sudo npm install -g pm2
pm2 start bot.js --name memecoin-scanner
pm2 save && pm2 startup
pm2 logs memecoin-scanner
```

## Réglages (`.env`)

Tous les paramètres sont dans [`.env.example`](.env.example). Les principaux :

| Variable | Défaut | Rôle |
|---|---|---|
| `MIN_MARKET_CAP` / `MAX_MARKET_CAP` | 100000 / 2000000 | Fourchette de market cap en $ |
| `CHAINS` | `solana` | Chaînes à scanner (`solana,base,bsc`…) |
| `MIN_LIQUIDITY_USD` | 15000 | Liquidité minimum |
| `MIN_VOLUME_24H_USD` | 30000 | Volume 24 h minimum |
| `MIN_ALERT_SCORE` | 65 | Score minimum pour publier une alerte |
| `SCAN_INTERVAL_MINUTES` | 3 | Fréquence des scans |
| `ALERT_COOLDOWN_HOURS` | 12 | Pas de nouvelle alerte pour le même token avant ce délai |
| `TOP_SUMMARY_HOURS` | 4 | Résumé du top 10 publié sur le canal (0 = désactivé) |
| `ALERT_WITH_IMAGE` | 1 | Image du token affichée au-dessus de l'alerte |
| `RUGCHECK_MAX_SCORE` | 50 | Risque RugCheck max accepté (0 = sûr, 100 = très risqué) |

Plus `MIN_ALERT_SCORE` est haut, moins il y a d'alertes, mais elles sont plus sélectives.

## Structure

```
bot.js            Bot Telegram + boucle de scan automatique (serveur allumé 24h/24)
once.js           Un seul passage scan + publication (GitHub Actions / cron)
.github/workflows/scanner.yml  Lancement automatique sur GitHub Actions
scan.js           Scan unique en console
src/config.js     Lecture du .env
src/sources.js    Découverte des tokens (DexScreener, GeckoTerminal)
src/dexscreener.js Données de marché
src/rugcheck.js   Vérification de sécurité (Solana)
src/scoring.js    Filtres éliminatoires et score
src/scanner.js    Pipeline complet d'un scan
src/format.js     Messages Telegram / console
src/cycle.js      Cycle complet : paper trades, alertes, or, résumé
src/paper.js      Paper trading des calls meme coins
src/gold.js       Paper trading de l'or (moteur, backtest)
src/strategies.js Les 5 stratégies or
src/indicators.js EMA, RSI, ATR, Bollinger, MACD, Donchian, Supertrend
backtest.js       Backtest des stratégies or en console
src/channel.js    Publication sur le canal Telegram
src/store.js      Tokens suivis et historique des alertes (dossier data/)
```

Toutes les API utilisées sont publiques et gratuites, sans clé. GeckoTerminal a une limite de requêtes
stricte : s'il refuse, le scan continue avec les autres sources.
