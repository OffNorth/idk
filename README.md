# 🔎 Meme Coin Scanner Bot

Bot Telegram qui cherche en continu les **meilleurs meme coins entre 100 k$ et 2 M$ de market cap**
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

## Paper trading (simulation)

Pour mesurer si les calls valent quelque chose, le bot **simule** des trades et publie les résultats sur le canal.
Aucun ordre réel n'est passé, aucun wallet n'est utilisé.

### Sur ses propres calls
- Chaque alerte publiée = **achat simulé de 100 $** au prix du moment.
- À chaque passage, la position est réévaluée et vendue (simulé) dès qu'une règle se déclenche :

| Règle | Défaut |
|---|---|
| Take profit | +100 % (x2) |
| Stop loss | −40 % |
| Trailing stop | après +50 %, vend si le prix recule de 30 % depuis son plus haut |
| Durée max | 48 h |
| Rug | liquidité < 1 000 $ ou paire disparue → −100 % |
| Frais + slippage | 2 % à l'achat et 2 % à la vente |

- Chaque clôture est publiée (🟢 / 🔴) avec le résultat en % et en $.

### Sur l'or (PAXG/USD, 1 PAXG = 1 once d'or)
- Bougies 1 h (Coinbase, secours Kraken), positions de 1 000 $ simulées, **long ou short**.
- **Achat** quand l'EMA 20 croise au-dessus de l'EMA 50 (et RSI < 70), **vente à découvert** au croisement inverse (RSI > 30).
- Stop loss = 1,5 × ATR, take profit = 3 × ATR ; un croisement inverse retourne la position.
- C'est une stratégie de suivi de tendance lente : quelques trades par semaine seulement.
  Sur un test des 15 derniers jours (oct.–nov. 2026) : 4 trades, −2,3 % au total. **Rien ne garantit qu'elle soit rentable.**

Le **bilan** (PnL, % de trades gagnants, positions ouvertes) est publié avec le résumé du top toutes les `TOP_SUMMARY_HOURS`,
et disponible avec la commande `/paper` en mode serveur. Tous les paramètres sont dans `.env.example`
(ou dans l'onglet **Variables** de GitHub : `PAPER_SIZE_USD`, `PAPER_TP_PCT`, `PAPER_SL_PCT`, `GOLD_TRADING`…).

## Commandes Telegram

| Commande | Rôle |
|---|---|
| `/top` | Classement actuel des meilleurs tokens |
| `/check <adresse>` | Analyse détaillée d'un token, avec les raisons s'il est rejeté |
| `/scan` | Force un scan et publie les alertes tout de suite |
| `/topcanal` | Publie le top 10 actuel sur le canal |
| `/testcanal` | Envoie un message de test sur le canal (pour vérifier la config) |
| `/paper` | Bilan du paper trading (calls + or) |
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
src/gold.js       Paper trading de l'or (EMA 20/50, RSI, ATR)
src/channel.js    Publication sur le canal Telegram
src/store.js      Tokens suivis et historique des alertes (dossier data/)
```

Toutes les API utilisées sont publiques et gratuites, sans clé. GeckoTerminal a une limite de requêtes
stricte : s'il refuse, le scan continue avec les autres sources.
