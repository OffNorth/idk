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
const FPS = 30;
const ANIM_S = 5;
const HOLD_S = 2.2;
const SYMBOL = { gold: 'GC=F', nas100: '^NDX', spx: '^GSPC', eurusd: 'EURUSD=X', silver: 'SI=F', dow: '^DJI', russell: '^RUT' };
const NAME = { gold: 'Or', nas100: 'Nasdaq 100', spx: 'S&P 500', eurusd: 'EUR/USD', silver: 'Argent', dow: 'Dow Jones', russell: 'Russell 2000' };
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
    if (p && fs.existsSync(p)) return p;
  } catch { /* paquet absent */ }
  return null;
}

const RELEASE = 'b6.0'; // même binaire que le paquet ffmpeg-static
let ready = null;
let lastError = '';
/**
 * Chemin de ffmpeg, en cherchant dans l'ordre : FFMPEG_PATH, paquet ffmpeg-static, copie du bot (data/bin/ffmpeg),
 * ffmpeg du système ; sinon le bot le télécharge lui-même (GitHub, binaire statique ≈ 30 Mo compressé) dans data/bin.
 * Le résultat est gardé ; en cas d'échec, une nouvelle tentative a lieu au prochain appel.
 */
function ensureFfmpeg(cfg) {
  if (ready) return ready;
  ready = (async () => {
    // FFMPEG_PATH réglé à la main : on n'utilise que lui
    if (process.env.FFMPEG_PATH) {
      if (fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
      throw new Error(`FFMPEG_PATH introuvable : ${process.env.FFMPEG_PATH}`);
    }
    const env = ffmpegPath();
    if (env) return env;
    const own = path.join(cfg.dataDir, 'bin', 'ffmpeg');
    if (fs.existsSync(own)) return own;
    try {
      const r = require('child_process').spawnSync('ffmpeg', ['-version'], { timeout: 10_000 });
      if (r.status === 0) return 'ffmpeg';
    } catch { /* pas de ffmpeg système */ }
    const os = require('os');
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-${os.platform()}-${os.arch()}.gz`;
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`téléchargement de ffmpeg impossible (HTTP ${res.status}, ${os.platform()}-${os.arch()})`);
    const bin = require('zlib').gunzipSync(Buffer.from(await res.arrayBuffer()));
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(`${own}.part`, bin, { mode: 0o755 });
    fs.renameSync(`${own}.part`, own);
    return own;
  })().then((p) => { lastError = ''; return p; }, (err) => {
    ready = null;
    lastError = String(err.cause?.code || err.message || err);
    throw Object.assign(new Error(`ffmpeg absent sur le serveur (${lastError})`), { code: 'NOFFMPEG' });
  });
  return ready;
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
function backgroundInput(cfg, id, seconds, tw = 1080, th = 1920) {
  const d = `${seconds.toFixed(2)}`;
  const k = tw / 1080; // tailles de la grille proportionnelles à la sortie
  if (id && id.startsWith('u:')) {
    const file = path.join(fondsDir(cfg), `${safeName(id.slice(2))}.mp4`);
    if (fs.existsSync(file)) {
      return { args: ['-threads', '1', '-stream_loop', '-1', '-t', d, '-i', file], filter: `[0:v]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},fps=30,eq=brightness=-0.12:saturation=0.85,setsar=1[bg]` };
    }
  }
  if (id === 'grille') {
    return {
      args: ['-f', 'lavfi', '-t', d, '-i', `color=c=0x0b0f14:s=${tw}x${th}:r=30`],
      filter: `[0:v]drawgrid=w=${Math.round(90 * k)}:h=${Math.round(90 * k)}:t=1:c=0x1b2633@1,scroll=v=0.0012:h=0.0006,drawgrid=w=${Math.round(270 * k)}:h=${Math.round(270 * k)}:t=2:c=0x22303d@1,setsar=1[bg]`,
    };
  }
  if (id === 'particules') {
    return {
      args: ['-f', 'lavfi', '-t', d, '-i', `life=s=${Math.round(tw / 4)}x${Math.round(th / 4)}:mold=24:r=10:ratio=0.08:death_color=0x0b0f14:life_color=0x1f3a33:mold_color=0x12201d,fps=30`],
      filter: `[0:v]scale=${tw}:${th}:flags=neighbor,setsar=1[bg]`,
    };
  }
  return { args: ['-f', 'lavfi', '-t', d, '-i', `color=c=0x0b0f14:s=${tw}x${th}:r=30`], filter: '[0:v]setsar=1[bg]' };
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

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const copyCanvas = (src) => { const c = Object.create(Canvas.prototype); c.w = src.w; c.h = src.h; c.px = Buffer.from(src.px); return c; };
/**
 * Calque transparent : chaque tracé est fait deux fois, en couleur (prémultipliée, sur noir) et en blanc sur le masque
 * d'opacité. rgba() rend l'image RGBA (couleur « dé-prémultipliée ») que ffmpeg superpose à la vidéo.
 * Le texte a une ombre portée noire pour rester lisible sur n'importe quelle vidéo.
 */
class Layer {
  constructor(w, h, from = null) {
    this.w = w; this.h = h;
    this.c = from ? copyCanvas(from.c) : new Canvas(w, h, BLACK);
    this.a = from ? copyCanvas(from.a) : new Canvas(w, h, BLACK);
  }
  clone() { return new Layer(this.w, this.h, this); }
  measure(...args) { return this.c.measure(...args); }
  fillRect(x, y, w, h, rgb, a = 1) { this.c.fillRect(x, y, w, h, rgb, a); this.a.fillRect(x, y, w, h, WHITE, a); }
  roundRect(x, y, w, h, r, rgb, a = 1) { this.c.roundRect(x, y, w, h, r, rgb, a); this.a.roundRect(x, y, w, h, r, WHITE, a); }
  circle(cx, cy, r, rgb, a = 1) { this.c.circle(cx, cy, r, rgb, a); this.a.circle(cx, cy, r, WHITE, a); }
  line(x0, y0, x1, y1, rgb, width = 1, dash = 0, a = 1) { this.c.line(x0, y0, x1, y1, rgb, width, dash, a); this.a.line(x0, y0, x1, y1, WHITE, width, dash, a); }
  text(str, x, y, opts = {}) {
    if (opts.shadow !== false) {
      const o = { ...opts, color: BLACK };
      this.c.text(str, x + 1.5, y + 2, o);
      this.a.text(str, x + 1.5, y + 2, { ...o, color: [150, 150, 150] }); // ombre à ≈ 60 %
    }
    this.a.text(str, x, y, { ...opts, color: WHITE });
    return this.c.text(str, x, y, opts);
  }
  rgba() {
    const n = this.w * this.h;
    const out = Buffer.alloc(n * 4);
    const c = this.c.px; const a = this.a.px;
    for (let i = 0; i < n; i++) {
      const al = a[i * 3];
      out[i * 4 + 3] = al;
      if (!al) continue;
      const k = 255 / al;
      out[i * 4] = Math.min(255, c[i * 3] * k);
      out[i * 4 + 1] = Math.min(255, c[i * 3 + 1] * k);
      out[i * 4 + 2] = Math.min(255, c[i * 3 + 2] * k);
    }
    return out;
  }
  /** Aperçu PNG : le calque posé sur un fond sombre. */
  png(bg = [11, 15, 20]) {
    const cv = new Canvas(this.w, this.h, bg);
    const rgba = this.rgba();
    for (let i = 0; i < this.w * this.h; i++) {
      const al = rgba[i * 4 + 3] / 255;
      if (!al) continue;
      cv.blend(i % this.w, Math.floor(i / this.w), [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]], al);
    }
    return cv.png();
  }
}
function chip(cv, x, y, text, color) {
  const w = cv.measure(text, 'r', 15) + 22;
  cv.roundRect(x, y, w, 28, 14, BLACK, 0.45);
  cv.text(text, x + 11, y + 6, { size: 15, color, shadow: false });
  return w;
}

/**
 * Prépare la carte d'un trade. trade : { market, sid, name, side, entry, exit, sl, entryT, exitT, pnl, risk,
 * account (« FTMO » / « Lucid »), program, capital }. Retourne { frame(p) → Buffer RGB, frames, png() }.
 */
function prepareCard(trade, data, { seconds = 0, handle = '' } = {}) {
  const C = data.candles;
  const long = trade.side === 'long';
  const win = trade.pnl >= 0;
  const accent = win ? COL.gain : COL.loss;
  const base = new Layer(W, H); // transparent : seuls les textes, bougies et niveaux sont visibles
  // en-tête
  // « DÉMO » : trades d'un compte simulé (paper trading du bot), à garder visible même une fois la vidéo partagée
  base.text(`${trade.account || 'FTMO'} · ${(trade.program || 'Challenge').toUpperCase()} · DÉMO`, 30, 26, { size: 13, color: COL.mute });
  base.text(day(trade.exitT), W - 30, 26, { size: 13, color: COL.mute, align: 'right' });
  const sideTxt = long ? 'ACHAT' : 'VENTE';
  const bw = base.measure(sideTxt, 'b', 15) + 24;
  base.roundRect(30, 58, bw, 28, 14, long ? COL.gain : COL.loss);
  base.text(sideTxt, 42, 63, { style: 'b', size: 15, color: COL.dark, shadow: false });
  const nw = base.text(NAME[trade.market] || trade.market, 30 + bw + 12, 60, { style: 'b', size: 22, color: COL.ink });
  base.text(`${data.interval} · ${trade.sid}`, 30 + bw + 24 + nw, 66, { size: 13, color: COL.mute, maxWidth: W - (30 + bw + 24 + nw) - 30 });
  // bas : niveaux, durée
  const statsY = H - 112;
  base.line(30, statsY - 14, W - 30, statsY - 14, WHITE, 1, 0, 0.25);
  const stats = [['ENTRÉE', frNum(trade.entry, pxDigits(trade.market))], ['SORTIE', frNum(trade.exit, pxDigits(trade.market))], ['STOP', frNum(trade.sl, pxDigits(trade.market))], ['DURÉE', dur(trade.exitT - trade.entryT)]];
  const colW = (W - 60) / 4;
  stats.forEach(([k, v], i) => {
    base.text(k, 30 + i * colW, statsY, { size: 13, color: COL.mute });
    base.text(v, 30 + i * colW, statsY + 20, { style: 'b', size: 18, color: COL.ink, maxWidth: colW - 6 });
  });
  // Signature (VIDEO_HANDLE ou /signature), centrée en bas
  if (handle) base.text(handle, W / 2, H - 46, { style: 'b', size: 22, color: COL.ink, align: 'center', maxWidth: W - 60 });
  // puces fixes
  const R = trade.risk > 0 ? trade.pnl / trade.risk : null;
  const capPct = trade.capital ? (trade.pnl / trade.capital) * 100 : null;
  const mkPct = (trade.exit / trade.entry - 1) * 100;
  let cx = 30;
  const chipsY = 176;
  if (R !== null) cx += chip(base, cx, chipsY, `${R >= 0 ? '+' : ''}${frNum(R, 1)} R`, accent) + 10;
  if (capPct !== null) cx += chip(base, cx, chipsY, `${capPct >= 0 ? '+' : ''}${frNum(capPct)} % du capital`, COL.ink) + 10;
  chip(base, cx, chipsY, `${mkPct >= 0 ? '+' : ''}${frNum(mkPct)} % sur le marché`, COL.ink);

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
    base.line(left, y, right, y, WHITE, 1, 0, 0.12);
    if (![trade.entry, trade.sl, trade.exit].some((L) => Math.abs(Y(L) - y) < 16)) base.text(frNum(v, pxDigits(trade.market) === 5 ? 4 : 0), right + 8, y - 7, { size: 13, color: COL.mute });
  }
  // heures
  const every = Math.max(1, Math.round(C.length / 5));
  for (let i = every; i < C.length; i += every) base.text(data.sec >= 86400 ? new Date(C[i].t * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : hm(C[i].t), X(i), bottom + 8, { size: 13, color: COL.mute, align: 'center' });

  // Durée de l'animation calée sur la vidéo : les bougies défilent jusqu'à la fin, avec une courte pause sur le
  // résultat (10 % de la vidéo, entre 1,5 et 3 s). Vidéo courte (≤ 7,2 s) : 5 s d'animation + 2,2 s de pause.
  const totalS = Math.max(ANIM_S + HOLD_S, seconds || 0);
  const total = Math.round(FPS * totalS);
  const holdS = totalS > ANIM_S + HOLD_S ? Math.min(3, Math.max(1.5, totalS * 0.1)) : HOLD_S;
  const animN = Math.round(FPS * Math.max(ANIM_S, totalS - holdS));
  // Animation longue : rythme plus régulier (sinon presque toutes les bougies arrivent dans les premières secondes)
  const ease = animN > FPS * 8 ? (x) => 1 - Math.pow(1 - x, 1.6) : (x) => 1 - Math.pow(1 - x, 3);
  const bodyW = Math.max(1, step * 0.62);

  function frame(f) {
    const p = f >= animN ? 1 : ease(f / animN);
    const cv = base.clone();
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
        cv.fillRect(x, Math.min(y1, y2), 1, Math.abs(y2 - y1), good ? COL.gain : COL.loss, 0.2);
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
      cv.roundRect(right + 4, y - 10, W - right - 10, 20, 4, BLACK, 0.5);
      cv.text(text, right + 9, y - 7, { size: 13, color, shadow: false });
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
  return { frame: (f) => frame(f).rgba(), frames: total, animFrames: animN, png: () => frame(total - 1).png() };
}

/* ------------------------------------------------------------------ */
/* Vidéo                                                               */
/* ------------------------------------------------------------------ */

/** Durée, taille (rotation comprise) et son d'une vidéo, lus par ffmpeg. */
function probe(bin, file) {
  return new Promise((resolve) => {
    const ff = spawn(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('close', () => {
      const d = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
      const v = err.match(/Video: [^\n]*?(\d{2,5})x(\d{2,5})/);
      const rot = err.match(/rotat(?:e\s*:\s*|ion of )(-?\d+)/);
      let w = v ? Number(v[1]) : 1080; let h = v ? Number(v[2]) : 1920;
      if (rot && Math.abs(Number(rot[1])) % 180 === 90) [w, h] = [h, w];
      resolve({ duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0, w, h, audio: /Audio: /.test(err) });
    });
    ff.on('error', () => resolve({ duration: 0, w: 1080, h: 1920, audio: false }));
  });
}

/** Format de sortie selon la vidéo source : vertical 1080×1920, horizontal 1920×1080 ou carré 1080×1080. */
/**
 * Format de sortie : vertical, horizontal ou carré selon la vidéo source, petit côté `short` pixels (720 par défaut :
 * l'encodage en 1080×1920 demande trop de mémoire aux petits serveurs ; VIDEO_SHORT pour changer).
 */
function targetFor(src, short = 720) {
  const long = Math.round((short * 16) / 9 / 2) * 2;
  if (!src) return { tw: short, th: long };
  const r = src.w / src.h;
  return r > 1.15 ? { tw: long, th: short } : r < 0.87 ? { tw: short, th: long } : { tw: short, th: short };
}
/** Réglages d'encodage, du plus beau au plus léger (repli si le serveur coupe ffmpeg faute de mémoire). */
const LEVELS = [
  { short: Number(process.env.VIDEO_SHORT) || 720, preset: 'veryfast', threads: 2 },
  { short: 540, preset: 'ultrafast', threads: 1 },
];
/** Taille de la carte (4:5) : 90 % de la largeur, 82 % de la hauteur au plus ; dimensions paires. */
function cardSize(tw, th) {
  let cw = tw * 0.9; let ch = cw * (H / W);
  if (ch > th * 0.82) { ch = th * 0.82; cw = ch * (W / H); }
  return { cw: Math.round(cw / 2) * 2, ch: Math.round(ch / 2) * 2 };
}

/**
 * Arguments complets de ffmpeg (exposés pour les tests). bg : fond intégré, fond enregistré « u:nom », ou
 * { file } (vidéo envoyée au bot, gardée telle quelle : format, son).
 */
function ffmpegArgs(cfg, bgId, outFile, seconds, src = null, level = LEVELS[0]) {
  const { tw, th } = targetFor(src, level.short);
  const { cw, ch } = cardSize(tw, th);
  let bg;
  if (src && src.file) {
    bg = { args: ['-threads', '1', '-stream_loop', '-1', '-t', seconds.toFixed(2), '-i', src.file], filter: `[0:v]scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th},fps=30,eq=brightness=-0.08,setsar=1[bg]` };
  } else {
    bg = backgroundInput(cfg, bgId, seconds, tw, th);
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
    ...bg.args,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-filter_complex', `${bg.filter};[1:v]scale=${cw}:${ch}:flags=lanczos,format=rgba[card];[bg][card]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p[out]`,
    '-map', '[out]', ...(src && src.audio ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k'] : []),
    '-r', String(FPS), '-c:v', 'libx264', '-preset', level.preset, '-crf', '22', '-threads', String(level.threads), '-x264-params', 'rc-lookahead=10:ref=1:bframes=1',
    '-movflags', '+faststart', '-t', seconds.toFixed(2), outFile,
  ];
}

/** Un encodage : images de la carte envoyées à ffmpeg ; rejette avec { killed, signal } si le système l'arrête. */
async function encode(bin, cfg, bgId, card, src, level) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pnlv-'));
  const out = path.join(dir, 'video.mp4');
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn(bin, ffmpegArgs(cfg, bgId, out, card.frames / FPS, src, level), { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ff.kill('SIGKILL'); }, 240_000);
      ff.on('error', reject);
      ff.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        if (timedOut) return reject(new Error('ffmpeg trop long (plus de 4 min)'));
        if (signal || code === null) return reject(Object.assign(new Error(`ffmpeg arrêté (${signal || 'signal'})`), { killed: true, signal: signal || 'SIGKILL' }));
        return reject(new Error(`ffmpeg : ${err.trim().split('\n').pop() || `code ${code}`}`));
      });
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
}

let chain = Promise.resolve();
let busy = 0;
/**
 * Vidéo MP4 d'un trade (Buffer). bgId : fond intégré ou « u:nom » ; sourceFile : vidéo envoyée au bot sur laquelle
 * poser la carte transparente (sa durée, 30 s au plus, et son son sont gardés). Une seule vidéo à la fois.
 */
function makeVideo(cfg, trade, bgId, { fetcher, sourceFile, handle = '', light = false } = {}) {
  if (busy >= 3) return Promise.reject(new Error('trop de vidéos en attente, réessaie dans une minute'));
  busy++;
  const job = chain.then(async () => {
    const bin = await ensureFfmpeg(cfg);
    const data = await candlesFor(trade, fetcher);
    if (data.candles.length < 5) throw new Error('bougies indisponibles pour ce trade');
    let src = null;
    if (sourceFile) src = { file: sourceFile, ...(await probe(bin, sourceFile)) };
    const seconds = Math.min(30, Math.max(ANIM_S + HOLD_S, src?.duration || 0));
    const card = prepareCard(trade, data, { seconds, handle });
    let lastErr = null;
    // light : la vidéo précédente n'a pas abouti (bot coupé pendant la préparation) → directement en qualité allégée
    for (const level of light ? LEVELS.slice(1) : LEVELS) {
      try {
        return await encode(bin, cfg, bgId, card, src, level);
      } catch (err) {
        lastErr = err;
        if (!err.killed) throw err; // erreur de ffmpeg (fichier illisible…) : inutile de réessayer
        console.warn(`[vidéo] ffmpeg coupé (${err.signal}) en ${level.short} px, nouvel essai plus léger`);
      }
    }
    throw new Error(`ffmpeg arrêté par le serveur (${lastErr.signal}) même en 540 px : mémoire du serveur probablement insuffisante`);
  });
  chain = job.catch(() => {}).finally(() => { busy--; });
  return job;
}

/** Image fixe de la carte (repli sans ffmpeg). */
async function cardPng(trade, { fetcher, handle = '' } = {}) {
  const data = await candlesFor(trade, fetcher);
  return prepareCard(trade, data, { handle }).png();
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

module.exports = { LEVELS, resetFfmpeg: () => { ready = null; }, makeVideo, cardPng, prepareCard, ffmpegArgs, ffmpegPath, ensureFfmpeg, probe, targetFor, cardSize, backgrounds, saveBackground, deleteBackground, intervalFor, candlesFor, safeName, BUILTIN, SYMBOL };
