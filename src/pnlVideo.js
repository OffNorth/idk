/**
 * Vidéos « PnL card » d'un trade des comptes simulés (commande /video) : carte animée dessinée image par image avec le
 * moteur d'images du bot (src/draw.js) sur les vraies bougies du marché (Yahoo), puis assemblée par ffmpeg
 * (paquet ffmpeg-static) au format vertical 1080×1920 sur une vidéo de fond au choix.
 *
 * Fonds : « uni », « grille » (grille de graphique qui défile), « particules » (points lents), ou une vidéo envoyée au
 * bot (/fond <nom>, rangée dans data/fonds/). Une seule vidéo à la fois (file d'attente).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Canvas } = require('./draw');

const W = 540; // carte dessinée en 540×675 (polices du moteur ≤ 56 px), agrandie ×1,78 par ffmpeg
const H = 675;
const OUT_W = 960;
const OUT_H = 1200;
const FPS = 30;
const ANIM_S = 5;
const HOLD_S = 2.2;
const SYMBOL = { gold: 'GC=F', nas100: '^NDX', spx: '^GSPC', eurusd: 'EURUSD=X' };
const NAME = { gold: 'Or', nas100: 'Nasdaq 100', spx: 'S&P 500', eurusd: 'EUR/USD' };
const COL = {
  card: [16, 22, 29], ink: [238, 242, 238], mute: [138, 151, 163], line: [29, 39, 49],
  gain: [61, 220, 151], loss: [255, 107, 107], level: [156, 200, 255], dark: [11, 15, 20],
};
const BUILTIN = { uni: 'Uni', grille: 'Grille animée', particules: 'Particules' };

/* ------------------------------------------------------------------ */
/* ffmpeg                                                              */
/* ------------------------------------------------------------------ */

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return fs.existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : null;
  try {
    const p = require('ffmpeg-static');
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Fonds                                                               */
/* ------------------------------------------------------------------ */

const fondsDir = (cfg) => path.join(cfg.dataDir, 'fonds');
const safeName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

/** Fonds disponibles : [{ id, label }] (intégrés puis vidéos de l'utilisateur). */
function backgrounds(cfg) {
  const own = [];
  try {
    for (const f of fs.readdirSync(fondsDir(cfg))) if (f.endsWith('.mp4')) own.push({ id: `u:${f.slice(0, -4)}`, label: `🎞 ${f.slice(0, -4)}` });
  } catch { /* aucun */ }
  return [...Object.entries(BUILTIN).map(([id, label]) => ({ id, label })), ...own];
}

/** Arguments ffmpeg de l'entrée de fond (1080×1920, bouclée, assombrie). */
function backgroundInput(cfg, id, seconds) {
  const d = `${seconds.toFixed(2)}`;
  if (id && id.startsWith('u:')) {
    const file = path.join(fondsDir(cfg), `${safeName(id.slice(2))}.mp4`);
    if (fs.existsSync(file)) {
      return { args: ['-stream_loop', '-1', '-t', d, '-i', file], filter: '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,eq=brightness=-0.12:saturation=0.85,setsar=1[bg]' };
    }
  }
  if (id === 'grille') {
    return {
      args: ['-f', 'lavfi', '-t', d, '-i', 'color=c=0x0b0f14:s=1080x1920:r=30'],
      filter: "[0:v]drawgrid=w=90:h=90:t=1:c=0x1b2633@1,scroll=v=0.0012:h=0.0006,drawgrid=w=270:h=270:t=2:c=0x22303d@1,setsar=1[bg]",
    };
  }
  if (id === 'particules') {
    return {
      args: ['-f', 'lavfi', '-t', d, '-i', 'life=s=270x480:mold=24:r=10:ratio=0.08:death_color=0x0b0f14:life_color=0x1f3a33:mold_color=0x12201d,fps=30'],
      filter: '[0:v]scale=1080:1920:flags=neighbor,setsar=1[bg]',
    };
  }
  return { args: ['-f', 'lavfi', '-t', d, '-i', 'color=c=0x0b0f14:s=1080x1920:r=30'], filter: '[0:v]setsar=1[bg]' };
}

/** Masque des coins arrondis de la carte (niveaux de gris, blanc = visible). */
function maskPng() {
  const m = new Canvas(OUT_W, OUT_H, [0, 0, 0]);
  m.roundRect(0, 0, OUT_W, OUT_H, 52, [255, 255, 255]);
  return m.png();
}

/* ------------------------------------------------------------------ */
/* Données                                                             */
/* ------------------------------------------------------------------ */

/** Unité de bougies selon la durée et l'ancienneté du trade (≈ 60 à 120 bougies, limites de Yahoo). */
function intervalFor(trade, now = Date.now() / 1000) {
  const span = Math.max(300, trade.exitT - trade.entryT) * 1.7 + 3600;
  const age = now - trade.entryT;
  const opts = [['5m', 300, 58 * 86400], ['15m', 900, 58 * 86400], ['1h', 3600, 700 * 86400], ['1d', 86400, Infinity]];
  for (const [iv, sec, maxAge] of opts) if (span / sec <= 160 && age < maxAge) return { iv, sec };
  return { iv: '1d', sec: 86400 };
}

/** Bougies réelles autour du trade : [{ t, o, h, l, c }]. */
async function candlesFor(trade, fetcher = require('./yahoo').fetchYahoo) {
  const { iv, sec } = intervalFor(trade);
  const span = Math.max(300, trade.exitT - trade.entryT);
  const p1 = Math.floor(trade.entryT - Math.max(span * 0.45, sec * 18));
  const p2 = Math.ceil(trade.exitT + Math.max(span * 0.12, sec * 6));
  const all = await fetcher(SYMBOL[trade.market], iv, { period1: p1, period2: p2, attempts: 2, timeoutMs: 20_000 });
  return { interval: iv, sec, candles: all.filter((c) => c.t >= p1 && c.t <= p2) };
}

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */

const frNum = (v, d = 2) => (Number.isFinite(v) ? v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ /g, ' ') : '—');
const usd = (v) => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pxDigits = (m) => (m === 'eurusd' ? 5 : 2);
const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)} j ${Math.floor((m % 1440) / 60)} h`; };
const day = (t) => new Date(t * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Paris' }).toUpperCase();
const hm = (t) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

function cloneCanvas(base) {
  const c = Object.create(Canvas.prototype);
  c.w = base.w; c.h = base.h; c.px = Buffer.from(base.px);
  return c;
}
function chip(cv, x, y, text, color, border) {
  const w = cv.measure(text, 'r', 15) + 22;
  cv.roundRect(x, y, w, 28, 14, border);
  cv.roundRect(x + 1, y + 1, w - 2, 26, 13, [12, 17, 23]);
  cv.text(text, x + 11, y + 6, { size: 15, color });
  return w;
}

/**
 * Prépare la carte d'un trade. trade : { market, sid, name, side, entry, exit, sl, entryT, exitT, pnl, risk,
 * account (« FTMO » / « Lucid »), program, capital }. Retourne { frame(p) → Buffer RGB, frames, png() }.
 */
function prepareCard(trade, data) {
  const C = data.candles;
  const long = trade.side === 'long';
  const win = trade.pnl >= 0;
  const accent = win ? COL.gain : COL.loss;
  const base = new Canvas(W, H, COL.card);
  // en-tête
  base.text(`${trade.account || 'FTMO'} · ${(trade.program || 'Challenge').toUpperCase()}`, 30, 26, { size: 13, color: COL.mute });
  base.text(day(trade.exitT), W - 30, 26, { size: 13, color: COL.mute, align: 'right' });
  const sideTxt = long ? 'ACHAT' : 'VENTE';
  const bw = base.measure(sideTxt, 'b', 15) + 24;
  base.roundRect(30, 58, bw, 28, 14, long ? COL.gain : COL.loss);
  base.text(sideTxt, 42, 63, { style: 'b', size: 15, color: COL.dark });
  const nw = base.text(NAME[trade.market] || trade.market, 30 + bw + 12, 60, { style: 'b', size: 22, color: COL.ink });
  base.text(`${data.interval} · ${trade.sid}`, 30 + bw + 24 + nw, 66, { size: 13, color: COL.mute, maxWidth: W - (30 + bw + 24 + nw) - 30 });
  // bas : niveaux, durée
  const statsY = H - 112;
  base.line(30, statsY - 14, W - 30, statsY - 14, COL.line, 1);
  const stats = [['ENTRÉE', frNum(trade.entry, pxDigits(trade.market))], ['SORTIE', frNum(trade.exit, pxDigits(trade.market))], ['STOP', frNum(trade.sl, pxDigits(trade.market))], ['DURÉE', dur(trade.exitT - trade.entryT)]];
  const colW = (W - 60) / 4;
  stats.forEach(([k, v], i) => {
    base.text(k, 30 + i * colW, statsY, { size: 13, color: COL.mute });
    base.text(v, 30 + i * colW, statsY + 20, { style: 'b', size: 18, color: COL.ink, maxWidth: colW - 6 });
  });
  base.text(`Stratégie ${trade.name ? trade.name.replace(/^[^:]+:\s*/, '') : trade.sid}`, 30, H - 40, { size: 13, color: COL.mute, maxWidth: W * 0.58 });
  base.text('Compte simulé · argent fictif', W - 30, H - 40, { size: 13, color: COL.mute, align: 'right' });
  // puces fixes
  const R = trade.risk > 0 ? trade.pnl / trade.risk : null;
  const capPct = trade.capital ? (trade.pnl / trade.capital) * 100 : null;
  const mkPct = (trade.exit / trade.entry - 1) * 100;
  let cx = 30;
  const chipsY = 176;
  if (R !== null) cx += chip(base, cx, chipsY, `${R >= 0 ? '+' : ''}${frNum(R, 1)} R`, accent, [40, 70, 58]) + 10;
  if (capPct !== null) cx += chip(base, cx, chipsY, `${capPct >= 0 ? '+' : ''}${frNum(capPct)} % du capital`, COL.ink, COL.line) + 10;
  chip(base, cx, chipsY, `${mkPct >= 0 ? '+' : ''}${frNum(mkPct)} % sur le marché`, COL.ink, COL.line);

  // graphique
  const top = 226; const bottom = statsY - 46; const right = W - 92; const left = 22;
  const lows = C.map((c) => c.l); const highs = C.map((c) => c.h);
  const lo = Math.min(...lows, trade.exit, trade.sl, trade.entry);
  const hi = Math.max(...highs, trade.exit, trade.sl, trade.entry);
  const pad = (hi - lo) * 0.06 || 1;
  const Y = (v) => top + ((hi + pad - v) / (hi - lo + 2 * pad)) * (bottom - top);
  const step = (right - left) / Math.max(1, C.length);
  const X = (i) => left + (i + 0.5) * step;
  const iEntry = Math.max(0, C.findIndex((c) => c.t + data.sec > trade.entryT));
  let iExit = C.findIndex((c) => c.t + data.sec > trade.exitT);
  if (iExit < 0) iExit = C.length - 1;
  // échelle des prix (fixe)
  // graduations rondes (1, 2, 2,5 ou 5 × 10^n), 3 à 6 lignes
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const tickStep = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  for (let v = Math.ceil(lo / tickStep) * tickStep; v <= hi; v += tickStep) {
    const y = Y(v);
    base.line(left, y, right, y, COL.line, 1);
    if (![trade.entry, trade.sl, trade.exit].some((L) => Math.abs(Y(L) - y) < 16)) base.text(frNum(v, pxDigits(trade.market) === 5 ? 4 : 0), right + 8, y - 7, { size: 13, color: COL.mute });
  }
  // heures
  const every = Math.max(1, Math.round(C.length / 5));
  for (let i = every; i < C.length; i += every) base.text(data.sec >= 86400 ? new Date(C[i].t * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : hm(C[i].t), X(i), bottom + 8, { size: 13, color: COL.mute, align: 'center' });

  const total = Math.round(FPS * (ANIM_S + HOLD_S));
  const animN = FPS * ANIM_S;
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const bodyW = Math.max(1, step * 0.62);

  function frame(f) {
    const p = f >= animN ? 1 : ease(f / animN);
    const cv = cloneCanvas(base);
    const shown = p * C.length;
    const entered = shown > iEntry;
    const exited = shown > iExit + 0.6;
    const last = Math.max(0, Math.min(C.length - 1, Math.ceil(shown) - 1));
    // zone de gain / perte depuis l'entrée
    if (entered) {
      const to = exited ? iExit : last;
      // colonne par colonne de pixels (pas de rayures entre les bougies)
      const xa = Math.round(X(iEntry) - step / 2); const xb = Math.round(X(to) + step / 2);
      const y1 = Y(trade.entry);
      for (let x = xa; x < xb; x++) {
        const i = Math.min(to, Math.max(iEntry, Math.floor((x - left) / step)));
        const px = i === iExit && exited ? trade.exit : C[i].c;
        const good = long ? px > trade.entry : px < trade.entry;
        const y2 = Y(px);
        cv.fillRect(x, Math.min(y1, y2), 1, Math.abs(y2 - y1), good ? COL.gain : COL.loss, 0.13);
      }
      cv.line(X(iEntry) - step / 2, Y(trade.sl), right, Y(trade.sl), COL.loss, 1.2, 4);
      cv.line(X(iEntry) - step / 2, Y(trade.entry), right, Y(trade.entry), COL.level, 1.2);
    }
    // bougies
    for (let i = 0; i < C.length; i++) {
      const a = Math.max(0, Math.min(1, shown - i));
      if (a <= 0) break;
      const c = C[i];
      const col = c.c >= c.o ? COL.gain : COL.loss;
      const dim = i < iEntry || i > iExit ? 0.45 : 1;
      cv.line(X(i), Y(c.h), X(i), Y(c.l), col, 1, 0, a * dim);
      const y1 = Y(Math.max(c.o, c.c)); const y2 = Y(Math.min(c.o, c.c));
      cv.fillRect(X(i) - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1), col, a * dim);
    }
    // étiquettes des niveaux (à droite)
    const tag = (v, text, color, dy = 0) => {
      const y = Y(v) + dy;
      cv.roundRect(right + 4, y - 10, W - right - 10, 20, 4, color, 0.18);
      cv.text(text, right + 9, y - 7, { size: 13, color });
    };
    if (entered) {
      const close = Math.abs(Y(trade.sl) - Y(trade.entry)) < 22;
      tag(trade.sl, 'SL', COL.loss, close ? (Y(trade.sl) < Y(trade.entry) ? -11 : 11) : 0);
      tag(trade.entry, 'Entrée', COL.level, close ? (Y(trade.sl) < Y(trade.entry) ? 11 : -11) : 0);
      const ex = X(iEntry); const ey = Y(long ? C[iEntry].l : C[iEntry].h) + (long ? 10 : -10);
      cv.circle(ex, ey, 4.5, COL.level);
    }
    if (exited) {
      cv.circle(X(iExit), Y(trade.exit), 9, accent, 0.25);
      cv.circle(X(iExit), Y(trade.exit), 4.5, accent);
      tag(trade.exit, 'Sortie', accent);
    }
    // P&L qui compte
    let pnl = 0;
    if (entered) pnl = exited ? trade.pnl : (trade.notional || 0) * (long ? C[last].c / trade.entry - 1 : (trade.entry - C[last].c) / trade.entry);
    if (!trade.notional && entered && !exited) pnl = trade.pnl * Math.min(1, (shown - iEntry) / Math.max(1, iExit - iEntry));
    const shownPnl = exited ? trade.pnl : pnl;
    cv.text(usd(shownPnl), 28, 100, { style: 'b', size: 56, color: shownPnl >= 0 ? COL.gain : COL.loss });
    return cv;
  }
  return { frame: (f) => frame(f).px, frames: total, png: () => frame(total - 1).png() };
}

/* ------------------------------------------------------------------ */
/* Vidéo                                                               */
/* ------------------------------------------------------------------ */

/** Arguments complets de ffmpeg (exposés pour les tests). */
function ffmpegArgs(cfg, bgId, maskFile, outFile, seconds) {
  const bg = backgroundInput(cfg, bgId, seconds);
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...bg.args,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-loop', '1', '-t', seconds.toFixed(2), '-i', maskFile,
    '-filter_complex',
    `${bg.filter};[1:v]scale=${OUT_W}:${OUT_H}:flags=lanczos,format=rgba[card];[2:v]scale=${OUT_W}:${OUT_H},format=gray[mask];[card][mask]alphamerge[cardm];[bg][cardm]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[out]`,
    '-map', '[out]', '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', '-t', seconds.toFixed(2), outFile,
  ];
}

let chain = Promise.resolve();
let busy = 0;
/** Vidéo MP4 d'un trade (Buffer). Une seule à la fois ; refuse au-delà de 2 en attente. */
function makeVideo(cfg, trade, bgId, { fetcher } = {}) {
  if (busy >= 3) return Promise.reject(new Error('trop de vidéos en attente, réessaie dans une minute'));
  busy++;
  const job = chain.then(async () => {
    const bin = ffmpegPath();
    if (!bin) throw Object.assign(new Error('ffmpeg absent sur le serveur'), { code: 'NOFFMPEG' });
    const data = await candlesFor(trade, fetcher);
    if (data.candles.length < 5) throw new Error('bougies indisponibles pour ce trade');
    const card = prepareCard(trade, data);
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pnlv-'));
    const mask = path.join(dir, 'mask.png');
    const out = path.join(dir, 'video.mp4');
    fs.writeFileSync(mask, maskPng());
    const seconds = card.frames / FPS;
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn(bin, ffmpegArgs(cfg, bgId, mask, out, seconds), { stdio: ['pipe', 'ignore', 'pipe'] });
        let err = '';
        ff.stderr.on('data', (d) => { err += d; });
        const timer = setTimeout(() => ff.kill('SIGKILL'), 180_000);
        ff.on('error', reject);
        ff.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg : ${err.trim().split('\n').pop() || `code ${code}`}`)); });
        ff.stdin.on('error', () => { /* ffmpeg arrêté : l'erreur sort par « close » */ });
        (async () => {
          for (let f = 0; f < card.frames; f++) {
            if (!ff.stdin.write(card.frame(f))) await new Promise((r) => ff.stdin.once('drain', r));
          }
          ff.stdin.end();
        })().catch(reject);
      });
      return fs.readFileSync(out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  chain = job.catch(() => {}).finally(() => { busy--; });
  return job;
}

