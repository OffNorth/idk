# 🔎 Meme Coin Scanner Bot

Bot Telegram qui cherche en continu les **meilleurs meme coins entre 100 k$ et 2 M$ de market cap**
(Solana par défaut). Il les filtre, les note sur 100 et publie les meilleurs sur un canal Telegram.

> ⚠️ **Ce n'est pas un conseil financier.** Le score mesure l'activité et le momentum d'un token,
> il ne prédit pas son prix. La plupart des meme coins finissent à zéro. N'investis que ce que tu peux perdre.
> Le bot **n'achète rien** : il ne fait qu'analyser et alerter.

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

## Commandes Telegram

| Commande | Rôle |
|---|---|
| `/top` | Classement actuel des meilleurs tokens |
| `/check <adresse>` | Analyse détaillée d'un token, avec les raisons s'il est rejeté |
| `/scan` | Force un scan et publie les alertes tout de suite |
| `/topcanal` | Publie le top 10 actuel sur le canal |
| `/testcanal` | Envoie un message de test sur le canal (pour vérifier la config) |
| `/settings` | Affiche les paramètres actifs |
| `/pause` / `/resume` | Coupe / relance les alertes automatiques du canal |

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
bot.js            Bot Telegram + boucle de scan automatique
scan.js           Scan unique en console
src/config.js     Lecture du .env
src/sources.js    Découverte des tokens (DexScreener, GeckoTerminal)
src/dexscreener.js Données de marché
src/rugcheck.js   Vérification de sécurité (Solana)
src/scoring.js    Filtres éliminatoires et score
src/scanner.js    Pipeline complet d'un scan
src/format.js     Messages Telegram / console
src/store.js      Tokens suivis et historique des alertes (dossier data/)
```

Toutes les API utilisées sont publiques et gratuites, sans clé. GeckoTerminal a une limite de requêtes
stricte : s'il refuse, le scan continue avec les autres sources.
