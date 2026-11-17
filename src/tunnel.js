/**
 * Lien HTTPS gratuit pour la mini-app (WEB_TUNNEL=1) : « quick tunnel » Cloudflare (trycloudflare.com),
 * sans compte. Telegram n'ouvre une mini-app DANS l'application que si son adresse est en HTTPS.
 * Le programme cloudflared (~40 Mo) est téléchargé une fois dans data/bin. L'adresse change à chaque redémarrage :
 * le bot met alors à jour le bouton du menu tout seul.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ARCH = { x64: 'amd64', arm64: 'arm64', arm: 'arm' };

async function ensureBinary(dataDir) {
  const dir = path.join(dataDir, 'bin');
  const file = path.join(dir, 'cloudflared');
  if (fs.existsSync(file) && fs.statSync(file).size > 1e6) return file;
  const arch = ARCH[process.arch];
  if (process.platform !== 'linux' || !arch) throw new Error(`système non pris en charge (${process.platform}/${process.arch})`);
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}`;
  console.log('[tunnel] téléchargement de cloudflared…');
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`téléchargement de cloudflared : HTTP ${res.status}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Lance le tunnel vers le port local ; onUrl(url) est appelé à chaque nouvelle adresse publique.
 * Relance automatiquement le tunnel s'il s'arrête.
 */
async function startTunnel({ port, dataDir, onUrl }) {
  const bin = await ensureBinary(dataDir);
  let delay = 5_000;
  let child = null;
  process.once('exit', () => child?.kill());
  const launch = () => {
    child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const scan = (buf) => {
      const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        delay = 5_000;
        Promise.resolve(onUrl(m[0])).catch((err) => console.warn('[tunnel]', err.message));
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', (code) => {
      console.warn(`[tunnel] arrêté (code ${code}), relance dans ${delay / 1000} s`);
      setTimeout(launch, delay);
      delay = Math.min(delay * 2, 600_000);
    });
  };
  launch();
}

module.exports = { startTunnel };
