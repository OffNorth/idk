/**
 * pump.js — Module de lancement de token sur Pump.fun
 *
 * Utilise le SDK communautaire @nirholas/pump-sdk (construction d'instructions
 * hors-ligne) + @solana/web3.js pour signer et envoyer les transactions.
 */
require('dotenv').config();
const fs = require('fs');
const {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { OnlinePumpSdk, getBuyTokenAmountFromSolAmount } = require('@nirholas/pump-sdk');
const { PinataSDK } = require('pinata');
const BN = require('bn.js');
const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const METADATA_PROVIDER = (process.env.METADATA_PROVIDER || 'pump').toLowerCase();
const MAX_RETRIES = readPositiveNumber('SOLANA_SEND_MAX_RETRIES', 5);
const DEFAULT_SLIPPAGE_PCT = readPositiveNumber('DEFAULT_SLIPPAGE_PCT', 10);
const NETWORK_RETRIES = readPositiveNumber('NETWORK_RETRIES', 3);
const NETWORK_RETRY_DELAY_MS = readPositiveNumber('NETWORK_RETRY_DELAY_MS', 750);
const MIN_LAUNCH_BUFFER_SOL = readNonNegativeNumber('MIN_LAUNCH_BUFFER_SOL', 0.05);
const DRY_RUN_UPLOAD_METADATA = readBoolean('DRY_RUN_UPLOAD_METADATA', true);
const CHANNEL_MESSAGE_TEMPLATE = process.env.CHANNEL_MESSAGE_TEMPLATE || '';
const CHANNEL_MESSAGE_TEMPLATE_FILE = process.env.CHANNEL_MESSAGE_TEMPLATE_FILE || '';

function readPositiveNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} doit être un nombre positif.`);
  }
  return value;
}

function readNonNegativeNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} doit être un nombre positif ou zéro.`);
  }
  return value;
}

function readBoolean(name, fallback) {
  const value = process.env[name];
  if (typeof value === 'undefined') return fallback;
  return ['1', 'true', 'yes', 'oui', 'on'].includes(value.toLowerCase());
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, label, attempts = NETWORK_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleep(NETWORK_RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`${label} échoué après ${attempts} tentative(s) : ${lastError?.message || lastError}`);
}

function loadWallet() {
  if (!process.env.PRIVATE_KEY_BASE58) {
    throw new Error('PRIVATE_KEY_BASE58 manquant dans le fichier .env');
  }
  const secret = bs58.decode(process.env.PRIVATE_KEY_BASE58.trim());
  if (secret.length !== 64) {
    throw new Error('PRIVATE_KEY_BASE58 invalide : la clé privée décodée doit contenir 64 octets.');
  }
  return Keypair.fromSecretKey(secret);
}

/* ------------------------------------------------------------------ */
/* 1. Métadonnées : image + JSON → IPFS                                */
/* ------------------------------------------------------------------ */

