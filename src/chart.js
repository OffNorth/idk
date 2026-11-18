/**
 * Graphique d'évolution du portefeuille en PNG (Telegram n'affiche pas le SVG), thème sombre :
 * titre, courbes de capital par stratégie, axes, et légende écrite dans l'image (src/draw.js).
 */
const { Canvas, THEME } = require('./draw');

/** Couleurs des courbes, associées aux carrés emoji utilisés dans les légendes Telegram. */
const PALETTE = [
  { rgb: [239, 68, 68], emoji: '🟥' },
  { rgb: [59, 130, 246], emoji: '🟦' },
  { rgb: [34, 197, 94], emoji: '🟩' },
  { rgb: [249, 115, 22], emoji: '🟧' },
  { rgb: [168, 85, 247], emoji: '🟪' },
  { rgb: [234, 179, 8], emoji: '🟨' },
  { rgb: [180, 120, 60], emoji: '🟫' },
  { rgb: [236, 72, 153], emoji: '🩷' },
  { rgb: [6, 182, 212], emoji: '🩵' },
  // 2e série : mêmes teintes plus foncées, en pointillés (légende en ronds)
  { rgb: [185, 28, 28], emoji: '🔴', dash: 9 },
  { rgb: [37, 99, 235], emoji: '🔵', dash: 9 },
  { rgb: [21, 128, 61], emoji: '🟢', dash: 9 },
  { rgb: [194, 65, 12], emoji: '🟠', dash: 9 },
  { rgb: [126, 34, 206], emoji: '🟣', dash: 9 },
  { rgb: [161, 98, 7], emoji: '🟡', dash: 9 },
  { rgb: [120, 72, 30], emoji: '🟤', dash: 9 },
];
const REFERENCE = { rgb: [160, 170, 184], emoji: '⬜' };

function niceStep(range, target = 5) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

