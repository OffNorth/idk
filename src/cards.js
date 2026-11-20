/**
 * Images envoyées dans le groupe (boutons sous les messages) : graphique du cours avec les niveaux d'un trade,
 * carte d'un trade, fiche d'une stratégie, classement, positions ouvertes, tableau des scores du jeu.
 * Thème sombre, police DejaVu (src/draw.js), aucune dépendance.
 */
const { Canvas, THEME } = require('./draw');
const { drawSeries, niceStep } = require('./chart');

const W = 1000;
const money = (v, d = 0) => (v == null || !Number.isFinite(v) ? 'n/d' : `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })}`);
const price = (v) => money(v, Math.abs(v) >= 1000 ? 0 : Math.abs(v) < 10 ? 4 : 2);
const pct = (v, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d).replace('.', ',')} %`;
const tone = (v) => (v > 0 ? THEME.up : v < 0 ? THEME.down : THEME.text);
const date = (t) => new Date(t * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateTime = (t) => new Date(t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
function duration(sec) {
  const h = sec / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0).replace('.', ',')} h`;
  return `${Math.round(h / 24)} jours`;
}

/** En-tête commun : pastille du marché, titre, sous-titre. */
function header(cv, { market, title, subtitle }) {
  const tag = market ? market.name.toUpperCase() : '';
  let x = 28;
  if (tag) {
    const tw = cv.measure(tag, 'b', 15);
    cv.roundRect(x, 22, tw + 24, 28, 14, market.id === 'gold' ? [74, 56, 16] : [22, 50, 86]);
    cv.text(tag, x + 12, 27, { style: 'b', size: 15, color: market.id === 'gold' ? THEME.gold : THEME.accent });
    x += tw + 36;
  }
  cv.text(title, x, 21, { style: 'b', size: 28, color: THEME.text, maxWidth: W - x - 28 });
  if (subtitle) cv.text(subtitle, 28, 62, { size: 15, color: THEME.muted, maxWidth: W - 56 });
}

function footer(cv, text = 'Paper trading · argent fictif · pas un conseil financier') {
  cv.text(text, W - 24, cv.h - 26, { size: 13, color: THEME.muted, align: 'right' });
}

/* ------------------------------------------------------------------ */
/* Graphique en bougies avec niveaux (entrée, stop, objectif)           */
/* ------------------------------------------------------------------ */

/**
 * Bougies dans un rectangle, avec lignes horizontales étiquetées et repères.
 * levels  : [{ price, label, rgb, dash }]
 * markers : [{ t, price, rgb, label }]
 */
function drawCandles(cv, candles, box, { levels = [], markers = [] } = {}) {
  const { x, y, w, h } = box;
  if (!candles?.length) {
    cv.text('Cours indisponible', x + w / 2, y + h / 2 - 8, { size: 15, color: THEME.muted, align: 'center' });
    return;
  }
  let lo = Math.min(...candles.map((c) => c.l), ...levels.map((l) => l.price));
  let hi = Math.max(...candles.map((c) => c.h), ...levels.map((l) => l.price));
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const L = x + 70;
  const R = x + w - (levels.length ? 150 : 8); // place pour les étiquettes des niveaux
  const T = y + 6;
  const B = y + h - 26;
  const n = candles.length;
  const step = (R - L) / n;
  const X = (i) => L + step * (i + 0.5);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (B - T);
  const st = niceStep(hi - lo, 5);
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) {
    cv.line(L, Y(v), R, Y(v), THEME.border, 1);
    cv.text(price(v), L - 8, Y(v) - 8, { size: 13, color: THEME.muted, align: 'right' });
  }
  const span = candles[n - 1].t - candles[0].t;
  for (const k of [0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1]) {
    const d = new Date(candles[k].t * 1000);
    const lab = span > 3 * 86400 ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    cv.text(lab, X(k), B + 8, { size: 13, color: THEME.muted, align: k === 0 ? 'left' : k === n - 1 ? 'right' : 'center' });
  }
  const bw = Math.max(1, Math.min(14, step * 0.62));
  candles.forEach((c, i) => {
    const up = c.c >= c.o;
    const col = up ? THEME.up : THEME.down;
    cv.line(X(i), Y(c.h), X(i), Y(c.l), col, 1.2);
    const top = Y(Math.max(c.o, c.c));
    cv.fillRect(X(i) - bw / 2, top, bw, Math.max(1.5, Y(Math.min(c.o, c.c)) - top), col);
  });
  for (const l of levels) {
    cv.line(L, Y(l.price), R + 6, Y(l.price), l.rgb, 1.6, l.dash ? 7 : 0);
    const room = x + w - R - 30;
    const full = `${l.label} ${price(l.price)}`;
    // Pas assez de place (cours à 4 décimales, EUR/USD) : le prix seul
    const label = cv.measure(full, 'b', 13) <= room ? full : price(l.price);
    const tw = Math.min(cv.measure(label, 'b', 13), room);
    cv.roundRect(R + 8, Y(l.price) - 11, tw + 14, 22, 6, l.rgb);
    cv.text(label, R + 15, Y(l.price) - 9, { style: 'b', size: 13, color: THEME.bg, maxWidth: tw + 1 });
  }
  for (const m of markers) {
    let k = candles.findIndex((c) => c.t + (candles[1] ? candles[1].t - candles[0].t : 0) > m.t);
    if (k < 0) k = n - 1;
    cv.circle(X(k), Y(m.price), 7, THEME.bg);
    cv.circle(X(k), Y(m.price), 5.5, m.rgb);
    if (m.label) cv.text(m.label, X(k), Y(m.price) + (m.below ? 10 : -30), { style: 'b', size: 13, color: m.rgb, align: 'center' });
  }
}