async function uploadMetadataPump({ imagePath, name, symbol, description, twitter, telegram, website }) {
  // Endpoint IPFS utilisé par le frontend pump.fun
  const form = new FormData();
  form.append('name', name);
  form.append('symbol', symbol);
  form.append('description', description || '');
  if (twitter) form.append('twitter', twitter);
  if (telegram) form.append('telegram', telegram);
  if (website) form.append('website', website);
  form.append('showName', 'true');

  const buf = fs.readFileSync(imagePath);
  const ext = imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg') ? 'jpeg' : 'png';
  form.append('file', new Blob([buf], { type: `image/${ext}` }), `image.${ext}`);

  const res = await fetch('https://pump.fun/api/ipfs', {
    method: 'POST',
    body: form,
    headers: { Origin: 'https://pump.fun', Referer: 'https://pump.fun/' },
  });
  if (!res.ok) throw new Error(`Upload IPFS pump.fun échoué : ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (!json.metadataUri) throw new Error('Réponse IPFS inattendue : ' + JSON.stringify(json));
  return json.metadataUri;
}

async function uploadMetadataPinata({ imagePath, name, symbol, description, twitter, telegram, website }) {
  if (!process.env.PINATA_JWT) throw new Error('PINATA_JWT manquant dans le .env');
  const pinata = new PinataSDK({ pinataJwt: process.env.PINATA_JWT });

  // Étape 1 : l'image
  const buf = fs.readFileSync(imagePath);
  const mime = imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';
  const imageUpload = await withRetry(
    () => pinata.upload.file(
      new File([buf], `image.${mime === 'image/jpeg' ? 'jpg' : 'png'}`, { type: mime }),
      { metadata: { name: `${symbol}-image` } }
    ),
    'Upload image Pinata'
  );
  const imageUri = `https://ipfs.io/ipfs/${imageUpload.cid}`;

  // Étape 2 : le JSON de métadonnées
  const metadata = {
    name,
    symbol,
    description: description || '',
    image: imageUri,
    showName: true,
    createdOn: 'https://pump.fun',
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(website ? { website } : {}),
  };
  const jsonUpload = await withRetry(
    () => pinata.upload.json(metadata, {
      metadata: { name: `${symbol}-metadata` },
    }),
    'Upload JSON Pinata'
  );
  return `https://ipfs.io/ipfs/${jsonUpload.cid}`;
}

async function uploadMetadata(params) {
  if (!['pump', 'pinata'].includes(METADATA_PROVIDER)) {
    throw new Error('METADATA_PROVIDER invalide : utilisez "pump" ou "pinata".');
  }
  return withRetry(
    () => METADATA_PROVIDER === 'pinata'
      ? uploadMetadataPinata(params)
      : uploadMetadataPump(params),
    `Upload métadonnées ${METADATA_PROVIDER}`
  );
}

/* ------------------------------------------------------------------ */
/* 2. Envoi d'une transaction signée                                   */
/* ------------------------------------------------------------------ */

async function sendAndConfirm(connection, instructions, signers) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: signers[0].publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: MAX_RETRIES,
  });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) {
    throw new Error(`Transaction échouée (${signature}) : ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

async function getLaunchStatus({ devBuySol = 0 } = {}) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = loadWallet();
  const balanceLamports = await withRetry(
    () => connection.getBalance(wallet.publicKey, 'confirmed'),
    'Lecture balance wallet'
  );
  await withRetry(
    () => connection.getLatestBlockhash('confirmed'),
    'Vérification RPC Solana'
  );

  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
  const estimatedRequiredSol = Number(devBuySol || 0) + MIN_LAUNCH_BUFFER_SOL;

  return {
    creator: wallet.publicKey.toBase58(),
    rpcUrl: RPC_URL,
    metadataProvider: METADATA_PROVIDER,
    balanceLamports,
    balanceSol,
    estimatedRequiredSol,
    minLaunchBufferSol: MIN_LAUNCH_BUFFER_SOL,
    hasEnoughBalance: balanceSol >= estimatedRequiredSol,
  };
}

async function previewLaunch(p, options = {}) {
  if (!p.name || !p.symbol || !p.imagePath) {
    throw new Error('Paramètres de preview incomplets : name, symbol et imagePath sont requis.');
  }
  if (!fs.existsSync(p.imagePath)) {
    throw new Error(`Image introuvable : ${p.imagePath}`);
  }

  const status = await getLaunchStatus({ devBuySol: p.devBuySol });
  const shouldUploadMetadata = options.uploadMetadata ?? DRY_RUN_UPLOAD_METADATA;
  const uri = shouldUploadMetadata ? await uploadMetadata(p) : null;

  return {
    ok: true,
    dryRun: true,
    uri,
    status,
    name: p.name,
    symbol: p.symbol,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Lancement du token                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} p
 *  name, symbol, description, twitter, telegram, website, imagePath,
 *  devBuySol (nombre de SOL du dev buy, 0 = aucun), slippagePct
 */
async function launchToken(p) {
  const connection = new Connection(RPC_URL, 'confirmed');
  const sdk = new OnlinePumpSdk(connection);
  const wallet = loadWallet();

  if (!p.name || !p.symbol || !p.imagePath) {
    throw new Error('Paramètres de lancement incomplets : name, symbol et imagePath sont requis.');
  }
  if (!fs.existsSync(p.imagePath)) {
    throw new Error(`Image introuvable : ${p.imagePath}`);
  }

  const status = await getLaunchStatus({ devBuySol: p.devBuySol });
  if (!status.hasEnoughBalance && process.env.SKIP_BALANCE_CHECK !== 'true') {
    throw new Error(`Balance insuffisante : ${status.balanceSol.toFixed(4)} SOL disponible, ${status.estimatedRequiredSol.toFixed(4)} SOL estimé.`);
  }

  // --- Métadonnées IPFS ---
  const uri = await uploadMetadata(p);

  // --- Création du token (mint frais, courbe de liaison incluse) ---
  const mint = Keypair.generate();
  const createIx = await sdk.createV2Instruction({
    mint: mint.publicKey,
    name: p.name,
    symbol: p.symbol,
    uri,
    creator: wallet.publicKey,
    user: wallet.publicKey,
    mayhemMode: false,
  });
  const signature = await sendAndConfirm(connection, [createIx], [wallet, mint]);

  // --- Dev buy optionnel ---
  let devBuy = null;
  if (p.devBuySol && p.devBuySol > 0) {
    const [buyState, global, feeConfig] = await Promise.all([
      sdk.fetchBuyState(mint.publicKey, wallet.publicKey),
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
    ]);

    const solAmount = new BN(Math.round(p.devBuySol * LAMPORTS_PER_SOL));
    const expectedTokens = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: solAmount,
    });

    const buyIxs = await sdk.buyInstructions({
      ...buyState,
      mint: mint.publicKey,
      user: wallet.publicKey,
      amount: expectedTokens,
      solAmount,
      slippage: (p.slippagePct ?? DEFAULT_SLIPPAGE_PCT) / 100,
    });
    const devBuySignature = await sendAndConfirm(connection, buyIxs, [wallet]);

    devBuy = {
      signature: devBuySignature,
      solSpent: p.devBuySol,
      tokensReceived: expectedTokens.toString(),
      supplyPercent: expectedTokens.muln(10_000).div(buyState.bondingCurve.tokenTotalSupply).toNumber() / 100,
    };
  }

  // --- Résumé de la courbe juste après le lancement ---
  const summary = await sdk.fetchBondingCurveSummary(mint.publicKey);

  return {
    mint: mint.publicKey.toBase58(),
    signature,
    devBuy,
    summary, // marketCap (lamports, BN), progressBps, isGraduated, ...
    name: p.name,
    symbol: p.symbol,
    uri,
    creator: wallet.publicKey.toBase58(),
  };
}

/* ------------------------------------------------------------------ */
/* 4. Helpers d'affichage                                              */
/* ------------------------------------------------------------------ */

async function fetchSolPriceUsd() {
  try {
    const res = await withRetry(
      () => fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'),
      'Lecture prix SOL'
    );
    if (!res.ok) return null;
    const json = await res.json();
    return json?.solana?.usd ?? null;
  } catch {
    return null;
  }
}

function fmt(n, decimals = 4) {
  return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: decimals });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readTemplate() {
  if (CHANNEL_MESSAGE_TEMPLATE_FILE) {
    try {
      return fs.readFileSync(CHANNEL_MESSAGE_TEMPLATE_FILE, 'utf8');
    } catch (err) {
      throw new Error(`Template introuvable (${CHANNEL_MESSAGE_TEMPLATE_FILE}) : ${err.message}`);
    }
  }
  return CHANNEL_MESSAGE_TEMPLATE;
}

function renderTemplate(template, values) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/gi, (_, key) => values[key] ?? values[key.toLowerCase()] ?? '');
}

function buildMessageValues(r, solPriceUsd) {
  const TOTAL_SUPPLY = 1_000_000_000; // tous les tokens Pump.fun : 1 milliard
  const mcLamports = BigInt(r.summary.marketCap.toString());
  const mcSol = Number(mcLamports) / LAMPORTS_PER_SOL;
  const priceSol = mcSol / TOTAL_SUPPLY;
  const progress = (Number(r.summary.progressBps) / 100).toFixed(1);
  const mcUsd = solPriceUsd ? fmt(mcSol * solPriceUsd, 0) : '';
  const devBuyLine = r.devBuy
    ? `💰 <b>Dev buy</b> : ${r.devBuy.solSpent} SOL → ${(Number(r.devBuy.tokensReceived) / 1e12).toFixed(2)}M tokens (~${r.devBuy.supplyPercent.toFixed(2)}% de la supply)\n   Tx : https://solscan.io/tx/${r.devBuy.signature}`
    : '';

  return {
    name: escapeHtml(r.name),
    symbol: escapeHtml(r.symbol),
    mint: r.mint,
    creator: r.creator,
    signature: r.signature,
    metadata_uri: escapeHtml(r.uri || ''),
    market_cap_sol: fmt(mcSol),
    market_cap_usd: mcUsd,
    market_cap_usd_suffix: solPriceUsd ? ` (~${mcUsd} $)` : '',
    price_sol: priceSol.toExponential(4),
    progress_pct: progress,
    total_supply: TOTAL_SUPPLY.toLocaleString('fr-FR'),
    dev_buy_line: devBuyLine,
    pump_url: `https://pump.fun/coin/${r.mint}`,
    solscan_token_url: `https://solscan.io/token/${r.mint}`,
    dexscreener_url: `https://dexscreener.com/solana/${r.mint}`,
    creation_tx_url: `https://solscan.io/tx/${r.signature}`,
  };
}

/** Construit le message de présentation du token pour le canal Telegram. */
function buildChannelMessage(r, solPriceUsd) {
  const values = buildMessageValues(r, solPriceUsd);
  const template = readTemplate();
  if (template.trim()) return renderTemplate(template, values);

  const lines = [
    `🚀 <b>${values.name} ($${values.symbol})</b> est en ligne sur Pump.fun !`,
    ``,
    `🪙 <b>Mint :</b> <code>${r.mint}</code>`,
    `👤 <b>Créateur :</b> <code>${r.creator}</code>`,
    ``,
    `📊 <b>Marché</b>`,
    `• Market cap : ${values.market_cap_sol} SOL${values.market_cap_usd_suffix}`,
    `• Prix : ${values.price_sol} SOL / token`,
    `• Supply totale : ${values.total_supply} (fixe)`,
    `• Progression courbe : ${values.progress_pct}%`,
    ``,
  ];

  if (r.devBuy) {
    lines.push(values.dev_buy_line, ``);
  }

  lines.push(
    `🔗 <b>Liens</b>`,
    `• Pump.fun : ${values.pump_url}`,
    `• Solscan : ${values.solscan_token_url}`,
    `• Dexscreener : ${values.dexscreener_url}`,
    ``,
    `🧾 <b>Tx création</b> : ${values.creation_tx_url}`,
    ``,
    `⚠️ Token de type memecoin — hautement volatile, DYOR.`
  );

  return lines.join('\n');
}

module.exports = {
  launchToken,
  previewLaunch,
  getLaunchStatus,
  buildChannelMessage,
  fetchSolPriceUsd,
};
