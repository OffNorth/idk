/**
 * Graphique d'évolution du portefeuille en PNG, sans dépendance (Telegram n'affiche pas le SVG).
 * Courbes de capital par stratégie + axes avec une petite police bitmap pour les montants et les dates.
 */
const zlib = require('zlib');

/** Couleurs des courbes, associées aux carrés emoji utilisés pour la légende dans Telegram. */
const PALETTE = [
  { rgb: [220, 38, 38], emoji: '🟥' },
  { rgb: [37, 99, 235], emoji: '🟦' },
  { rgb: [22, 163, 74], emoji: '🟩' },
  { rgb: [234, 88, 12], emoji: '🟧' },
  { rgb: [147, 51, 234], emoji: '🟪' },
  { rgb: [202, 160, 0], emoji: '🟨' },
  { rgb: [133, 77, 14], emoji: '🟫' },
  { rgb: [236, 72, 153], emoji: '🩷' },
  { rgb: [6, 182, 212], emoji: '🩵' },
];
const REFERENCE = { rgb: [90, 90, 90], emoji: '⬛' };

/* Police 3×5 (chaque ligne = 3 bits) pour chiffres et quelques symboles. */
const FONT = {
  0: [7, 5, 5, 5, 7], 1: [2, 6, 2, 2, 7], 2: [7, 1, 7, 4, 7], 3: [7, 1, 7, 1, 7], 4: [5, 5, 7, 1, 1],
  5: [7, 4, 7, 1, 7], 6: [7, 4, 7, 5, 7], 7: [7, 1, 2, 2, 2], 8: [7, 5, 7, 5, 7], 9: [7, 5, 7, 1, 7],
  '$': [7, 6, 7, 3, 7], '%': [5, 1, 2, 4, 5], '.': [0, 0, 0, 0, 2], '-': [0, 0, 7, 0, 0], '+': [0, 2, 7, 2, 0],
  '/': [1, 1, 2, 4, 4], k: [4, 5, 6, 5, 5], ' ': [0, 0, 0, 0, 0],
};

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = Buffer.alloc(w * h * 3, 255);
  }

  set(x, y, [r, g, b]) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
  }

  line(x0, y0, x1, y1, color, width = 1, dash = 0) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      if (dash && Math.floor(s / dash) % 2) continue;
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      for (let dx = 0; dx < width; dx++) for (let dy = 0; dy < width; dy++) this.set(x + dx - (width >> 1), y + dy - (width >> 1), color);
    }
  }

  text(str, x, y, color, scale = 2, align = 'left') {
    const w = str.length * 4 * scale - scale;
    let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    for (const ch of str) {
      const g = FONT[ch];
      if (g) {
        g.forEach((row, ry) => {
          for (let rx = 0; rx < 3; rx++) {
            if (!(row & (4 >> rx))) continue;
            for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) this.set(cx + rx * scale + a, y + ry * scale + b, color);
          }
        });
      }
      cx += 4 * scale;
    }
  }

  png() {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 3 + 1)] = 0;
      this.px.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8; // profondeur
    ihdr[9] = 2; // RGB
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

const fmtMoney = (v) => (Math.abs(v) >= 10_000 ? `$${(v / 1000).toFixed(0)}k` : `$${v.toFixed(0)}`);

/**
 * @param {Array<{points: Array<{t:number, v:number}>, rgb:number[], reference?:boolean}>} series
 * @param {{width?:number, height?:number, baseline?:number}} opts  baseline = capital de départ (ligne pointillée)
 * @returns {Buffer} PNG
 */
function renderEquityChart(series, { width = 900, height = 500, baseline = null } = {}) {
  const cv = new Canvas(width, height);
  const L = 90;
  const R = 20;
  const T = 20;
  const B = 40;
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return cv.png();
  let tMin = Math.min(...pts.map((p) => p.t));
  let tMax = Math.max(...pts.map((p) => p.t));
  if (tMax === tMin) tMax = tMin + 3600;
  let vMin = Math.min(...pts.map((p) => p.v), baseline ?? Infinity);
  let vMax = Math.max(...pts.map((p) => p.v), baseline ?? -Infinity);
  const pad = (vMax - vMin) * 0.08 || Math.max(1, vMax * 0.01);
  vMin -= pad;
  vMax += pad;
  const X = (t) => L + ((t - tMin) / (tMax - tMin)) * (width - L - R);
  const Y = (v) => T + (1 - (v - vMin) / (vMax - vMin)) * (height - T - B);
  const grid = [228, 228, 228];
  const axis = [120, 120, 120];
  const ink = [60, 60, 60];

  // grille horizontale + montants
  const step = niceStep(vMax - vMin);
  for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) {
    cv.line(L, Y(v), width - R, Y(v), grid);
    cv.text(fmtMoney(v), L - 8, Y(v) - 5, ink, 2, 'right');
  }
  // dates sur l'axe horizontal
  const span = tMax - tMin;
  for (let k = 0; k <= 4; k++) {
    const t = tMin + (span * k) / 4;
    const d = new Date(t * 1000);
    const label = span > 400 * 86400
      ? `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCFullYear()).slice(2)}`
      : `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    cv.line(X(t), T, X(t), height - B, grid);
    cv.text(label, X(t), height - B + 10, ink, 2, k === 0 ? 'left' : k === 4 ? 'right' : 'center');
  }
  cv.line(L, T, L, height - B, axis);
  cv.line(L, height - B, width - R, height - B, axis);
  if (baseline !== null) cv.line(L, Y(baseline), width - R, Y(baseline), axis, 1, 6);

  // courbes : la référence d'abord (en dessous), puis les stratégies
  for (const s of [...series].sort((a, b) => (b.reference ? 1 : 0) - (a.reference ? 1 : 0))) {
    const p = s.points;
    for (let i = 1; i < p.length; i++) cv.line(X(p[i - 1].t), Y(p[i - 1].v), X(p[i].t), Y(p[i].v), s.rgb, s.reference ? 2 : 3, s.reference ? 5 : 0);
    if (p.length === 1) cv.line(X(p[0].t) - 2, Y(p[0].v), X(p[0].t) + 2, Y(p[0].v), s.rgb, 3);
  }
  return cv.png();
}

/** Réduit une courbe à ~maxPoints points (garde le premier et le dernier). */
function downsample(points, maxPoints = 600) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

module.exports = { renderEquityChart, downsample, PALETTE, REFERENCE };