/** Graphique du cours avec, en option, les niveaux d'une position. */
function priceChartImage({ market, candles, title, subtitle, levels = [], markers = [] }) {
  const cv = new Canvas(W, 620, THEME.bg);
  header(cv, { market, title, subtitle });
  drawCandles(cv, candles, { x: 16, y: 96, w: W - 32, h: 470 }, { levels, markers });
  footer(cv);
  return cv.png();
}

/** Niveaux d'une position (entrée, stop, objectif) pour drawCandles. */
function positionLevels(p) {
  const out = [{ price: p.entry, label: 'Entrée', rgb: THEME.accent }];
  if (p.sl) out.push({ price: p.sl, label: 'Stop', rgb: THEME.down, dash: true });
  if (p.tp) out.push({ price: p.tp, label: 'Objectif', rgb: THEME.up, dash: true });
  if (p.exit) out.push({ price: p.exit, label: 'Sortie', rgb: p.pnlUsd >= 0 ? THEME.up : THEME.down });
  return out;
}

/* ------------------------------------------------------------------ */
/* Carte d'un trade                                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o  { market, strategy, trade (clôturé) | pos (ouverte), price (cours actuel), candles, capital, start }
 */
function tradeCardImage({ market, strategy, trade = null, pos = null, price: now = null, candles = [], capital = null, start = null }) {
  const cv = new Canvas(W, 560, THEME.bg);
  const t = trade || pos;
  const closed = Boolean(trade);
  const long = t.side === 'long';
  const pnlPct = closed ? t.pnlPct : now ? (long ? 1 : -1) * (now / t.entry - 1) * 100 : 0;
  const pnlUsd = closed ? t.pnlUsd : (t.size * pnlPct) / 100;
  header(cv, {
    market,
    title: strategy.name,
    subtitle: `${long ? 'Achat (long)' : 'Vente à découvert (short)'} · ${closed ? `clôturé le ${dateTime(t.exitT)}` : `ouvert le ${dateTime(t.entryT)}`}`,
  });

  // Colonne de gauche : résultat
  cv.roundRect(24, 96, 380, 420, 18, THEME.surface);
  cv.text(closed ? 'RÉSULTAT' : 'EN COURS', 48, 118, { style: 'b', size: 15, color: THEME.muted });
  cv.text(pct(pnlPct, 2), 46, 146, { style: 'b', size: 56, color: tone(pnlPct) });
  cv.text(`${pnlUsd >= 0 ? '+' : '−'}${money(Math.abs(pnlUsd), 2)} sur ${money(t.size)}`, 48, 214, { style: 'b', size: 18, color: tone(pnlUsd) });
  const rows = [
    ['Entrée', price(t.entry)],
    closed ? ['Sortie', price(t.exit)] : ['Cours actuel', now ? price(now) : 'n/d'],
    ['Stop', t.sl ? price(t.sl) : '—'],
    ['Objectif', t.tp ? price(t.tp) : 'signal de sortie'],
    ['Durée', duration((closed ? t.exitT : Date.now() / 1000) - t.entryT)],
  ];
  if (closed) rows.push(['Raison', t.reason]);
  if (capital !== null) rows.push(['Capital', `${money(capital)}${start ? ` (${pct((capital / start - 1) * 100)})` : ''}`]);
  rows.forEach(([k, v], i) => {
    const yy = 258 + i * 34;
    cv.line(48, yy - 6, 380, yy - 6, THEME.border, 1);
    cv.text(k, 48, yy, { size: 15, color: THEME.muted });
    cv.text(v, 380, yy, { style: 'b', size: 15, color: THEME.text, align: 'right', maxWidth: 220 });
  });

  // Colonne de droite : cours pendant le trade
  cv.roundRect(420, 96, 556, 420, 18, THEME.surface);
  const from = t.entryT - (candles.length > 1 ? (candles[1].t - candles[0].t) * 12 : 0);
  const shown = candles.filter((c) => c.t >= from && (!closed || c.t <= t.exitT + (candles[1] ? candles[1].t - candles[0].t : 0) * 6)).slice(-90);
  const markers = [{ t: t.entryT, price: t.entry, rgb: THEME.accent, label: long ? 'achat' : 'vente' }];
  if (closed) markers.push({ t: t.exitT, price: t.exit, rgb: tone(pnlUsd), label: 'sortie', below: true });
  drawCandles(cv, shown, { x: 424, y: 112, w: 548, h: 392 }, { levels: positionLevels(closed ? { ...t, exit: null, sl: null } : t), markers });
  footer(cv);
  return cv.png();
}

