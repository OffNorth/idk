/**
 * Historique long pour la recherche : PAXG/USDT en 1 h depuis l'archive publique de Binance
 * (data.binance.vision, fichiers mensuels .zip), mis en cache dans data/research/.
 * + agrégation en 6 h et en journalier.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = 'https://data.binance.vision/data/spot/monthly/klines/PAXGUSDT/1h';
const FIRST_MONTH = '2020-09';

/** Extrait le premier fichier d'un .zip (lecture du répertoire central, sans dépendance). */
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip invalide');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error('répertoire central invalide');
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

function parseCsv(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const f = line.split(',');
    if (f.length < 6 || !/^\d/.test(f[0])) continue;
    let t = Number(f[0]);
    if (t > 1e14) t /= 1000; // depuis 2025 Binance donne des microsecondes
    out.push({ t: Math.floor(t / 1000), o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] });
  }
  return out;
}

function months(from, to) {
  const list = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    list.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return list;
}

/** Bougies 1 h de FIRST_MONTH jusqu'au dernier mois complet (cache disque). */
async function loadHourly(cacheDir, { log = () => {} } = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
  const all = [];
  for (const mo of months(FIRST_MONTH, lastMonth)) {
    const file = path.join(cacheDir, `PAXGUSDT-1h-${mo}.json`);
    let rows;
    if (fs.existsSync(file)) {
      rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      const res = await fetch(`${BASE}/PAXGUSDT-1h-${mo}.zip`, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`archive Binance ${mo} : HTTP ${res.status}`);
      rows = parseCsv(unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8'));
      fs.writeFileSync(file, JSON.stringify(rows));
      log(`  ${mo} : ${rows.length} bougies`);
    }
    all.push(...rows);
  }
  const byT = new Map(all.map((c) => [c.t, c]));
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Agrège des bougies 1 h en bougies de `sec` secondes alignées sur UTC (6 h : 0/6/12/18 h, 1 j : minuit). */
function aggregate(hourly, sec) {
  const out = [];
  let cur = null;
  for (const c of hourly) {
    const t = Math.floor(c.t / sec) * sec;
    if (!cur || cur.t !== t) {
      if (cur) out.push(cur);
      cur = { t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, n: 1 };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
      cur.n++;
    }
  }
  if (cur) out.push(cur);
  // on écarte les bougies incomplètes (moins de 80 % des heures attendues)
  return out.filter((b) => b.n >= Math.floor((sec / 3600) * 0.8)).map(({ n, ...b }) => b);
}

module.exports = { loadHourly, aggregate, unzipFirst, parseCsv };