const fmtMoney = (v) => (Math.abs(v) >= 100_000 ? `$${Math.round(v / 1000).toLocaleString('fr-FR')}k` : `$${Math.round(v).toLocaleString('fr-FR')}`);
const fmtPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1).replace('.', ',')} %`;

/**
 * Zone de graphique (axes + grille + courbes) dans un rectangle de la toile.
 * series : [{ points: [{t, v}], rgb, dash?, reference? }]
 */
function drawSeries(cv, series, box, { baseline = null, log = false, money = fmtMoney, axisFont = 13 } = {}) {
  const { x, y, w, h } = box;
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) {
    cv.text('Pas encore assez de points : la courbe se remplit au fil des heures.', x + w / 2, y + h / 2 - 8, { size: 15, color: THEME.muted, align: 'center' });
    return;
  }
  const f = log ? (v) => Math.log10(Math.max(v, 1e-9)) : (v) => v;
  let tMin = Infinity;
  let tMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const p of pts) {
    tMin = Math.min(tMin, p.t);
    tMax = Math.max(tMax, p.t);
    vMin = Math.min(vMin, f(p.v));
    vMax = Math.max(vMax, f(p.v));
  }
  if (baseline !== null) {
    vMin = Math.min(vMin, f(baseline));
    vMax = Math.max(vMax, f(baseline));
  }
  if (tMax === tMin) tMax = tMin + 3600;
  if (!log && vMax - vMin < Math.abs(vMax) * 0.02) {
    const mid = (vMax + vMin) / 2;
    vMin = mid * 0.99;
    vMax = mid * 1.01;
  }
  const pad = (vMax - vMin) * 0.06 || 1;
  vMin -= pad;
  vMax += pad;
  const L = x + 64;
  const R = x + w - 6;
  const T = y + 6;
  const B = y + h - 24;
  const X = (t) => L + ((t - tMin) / (tMax - tMin)) * (R - L);
  const Y = (v) => T + (1 - (f(v) - vMin) / (vMax - vMin)) * (B - T);

  const hline = (v) => {
    cv.line(L, Y(v), R, Y(v), THEME.border, 1);
    cv.text(money(v), L - 8, Y(v) - axisFont / 2 - 1, { size: axisFont, color: THEME.muted, align: 'right' });
  };
  if (log) {
    for (let e = Math.floor(vMin); e <= Math.ceil(vMax); e++) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (Math.log10(v) >= vMin && Math.log10(v) <= vMax) hline(v);
      }
    }
  } else {
    const step = niceStep(vMax - vMin);
    for (let v = Math.ceil(vMin / step) * step; v <= vMax; v += step) hline(v);
  }
  const span = tMax - tMin;
  for (let k = 0; k <= 4; k++) {
    const t = tMin + (span * k) / 4;
    const d = new Date(t * 1000);
    const label = span > 400 * 86400
      ? String(d.getUTCFullYear())
      : span > 2 * 86400
        ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' })
        : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    cv.text(label, X(t), B + 7, { size: axisFont, color: THEME.muted, align: k === 0 ? 'left' : k === 4 ? 'right' : 'center' });
  }
  if (baseline !== null) cv.line(L, Y(baseline), R, Y(baseline), THEME.muted, 1, 5, 0.7);

  // La référence d'abord (en dessous), puis les stratégies
  for (const s of [...series].sort((a, b) => (b.reference ? 1 : 0) - (a.reference ? 1 : 0))) {
    const p = s.points.map((q) => [X(q.t), Y(q.v)]);
    if (p.length === 1) cv.circle(p[0][0], p[0][1], 3, s.rgb);
    if (s.fill) cv.area(p, B, s.rgb);
    cv.polyline(p, s.reference ? REFERENCE.rgb : s.rgb, s.reference ? 2 : s.width || 2.6, s.reference ? 6 : s.dash || 0);
  }
  return { X, Y, L, R, T, B };
}

/**
 * @param {Array<{points: Array<{t:number, v:number}>, rgb:number[], reference?:boolean, dash?:number}>} series
 * @param {{width?:number, height?:number, baseline?:number, title?:string, subtitle?:string, log?:boolean,
 *          legend?: Array<{label:string, value?:string, valueColor?:number[], rgb:number[], dash?:number, reference?:boolean}>}} opts
 * @returns {Buffer} PNG
 */
function renderEquityChart(series, { width = 1000, height = 560, baseline = null, title = '', subtitle = '', legend = [], log = false } = {}) {
  const cols = 2;
  const legendRows = Math.ceil(legend.length / cols);
  const head = title ? (subtitle ? 78 : 56) : 0;
  const legendH = legend.length ? 18 + legendRows * 30 : 0;
  const cv = new Canvas(width, height + head + legendH, THEME.bg);
  if (title) cv.text(title, 28, 18, { style: 'b', size: 28, color: THEME.text, maxWidth: width - 56 });
  if (subtitle) cv.text(subtitle, 28, 54, { size: 15, color: THEME.muted, maxWidth: width - 56 });
  drawSeries(cv, series, { x: 20, y: head, w: width - 44, h: height - 12 }, { baseline, log });

  if (legend.length) {
    const y0 = head + height + 4;
    const colW = (width - 56) / cols;
    legend.forEach((l, k) => {
      const cx = 28 + (k % cols) * colW;
      const cy = y0 + Math.floor(k / cols) * 30;
      const rgb = l.reference ? REFERENCE.rgb : l.rgb;
      if (l.dash || l.reference) cv.line(cx, cy + 10, cx + 22, cy + 10, rgb, 3, 5);
      else cv.roundRect(cx, cy + 4, 22, 12, 3, rgb);
      const vw = l.value ? cv.measure(l.value, 'b', 15) : 0;
      cv.text(l.label, cx + 32, cy + 1, { size: 15, color: THEME.text, maxWidth: colW - 52 - vw });
      if (l.value) cv.text(l.value, cx + colW - 16, cy + 1, { style: 'b', size: 15, color: l.valueColor || THEME.text, align: 'right' });
    });
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

module.exports = { renderEquityChart, drawSeries, downsample, niceStep, fmtMoney, fmtPct, PALETTE, REFERENCE };