/* ------------------------------------------------------------------ */
/* Fiche d'une stratégie                                               */
/* ------------------------------------------------------------------ */

/** row = ligne de MarketTrader.stats() ; curve = [{t, v}] ; note = résultat au banc d'essai. */
function strategyCardImage({ market, row, curve = [], note = '', color = THEME.accent }) {
  const s = row.strategy;
  const cv = new Canvas(W, 640, THEME.bg);
  const tfName = { '1d': 'bougies 1 jour', '1h': 'bougies 1 h', '6h': 'bougies 6 h', '5m': 'bougies 5 min' }[s.tf || '1h'] || s.tf;
  header(cv, { market, title: s.name, subtitle: `${s.id} · ${tfName}${note ? ` · banc d’essai : ${note}` : ''}` });

  const kpis = [
    ['Valeur', money(row.equity), THEME.text],
    ['Depuis le départ', pct(row.returnPct), tone(row.returnPct)],
    ['Trades clôturés', String(row.trades), THEME.text],
    ['Gagnants', row.trades ? `${Math.round(row.winRate)} %` : '—', THEME.text],
  ];
  kpis.forEach(([k, v, c], i) => {
    const x = 24 + i * 241;
    cv.roundRect(x, 96, 229, 84, 14, THEME.surface);
    cv.text(k, x + 16, 108, { size: 13, color: THEME.muted });
    cv.text(v, x + 16, 132, { style: 'b', size: 28, color: c, maxWidth: 200 });
  });

  // Description (retour à la ligne)
  cv.roundRect(24, 194, 952, 150, 14, THEME.surface);
  cv.text('COMMENT ELLE MARCHE', 40, 206, { style: 'b', size: 13, color: THEME.muted });
  const lines = cv.wrap(s.desc, 916, 'r', 15);
  lines.slice(0, 5).forEach((l, i) => cv.text(i === 4 && lines.length > 5 ? `${l}…` : l, 40, 230 + i * 21, { size: 15, color: THEME.text }));

  // Position et courbe
  const p = row.position;
  cv.roundRect(24, 358, 300, 236, 14, THEME.surface);
  cv.text('POSITION', 40, 370, { style: 'b', size: 13, color: THEME.muted });
  if (p) {
    cv.text(p.side === 'long' ? 'Achat' : 'Vente', 40, 394, { style: 'b', size: 28, color: p.side === 'long' ? THEME.up : THEME.down });
    const upct = (p.side === 'long' ? 1 : -1) * (row.unrealized / p.size) * 100;
    cv.text(pct(upct, 2), 40, 434, { style: 'b', size: 22, color: tone(upct) });
    [['Entrée', price(p.entry)], ['Stop', price(p.sl)], ['Depuis', date(p.entryT)]].forEach(([k, v], i) => {
      cv.text(k, 40, 476 + i * 30, { size: 15, color: THEME.muted });
      cv.text(v, 308, 476 + i * 30, { style: 'b', size: 15, color: THEME.text, align: 'right' });
    });
  } else {
    cv.text('À plat', 40, 394, { style: 'b', size: 28, color: THEME.text });
    cv.wrap('La stratégie attend son signal d’entrée.', 260, 'r', 15).forEach((l, i) => cv.text(l, 40, 438 + i * 21, { size: 15, color: THEME.muted }));
  }
  cv.roundRect(336, 358, 640, 236, 14, THEME.surface);
  cv.text('ÉVOLUTION DU CAPITAL', 352, 370, { style: 'b', size: 13, color: THEME.muted });
  drawSeries(cv, [{ points: curve, rgb: color, fill: true, width: 3 }], { x: 340, y: 392, w: 628, h: 196 }, { baseline: row.equity - (row.equity * row.returnPct) / (100 + row.returnPct) });
  footer(cv);
  return cv.png();
}

