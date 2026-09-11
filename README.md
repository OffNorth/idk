# 🤖 Pump.fun Telegram Launch Bot

Bot Telegram qui lance des tokens sur **Pump.fun** (Solana) et publie automatiquement
les infos du token (mint, market cap, prix, dev buy, liens…) sur un **canal Telegram**.

## Fonctionnement

```
/launch dans Telegram
   │
   ├─ 1. Nom du token
   ├─ 2. Ticker
   ├─ 3. Description
   ├─ 4. Image (upload Telegram)
   ├─ 5. Liens X / Telegram / Site (optionnel)
   ├─ 6. Dev buy en SOL (optionnel → % de supply possédée)
   │
   ├─ Upload image + métadonnées → IPFS
   ├─ Transaction de création signée et envoyée sur Solana
   ├─ (Optionnel) Dev buy juste après la création
   │
   └─► Message complet posté sur le canal Telegram (avec l'image)
```

Commandes disponibles :

| Commande | Rôle |
|---|---|
| `/start` | Message d'accueil |
| `/launch` | Wizard de lancement réel (crée vraiment le token) |
| `/preview` | Simule tout le processus sans créer le token (vérifie wallet, RPC, canal, IPFS) |
| `/draft` | Affiche le brouillon en cours |
| `/clear_draft` | Supprime le brouillon |
| `/cancel` | Annule l'étape en cours dans un wizard |

---

## Installation sur Debian / Ubuntu (VPS)

Ces étapes marchent sur Debian 11/12 et Ubuntu 20.04/22.04/24.04.

### 1. Mettre le système à jour et installer les prérequis

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git unzip build-essential
```

### 2. Installer Node.js 20+ (dépôt NodeSource)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Vérifier les versions (Node >= 20 requis)
node -v
npm -v
```

### 3. Récupérer le projet

Si vous avez le zip fourni :

```bash
mkdir -p ~/apps && cd ~/apps
unzip pumpfun-launch-bot.zip -d pumpfun-launch-bot
cd pumpfun-launch-bot
```

Ou via git si le projet est versionné :

```bash
cd ~/apps
git clone <url-du-repo> pumpfun-launch-bot
cd pumpfun-launch-bot
```

### 4. Installer les dépendances Node

```bash
npm install
```

### 5. Créer le bot Telegram et le canal