/** Image fixe de la carte (repli sans ffmpeg). */
async function cardPng(trade, { fetcher } = {}) {
  const data = await candlesFor(trade, fetcher);
  return prepareCard(trade, data).png();
}

/** Enregistre une vidéo de fond (Buffer) sous un nom ; 10 fonds au plus. */
function saveBackground(cfg, name, buf) {
  const n = safeName(name);
  if (!n) throw new Error('nom de fond invalide (lettres, chiffres, tirets)');
  fs.mkdirSync(fondsDir(cfg), { recursive: true });
  const existing = fs.readdirSync(fondsDir(cfg)).filter((f) => f.endsWith('.mp4'));
  if (existing.length >= 10 && !existing.includes(`${n}.mp4`)) throw new Error('10 fonds au plus : supprime-en un avec /fonds');
  fs.writeFileSync(path.join(fondsDir(cfg), `${n}.mp4`), buf);
  return n;
}
function deleteBackground(cfg, name) {
  try { fs.unlinkSync(path.join(fondsDir(cfg), `${safeName(name)}.mp4`)); return true; } catch { return false; }
}

module.exports = { makeVideo, cardPng, prepareCard, ffmpegArgs, ffmpegPath, backgrounds, saveBackground, deleteBackground, intervalFor, candlesFor, safeName, BUILTIN, SYMBOL };