/* ------------------------------------------------------------------ */
/* Classements (barres)                                                 */
/* ------------------------------------------------------------------ */

/**
 * rows : [{ label, value (longueur de barre, signée), text (valeur affichée), rgb?, badge? }]
 * minScale : valeur minimale de l'échelle (évite qu'un −0,2 % remplisse toute la largeur)
 */
function rankingImage({ market = null, title, subtitle = '', rows, unit = '', minScale = 0 }) {
  const rowH = 46;
  const cv = new Canvas(W, 120 + rows.length * rowH + 40, THEME.bg);
  header(cv, { market, title, subtitle });
  const max = Math.max(1e-9, minScale, ...rows.map((r) => Math.abs(r.value)));
  const anyNeg = rows.some((r) => r.value < 0);
  const labelW = 330;
  const x0 = 28 + labelW + 20;
  const barW = W - x0 - 160;
  const zero = anyNeg ? x0 + barW / 2 : x0;
  const scale = anyNeg ? barW / 2 / max : barW / max;
  rows.forEach((r, i) => {
    const y = 104 + i * rowH;
    if (i % 2 === 0) cv.roundRect(16, y - 4, W - 32, rowH - 4, 10, THEME.surface);
    cv.text(`${i + 1}`, 34, y + 8, { style: 'b', size: 18, color: i < 3 ? THEME.gold : THEME.muted });
    if (r.rgb) cv.roundRect(66, y + 12, 14, 14, 4, r.rgb);
    cv.text(r.label, r.rgb ? 90 : 66, y + 9, { style: i === 0 ? 'b' : 'r', size: 18, color: THEME.text, maxWidth: labelW - (r.rgb ? 62 : 38) });
    const len = Math.abs(r.value) * scale;
    const col = r.value >= 0 ? THEME.up : THEME.down;
    if (len > 0.5) cv.roundRect(r.value >= 0 ? zero : zero - len, y + 8, len, 22, 6, col, 0.85);
    cv.text(`${r.text}${unit}`, W - 28, y + 9, { style: 'b', size: 18, color: r.value > 0 ? THEME.up : r.value < 0 ? THEME.down : THEME.text, align: 'right' });
    if (r.badge) cv.text(r.badge, W - 28 - cv.measure(`${r.text}${unit}`, 'b', 18) - 12, y + 11, { size: 15, color: THEME.muted, align: 'right' });
  });
  if (anyNeg) cv.line(zero, 100, zero, 100 + rows.length * rowH, THEME.muted, 1, 4, 0.6);
  footer(cv);
  return cv.png();
}

