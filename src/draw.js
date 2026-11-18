/**
 * Moteur d'images PNG sans dépendance : rectangles arrondis, traits lissés (anticrénelage), cercles et texte
 * avec une vraie police (DejaVu Sans pré-rendue dans src/font-data.json par scripts/make-font.py).
 */
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

/* ------------------------------------------------------------------ */
/* Police                                                              */
/* ------------------------------------------------------------------ */

let FONTS = null;
function fonts() {
  if (FONTS) return FONTS;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'font-data.json'), 'utf8'));
  FONTS = {};
  for (const [name, f] of Object.entries(raw.fonts)) {
    FONTS[name] = { ...f, atlas: zlib.inflateSync(Buffer.from(f.atlas, 'base64')) };
  }
  return FONTS;
}

/** Police la plus proche : style 'r' (normal) ou 'b' (gras), taille en pixels. */
function font(style, size) {
  const all = fonts();
  let best = null;
  for (const [name, f] of Object.entries(all)) {
    if (name[0] !== style) continue;
    if (!best || Math.abs(f.size - size) < Math.abs(best.size - size)) best = f;
  }
  return best;
}

/** Retire les caractères absents de la police (emojis…) et les espaces en trop. */
function clean(str, f = font('r', 15)) {
  return String(str ?? '')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .split('')
    .map((ch) => (f.glyphs[ch] ? ch : ch === ' ' || ch === ' ' ? ' ' : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ */
/* Toile                                                               */
/* ------------------------------------------------------------------ */

class Canvas {
  constructor(w, h, bg = [255, 255, 255]) {
    this.w = Math.round(w);
    this.h = Math.round(h);
    this.px = Buffer.alloc(this.w * this.h * 3);
    for (let i = 0; i < this.w * this.h; i++) {
      this.px[i * 3] = bg[0];
      this.px[i * 3 + 1] = bg[1];
      this.px[i * 3 + 2] = bg[2];
    }
  }

  /** Mélange une couleur sur un pixel avec une opacité a (0..1). */
  blend(x, y, rgb, a) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (a >= 1) {
      this.px[i] = rgb[0];
      this.px[i + 1] = rgb[1];
      this.px[i + 2] = rgb[2];
      return;
    }
    this.px[i] += (rgb[0] - this.px[i]) * a;
    this.px[i + 1] += (rgb[1] - this.px[i + 1]) * a;
    this.px[i + 2] += (rgb[2] - this.px[i + 2]) * a;
  }

  fillRect(x, y, w, h, rgb, a = 1) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w));
    const y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, rgb, a);
  }

  /** Rectangle aux coins arrondis (bords lissés). */
  roundRect(x, y, w, h, r, rgb, a = 1) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    for (let yy = y0; yy < Math.ceil(y + h); yy++) {
      for (let xx = x0; xx < Math.ceil(x + w); xx++) {
        const px = xx + 0.5;
        const py = yy + 0.5;
        const dx = Math.max(x + r - px, 0, px - (x + w - r));
        const dy = Math.max(y + r - py, 0, py - (y + h - r));
        let cov;
        if (dx > 0 && dy > 0) cov = Math.min(1, Math.max(0, r - Math.hypot(dx, dy) + 0.5));
        else cov = Math.min(1, Math.max(0, Math.min(px - x, x + w - px, py - y, y + h - py) + 0.5));
        this.blend(xx, yy, rgb, cov * a);
      }
    }
  }

  circle(cx, cy, r, rgb, a = 1) {
    for (let yy = Math.floor(cy - r - 1); yy <= Math.ceil(cy + r + 1); yy++) {
      for (let xx = Math.floor(cx - r - 1); xx <= Math.ceil(cx + r + 1); xx++) {
        const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
        this.blend(xx, yy, rgb, Math.min(1, Math.max(0, r - d + 0.5)) * a);
      }
    }
  }

  /** Segment lissé d'épaisseur `width` ; `dash` = longueur des tirets en pixels (0 = plein). */
  line(x0, y0, x1, y1, rgb, width = 1, dash = 0, a = 1) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (dash > 0 && len > dash) {
      for (let s = 0; s < len; s += dash * 2) {
        const e = Math.min(len, s + dash);
        this.line(x0 + ((x1 - x0) * s) / len, y0 + ((y1 - y0) * s) / len, x0 + ((x1 - x0) * e) / len, y0 + ((y1 - y0) * e) / len, rgb, width, 0, a);
      }
      return;
    }
    const hw = width / 2;
    const minX = Math.floor(Math.min(x0, x1) - hw - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + hw + 1);
    const minY = Math.floor(Math.min(y0, y1) - hw - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + hw + 1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1;
    for (let yy = Math.max(0, minY); yy <= Math.min(this.h - 1, maxY); yy++) {
      for (let xx = Math.max(0, minX); xx <= Math.min(this.w - 1, maxX); xx++) {
        const px = xx + 0.5;
        const py = yy + 0.5;
        const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / l2));
        const d = Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
        const cov = Math.min(1, Math.max(0, hw - d + 0.5));
        if (cov > 0) this.blend(xx, yy, rgb, cov * a);
      }
    }
  }

  /** Ligne brisée (courbe), points [[x, y]…]. */
  polyline(points, rgb, width = 2, dash = 0) {
    for (let i = 1; i < points.length; i++) this.line(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], rgb, width, dash);
  }

  /** Surface sous une courbe jusqu'à `baseY` (dégradé vertical vers transparent). */
  area(points, baseY, rgb, alpha = 0.18) {
    if (points.length < 2) return;
    const top = Math.min(...points.map((p) => p[1]));
    for (let i = 1; i < points.length; i++) {
      const [xa, ya] = points[i - 1];
      const [xb, yb] = points[i];
      for (let x = Math.ceil(xa); x < xb; x++) {
        const y = ya + ((yb - ya) * (x - xa)) / (xb - xa || 1);
        for (let yy = Math.ceil(y); yy < baseY; yy++) this.blend(x, yy, rgb, alpha * (1 - (yy - top) / Math.max(1, baseY - top)));
      }
    }
  }

  /** Largeur d'un texte. */
  measure(str, style = 'r', size = 15) {
    const f = font(style, size);
    let w = 0;
    for (const ch of clean(str, f)) w += f.glyphs[ch] ? f.glyphs[ch][0] : 0;
    return w;
  }

  /**
   * Texte. (x, y) = coin haut-gauche de la ligne (ou droite / centre selon align).
   * Retourne la largeur dessinée.
   */
  text(str, x, y, { style = 'r', size = 15, color = [0, 0, 0], align = 'left', maxWidth = Infinity } = {}) {
    const f = font(style, size);
    let s = clean(str, f);
    let w = this.measure(s, style, size);
    if (w > maxWidth) {
      while (s.length > 1 && this.measure(`${s}…`, style, size) > maxWidth) s = s.slice(0, -1);
      s = `${s.trimEnd()}…`;
      w = this.measure(s, style, size);
    }
    let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    for (const ch of s) {
      const g = f.glyphs[ch];
      if (!g) continue;
      const [adv, left, top, gw, gh, off] = g;
      const ox = Math.round(cx + left);
      const oy = Math.round(y + top);
      for (let j = 0; j < gh; j++) {
        for (let k = 0; k < gw; k++) {
          const a = f.atlas[off + j * gw + k];
          if (a) this.blend(ox + k, oy + j, color, a / 255);
        }
      }
      cx += adv;
    }
    return w;
  }

  /** Découpe un texte en lignes de largeur maximale `maxWidth`. */
  wrap(str, maxWidth, style = 'r', size = 15) {
    const words = clean(str, font(style, size)).split(' ');
    const lines = [];
    let cur = '';
    for (const word of words) {
      const next = cur ? `${cur} ${word}` : word;
      if (this.measure(next, style, size) <= maxWidth || !cur) cur = next;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    if (cur) lines.push(cur);
    return lines;
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
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
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

/** Couleurs du thème sombre (mêmes que le site Marchés). */
const THEME = {
  bg: [11, 15, 20],
  surface: [18, 25, 33],
  surface2: [25, 34, 44],
  border: [35, 45, 57],
  text: [232, 238, 244],
  muted: [141, 154, 171],
  up: [34, 197, 94],
  down: [240, 82, 82],
  gold: [245, 184, 74],
  accent: [124, 196, 255],
};

module.exports = { Canvas, THEME, clean, font };