- Parlez à **[@BotFather](https://t.me/BotFather)** sur Telegram → `/newbot` → récupérez le `TELEGRAM_BOT_TOKEN`.
- Créez (ou choisissez) un **canal Telegram**, ajoutez le bot comme **administrateur** (droit de publier).
- Récupérez l'**ID du canal** (ex : `-1001234567890`) en forwardant un message du canal vers
  **[@userinfobot](https://t.me/userinfobot)** ou **@getmyid_bot**.

### 6. Configurer le fichier `.env`

```bash
cp .env.example .env
nano .env   # ou vim / vi
```

Remplissez au minimum `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `PRIVATE_KEY_BASE58` et
idéalement `SOLANA_RPC_URL` (un RPC privé) et `ALLOWED_TELEGRAM_USER_IDS`. Détail des variables
plus bas.

### 7. Vérifier que tout est cohérent

```bash
npm run check
```

Cette commande vérifie juste la syntaxe des fichiers (`bot.js`, `pump.js`). Elle ne teste ni le
réseau ni les clés.

### 8. Lancer le bot (test manuel)

```bash
npm start
```

Le terminal doit afficher `🤖 Bot démarré : @votre_bot`. `Ctrl+C` pour arrêter.

### 9. Faire tourner le bot en permanence (PM2 — recommandé)

PM2 garde le bot actif, le relance en cas de crash, et le redémarre au reboot du serveur.

```bash
sudo npm install -g pm2

# Démarrer le bot
pm2 start bot.js --name pumpfun-launch-bot

# Voir les logs en direct
pm2 logs pumpfun-launch-bot

# Voir le statut
pm2 status

# Démarrage automatique au reboot du serveur
pm2 startup
# → copiez-collez la commande sudo que pm2 vous affiche, puis :
pm2 save
```

Commandes utiles ensuite :

```bash
pm2 restart pumpfun-launch-bot   # après une modif du code ou du .env
pm2 stop pumpfun-launch-bot
pm2 delete pumpfun-launch-bot
```

### 9bis. Alternative : service systemd (sans PM2)

```bash
sudo tee /etc/systemd/system/pumpfun-launch-bot.service > /dev/null << 'UNIT'
[Unit]
Description=Pump.fun Telegram Launch Bot
After=network.target

[Service]
Type=simple
User=VOTRE_UTILISATEUR
WorkingDirectory=/home/VOTRE_UTILISATEUR/apps/pumpfun-launch-bot
ExecStart=/usr/bin/node bot.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/home/VOTRE_UTILISATEUR/apps/pumpfun-launch-bot/.env

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now pumpfun-launch-bot
sudo systemctl status pumpfun-launch-bot
journalctl -u pumpfun-launch-bot -f   # logs en direct
```

Remplacez `VOTRE_UTILISATEUR` et le chemin par les vôtres.

---

## Installation sur d'autres systèmes

### macOS

```bash
brew install node   # Node >= 20
cd pumpfun-launch-bot
npm install
cp .env.example .env
npm start
```

### Windows

```powershell
# Installer Node.js >= 20 depuis https://nodejs.org (version LTS)
cd pumpfun-launch-bot
npm install
copy .env.example .env
notepad .env
npm run check
npm start
```

### Docker (optionnel)

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "bot.js"]
```

```bash
docker build -t pumpfun-launch-bot .
docker run -d --name pumpfun-launch-bot --env-file .env --restart unless-stopped pumpfun-launch-bot
```

---

## Variables d'environnement (`.env`)

### Telegram

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token du bot (BotFather) — **obligatoire** |
| `TELEGRAM_CHANNEL_ID` | ID du canal où publier les lancements (ex : `-1001234567890`) — **obligatoire** |
| `ALLOWED_TELEGRAM_USER_IDS` | IDs Telegram autorisés à utiliser le bot, séparés par des virgules. **Vide = n'importe qui peut lancer un token et dépenser le SOL du wallet.** À définir en prod. |

### Solana / wallet

| Variable | Description |
|---|---|
| `PRIVATE_KEY_BASE58` | Clé privée du wallet créateur en Base58 — **obligatoire**, ⚠️ wallet dédié uniquement |
| `SOLANA_RPC_URL` | RPC Solana (par défaut `api.mainnet-beta.solana.com` — un RPC privé Helius/QuickNode est recommandé en prod) |
| `SOLANA_SEND_MAX_RETRIES` | Tentatives max lors de l'envoi d'une transaction (défaut `5`) |
| `DEFAULT_SLIPPAGE_PCT` | Slippage max du dev buy, en % (défaut `10`) |
| `MIN_LAUNCH_BUFFER_SOL` | Solde minimum en SOL à garder en réserve en plus du dev buy pour couvrir les frais (défaut `0.05`) |
| `SKIP_BALANCE_CHECK` | `true`/`false` — ignore la vérification de solde avant lancement (dangereux, tests uniquement, défaut `false`) |

### Métadonnées (image + JSON du token)

| Variable | Description |
|---|---|
| `METADATA_PROVIDER` | `pump` (upload via l'endpoint IPFS de pump.fun, défaut) ou `pinata` |
| `PINATA_JWT` | Requis si `METADATA_PROVIDER=pinata` (compte gratuit sur pinata.cloud) |
| `DRY_RUN_UPLOAD_METADATA` | `true`/`false` — uploader réellement les métadonnées lors d'un `/preview` (défaut `true`) |

### Réseau (retries des appels Telegram / IPFS / prix SOL)

| Variable | Description |
|---|---|
| `NETWORK_RETRIES` | Nombre de tentatives (défaut `3`) |
| `NETWORK_RETRY_DELAY_MS` | Délai entre tentatives en ms (défaut `750`) |

### Garde-fous du wizard

| Variable | Description |
|---|---|
| `MAX_DESCRIPTION_LENGTH` | Longueur max de la description (défaut `500`) |
| `MAX_DEV_BUY_SOL` | Plafond anti-erreur pour le dev buy (défaut `10`) |

### Stockage local

| Variable | Description |
|---|---|
| `DATA_DIR` | Dossier des brouillons et du log de lancements (défaut `./data`) |
| `LAUNCH_LOG_FILE` | Fichier de log JSONL des previews/lancements (défaut `DATA_DIR/launches.jsonl`) |

### Message publié sur le canal

| Variable | Description |
|---|---|
| `CHANNEL_MESSAGE_TEMPLATE` | Template HTML personnalisé (placeholders `{{NAME}}`, `{{SYMBOL}}`, `{{MINT}}`, `{{PUMP_URL}}`, etc. — voir `buildMessageValues()` dans `pump.js`). Vide = message par défaut. |
| `CHANNEL_MESSAGE_TEMPLATE_FILE` | Chemin d'un fichier contenant le template, alternative à la variable ci-dessus |

---

## Récupérer la clé privée (Phantom)

Paramètres → Sécurité et confidentialité → **Exporter la clé privée** → format Base58.
**Utilisez impérativement un wallet dédié** avec seulement les SOL nécessaires.

## Ce qu'il faut savoir (mécanique Pump.fun)

- Supply fixe de **1 milliard** de tokens pour tous les tokens Pump.fun.
- Pas de frais de création (seulement les frais de transaction SOL).
- La liquidité est gérée par une **courbe de liaison** : le prix monte à chaque achat,
  la liquidité est le SOL accumulé dans la courbe.
- À ~85 SOL / $69k de market cap : **graduation automatique** vers PumpSwap (pool LP).
- Frais de trading sur la courbe : **1,25 %** (partagés protocole / créateur).

## Sécurité

- Ne committez JAMAIS votre `.env` (déjà exclu via `.gitignore`).
- La clé privée reste sur votre machine : le bot signe localement, aucun tiers ne la voit.
- Définissez `ALLOWED_TELEGRAM_USER_IDS` avant de mettre le bot en ligne publiquement.
- Utilisez un wallet dédié avec seulement le SOL nécessaire aux lancements.
- Respectez les [Conditions d'utilisation de Pump.fun](https://pump.fun/terms)
  (pas de contenu trompeur, pas d'appropriation de marques, etc.).

## Dépannage rapide

| Symptôme | Piste |
|---|---|
| `TELEGRAM_BOT_TOKEN manquant` au démarrage | Le `.env` n'existe pas ou n'est pas dans le bon dossier |
| Le bot ne répond pas du tout | Vérifiez `pm2 logs` / `journalctl -u pumpfun-launch-bot -f`, et que le process tourne (`pm2 status`) |
| `Balance insuffisante` en preview/launch | Le wallet (`PRIVATE_KEY_BASE58`) n'a pas assez de SOL par rapport à `MIN_LAUNCH_BUFFER_SOL` + dev buy |
| Le bot ne peut pas publier sur le canal | Vérifiez que le bot est bien **administrateur** du canal, et que `TELEGRAM_CHANNEL_ID` est correct (avec le `-100` devant pour un canal) |
| Upload IPFS échoué | Essayez `METADATA_PROVIDER=pinata` avec un `PINATA_JWT` valide |

## Structure

| Fichier | Rôle |
|---|---|
| `bot.js` | Wizard Telegram (conversations grammY), brouillons, commandes, publication canal |
| `pump.js` | Upload IPFS, création du token, dev buy, résumé de la courbe, construction du message canal |
| `.env.example` | Modèle de configuration à copier en `.env` |