/* ------------------------------------------------------------------ */
/* Positions ouvertes                                                   */
/* ------------------------------------------------------------------ */

/** rows : lignes de MarketTrader.stats() avec une position. */
function positionsImage({ market, rows, price: now }) {
  const rowH = 52;
  const cv = new Canvas(W, 150 + Math.max(1, rows.length) * rowH + 40, THEME.bg);
  header(cv, { market, title: `Positions ouvertes · ${rows.length}`, subtitle: `Cours actuel ${now ? price(now) : 'n/d'} · gains latents, frais de sortie non inclus` });
  const cols = [['Stratégie', 28, 'left'], ['Sens', 430, 'left'], ['Entrée', 620, 'right'], ['Stop', 760, 'right'], ['Résultat', W - 28, 'right']];
  for (const [k, x, a] of cols) cv.text(k.toUpperCase(), x, 100, { style: 'b', size: 13, color: THEME.muted, align: a });
  if (!rows.length) cv.text('Aucune position ouverte : toutes les stratégies attendent leur signal.', W / 2, 150, { size: 18, color: THEME.muted, align: 'center' });
  rows.forEach((r, i) => {
    const y = 128 + i * rowH;
    const p = r.position;
    const u = (p.side === 'long' ? 1 : -1) * ((now || p.entry) / p.entry - 1) * 100;
    const uUsd = (p.size * u) / 100;
    const isRef = r.strategy.id === 'hold';
    if (i % 2 === 0) cv.roundRect(16, y - 6, W - 32, rowH - 6, 10, THEME.surface);
    cv.text(r.strategy.name, 28, y + 6, { style: 'b', size: 18, color: THEME.text, maxWidth: 390 });
    cv.text(p.side === 'long' ? '▲ achat' : '▼ vente', 430, y + 6, { style: 'b', size: 18, color: p.side === 'long' ? THEME.up : THEME.down });
    cv.text(`depuis le ${date(p.entryT)}`, 430, y + 28, { size: 13, color: THEME.muted });
    cv.text(price(p.entry), 620, y + 6, { size: 18, color: THEME.text, align: 'right' });
    cv.text(isRef ? '—' : price(p.sl), 760, y + 6, { size: 18, color: THEME.muted, align: 'right' });
    cv.text(pct(u, 2), W - 28, y + 6, { style: 'b', size: 18, color: tone(u), align: 'right' });
    cv.text(`${uUsd >= 0 ? '+' : '−'}${money(Math.abs(uUsd), 0)}`, W - 28, y + 28, { size: 13, color: tone(uUsd), align: 'right' });
  });
  footer(cv);
  return cv.png();
}

/**
 * Historique des trades réellement pris (clôturés), du plus récent au plus ancien.
 * rows : [{ name, side, entry, exit, entryT, exitT, pnlPct, pnlUsd, reason }]
 */
function tradesImage({ market, title, subtitle, rows, footerText }) {
  const rowH = 52;
  const cv = new Canvas(W, 150 + Math.max(1, rows.length) * rowH + 40, THEME.bg);
  header(cv, { market, title, subtitle });
  const cols = [['Clôture', 28, 'left'], ['Stratégie', 168, 'left'], ['Sens', 520, 'left'], ['Entrée → sortie', 800, 'right'], ['Résultat', W - 28, 'right']];
  for (const [k, x, a] of cols) cv.text(k.toUpperCase(), x, 100, { style: 'b', size: 13, color: THEME.muted, align: a });
  if (!rows.length) cv.text('Aucun trade clôturé pour l’instant.', W / 2, 150, { size: 18, color: THEME.muted, align: 'center' });
  rows.forEach((r, i) => {
    const y = 128 + i * rowH;
    if (i % 2 === 0) cv.roundRect(16, y - 6, W - 32, rowH - 6, 10, THEME.surface);
    cv.text(new Date(r.exitT * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', timeZone: 'UTC' }), 28, y + 6, { style: 'b', size: 17, color: THEME.text });
    cv.text(new Date(r.exitT * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC', 28, y + 28, { size: 13, color: THEME.muted });
    cv.text(r.name, 168, y + 6, { style: 'b', size: 17, color: THEME.text, maxWidth: 340 });
    if (r.reason) cv.text(r.reason, 168, y + 28, { size: 13, color: THEME.muted, maxWidth: 340 });
    cv.text(r.side === 'long' ? '▲ achat' : '▼ vente', 520, y + 6, { style: 'b', size: 17, color: r.side === 'long' ? THEME.up : THEME.down });
    cv.text(duration(r.exitT - r.entryT), 520, y + 28, { size: 13, color: THEME.muted });
    cv.text(`${price(r.entry)} → ${price(r.exit)}`, 800, y + 6, { size: 17, color: THEME.text, align: 'right' });
    cv.text(pct(r.pnlPct, 2), W - 28, y + 6, { style: 'b', size: 17, color: tone(r.pnlPct), align: 'right' });
    cv.text(`${r.pnlUsd >= 0 ? '+' : '−'}${money(Math.abs(r.pnlUsd), 2)}`, W - 28, y + 28, { size: 13, color: tone(r.pnlUsd), align: 'right' });
  });
  footer(cv, footerText);
  return cv.png();
}

/* ------------------------------------------------------------------ */
/* Compte FTMO simulé                                                   */
/* ------------------------------------------------------------------ */

/** Jauge horizontale : part utilisée (0..1+). */
function gauge(cv, x, y, w, frac, col) {
  cv.roundRect(x, y, w, 14, 7, THEME.surface2);
  const f = Math.max(0, Math.min(1, frac));
  if (f > 0.01) cv.roundRect(x, y, Math.max(14, w * f), 14, 7, col);
}

/** st = createFtmo().status(prix) */
function ftmoImage(st) {
  const s = st.s;
  const cv = new Canvas(W, 600, THEME.bg);
  const firm = st.account?.firm || 'FTMO';
  const lucid = firm === 'Lucid';
  const phase = s.phase === 'funded' ? 'Compte financé' : lucid ? 'Évaluation LucidFlex' : st.program?.steps === 1 ? 'Challenge 1 étape' : `Étape ${s.phase} sur 2`;
  header(cv, { market: st.account ? { id: st.account.id === 'lucid' ? 'gold' : st.account.id, name: st.account.label } : null, title: `Compte ${firm} simulé · ${phase}`, subtitle: `${lucid ? 'Évaluation' : 'Challenge'} n° ${s.attempt} · capital ${money(s.capital)} · ${lucid ? 'micro-futures, contrats entiers' : 'risque par trade selon le stop'} · depuis le ${date(s.startedAt)}` });
  const ret = (st.equity / s.capital - 1) * 100;
  cv.roundRect(24, 96, 952, 150, 16, THEME.surface);
  cv.text('VALEUR DU COMPTE', 48, 112, { style: 'b', size: 13, color: THEME.muted });
  cv.text(money(st.equity), 46, 134, { style: 'b', size: 56, color: THEME.text });
  cv.text(pct(ret, 2), 48 + cv.measure(money(st.equity), 'b', 56) + 12, 158, { style: 'b', size: 28, color: tone(ret) });
  // D'où vient la valeur : gains latents des positions ouvertes / gains des trades clôturés
  if (st.unrealized !== undefined) {
    const nOpen = Object.keys(s.open).length;
    const sgn = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
    cv.text(`dont ${sgn(st.unrealized)} latents (${nOpen} position${nOpen > 1 ? 's' : ''} ouverte${nOpen > 1 ? 's' : ''}) · réalisé ${sgn(st.realized)}`, 48, 192, { size: 15, color: THEME.muted, maxWidth: 560 });
  }
  if (st.target) {
    cv.text(`Objectif ${money(st.target)} (+${st.targetPct ?? (s.phase === 1 ? 10 : 5)} %)`, 952, 112, { size: 15, color: THEME.muted, align: 'right' });
    gauge(cv, 48, 212, 904, st.progress, THEME.up);
    cv.text(`${Math.round(Math.min(1, st.progress) * 100)} % de l’objectif`, 952, 186, { style: 'b', size: 15, color: THEME.up, align: 'right' });
  } else {
    const gain = s.balance - s.capital;
    const split = st.program?.split || 80;
    cv.text(`Gain depuis le financement : ${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))} · part du trader (${split} %) : ${money((Math.max(0, gain) * split) / 100)}`, 48, 212, { size: 15, color: THEME.muted });
  }
  const box = (x, title, used, label) => {
    cv.roundRect(x, 262, 300, 130, 16, THEME.surface);
    cv.text(title, x + 20, 278, { style: 'b', size: 13, color: THEME.muted });
    cv.text(label, x + 20, 302, { style: 'b', size: 22, color: used > 0.6 ? THEME.down : THEME.text, maxWidth: 260 });
    gauge(cv, x + 20, 348, 260, used, used > 0.6 ? THEME.down : used > 0.3 ? THEME.gold : THEME.up);
  };
  const P = st.program || { daily: 5, max: 10, trailing: false };
  if (Number.isFinite(P.daily)) box(24, `PERTE DU JOUR (MAX ${P.daily} %)`, st.dailyUsed, `${Math.round(st.dailyUsed * 100)} % utilisé`);
  else box(24, 'PERTE DU JOUR', 0, 'aucune limite');
  if (P.maxUsd) box(350, `PERTE MAX ${money(P.maxUsd)} SUIVEUSE`, st.maxUsed, `seuil ${money(st.floor)}`);
  else box(350, `PERTE MAX (${P.max} %${P.trailing ? ', SUIVEUSE' : ''})`, st.maxUsed, `${Math.round(st.maxUsed * 100)} % utilisé`);
  cv.roundRect(676, 262, 300, 130, 16, THEME.surface);
  cv.text('JOURS DE TRADING', 696, 278, { style: 'b', size: 13, color: THEME.muted });
  const minD = P.minDays ?? 4;
  cv.text(`${s.days.length}${s.phase === 'funded' ? '' : ` / ${minD} minimum`}`, 696, 302, { style: 'b', size: 22, color: s.days.length >= minD ? THEME.up : THEME.text });
  cv.text(`${st.trades} trades · ${st.trades ? Math.round((st.wins / st.trades) * 100) : 0} % gagnants`, 696, 344, { size: 15, color: THEME.muted });

  cv.roundRect(24, 408, 952, 150, 16, THEME.surface);
  const open = Object.values(s.open);
  cv.text(open.length ? `POSITIONS OUVERTES · ${open.length}` : 'DERNIERS TRADES', 48, 424, { style: 'b', size: 13, color: THEME.muted });
  const rows = open.length ? open.slice(0, 4) : s.closed.slice(-4).reverse();
  if (!rows.length) cv.text('Aucun trade pour l’instant : le compte attend les signaux des stratégies suivies.', 48, 456, { size: 15, color: THEME.muted });
  rows.forEach((r, i) => {
    const y = 450 + i * 26;
    cv.text(`${r.side === 'long' ? '▲ achat' : '▼ vente'} · ${r.name}`, 48, y, { size: 15, color: r.side === 'long' ? THEME.up : THEME.down, maxWidth: 470 });
    cv.text(`${price(r.entry)}${r.exit ? ` → ${price(r.exit)}` : ''} · ${r.n ? `${r.n} ${r.contract || 'micro'}` : `${money(r.notional)}${r.lev ? ` · levier ${r.lev.toFixed(1).replace('.', ',')}` : ''}`}`, 820, y, { size: 15, color: THEME.muted, align: 'right' });
    // Résultat : soldé pour un trade clôturé, latent (au cours actuel) pour une position ouverte
    const v = r.pnl !== undefined ? r.pnl : st.openPnl ? st.openPnl(r) : null;
    if (v !== null && v !== undefined) cv.text(`${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`, 952, y, { style: 'b', size: 15, color: tone(v), align: 'right' });
  });
  footer(cv, `Simulation ${lucid ? 'd’une évaluation Lucid' : 'd’un challenge FTMO'} · argent fictif · pas un conseil financier`);
  return cv.png();
}

module.exports = { ftmoImage, priceChartImage, tradeCardImage, strategyCardImage, rankingImage, positionsImage, tradesImage, positionLevels, drawCandles };
