#!/usr/bin/env node
/**
 * 3e recherche Lucid : scalp « auction market » (inspiré de Fabio Valentini : équilibre / déséquilibre autour du
 * profil de volume) et balayages de liquidité, sur le Nasdaq (QQQ 5 min, séance seule de New York, nov. 2024 → nov. 2026).
 * Le flux d'ordres (delta, absorption, footprint) n'est pas disponible : on n'utilise que les bougies et leur volume.
 *   Profil de volume de la séance précédente : POC (prix le plus échangé), zone de valeur (70 % du volume, VAH / VAL).
 *   1. Retour dans la zone de valeur (« règle des 80 % ») : ouverture hors de la zone, 2 clôtures dedans → vers l'autre bord / le POC.
 *   2. Cassure ratée du bord de la zone : clôture dehors puis retour dedans en ≤ 6 bougies → vers le POC.
 *   3. Déséquilibre : ouverture hors de la zone sans y revenir en 30 min, repli sur le bord → dans le sens de la sortie.
 *   4. Balayage du plus haut / plus bas de la veille : mèche au-delà, clôture en deçà → retour.
 *   5. Balayage du range des 15 premières minutes : même chose après 10 h.
 * Sélection : avantage > +0,02 R les deux années, ≤ 8 pertes de suite, ≥ 30 trades par année ; puis ajout au réglage
 * Lucid actuel : réussite de l'évaluation, délai médian, trades par jour.
 *
 *   npm run lucid-research3
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { rStats, challengeStats, cmeDay } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const S = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const hm = S.hm;
const OPEN = hm(9, 30); const CLOSE = hm(15, 55);

/** Profil de volume de la séance précédente pour chaque bougie : { poc, vah, val, ph, pl } (ou null). */
function profiles(x) {
  if (x.cache.vp) return x.cache.vp;
  const { min, day } = x.tz.ny;
  const c = x.candles; const n = c.length;
  const out = new Array(n).fill(null);
  const build = (bars) => {
    if (bars.length < 20) return null;
    const ref = bars[0].c; const w = ref * 0.0005; // cases de 0,05 % du prix
    const vol = new Map(); let tot = 0; let ph = -Infinity; let pl = Infinity;
    for (const b of bars) {
      ph = Math.max(ph, b.h); pl = Math.min(pl, b.l);
      const lo = Math.floor(b.l / w); const hi = Math.floor(b.h / w); const v = (b.v || 1) / (hi - lo + 1);
      for (let k = lo; k <= hi; k++) { vol.set(k, (vol.get(k) || 0) + v); tot += v; }
    }
    let poc = null; let best = -1;
    for (const [k, v] of vol) if (v > best) { best = v; poc = k; }
    let a = poc; let b2 = poc; let acc = best;
    while (acc < 0.7 * tot) {
      const up = vol.get(b2 + 1) || 0; const dn = vol.get(a - 1) || 0;
      if (up === 0 && dn === 0) break;
      if (up >= dn) { b2++; acc += up; } else { a--; acc += dn; }
    }
    return { poc: (poc + 0.5) * w, vah: (b2 + 1) * w, val: a * w, ph, pl };
  };
  let dd = null; let cur = []; let prev = null;
  for (let i = 0; i < n; i++) {
    if (day[i] !== dd) { if (cur.length) prev = build(cur); cur = []; dd = day[i]; }
    if (min[i] >= OPEN && min[i] < hm(16)) cur.push(c[i]);
    out[i] = prev;
  }
  return (x.cache.vp = out);
}
/** Ouverture de la séance du jour (1re bougie ≥ 9 h 30) pour chaque bougie, et indice de cette bougie. */
function sessOpen(x) {
  if (x.cache.so) return x.cache.so;
  const { min, day } = x.tz.ny; const n = x.candles.length;
  const out = new Array(n).fill(null); let dd = null; let o = null;
  for (let i = 0; i < n; i++) { if (day[i] !== dd) { dd = day[i]; o = null; } if (o === null && min[i] >= OPEN) o = { o: x.candles[i].o, i }; out[i] = o; }
  return (x.cache.so = out);
}

const base = (id, name, evaluate) => ({
  id, name, tf: '5m', scalp: true, warmup: 300, markets: ['nas100'], compute: (c) => S.computeFor(c, 'nas100'),
  evaluate(x0, i) {
    const x = S.withNyx(x0);
    const m = x.tz.ny.min[i];
    const wd = new Date(x.candles[i].t * 1000).getUTCDay();
    const flat = wd === 0 || wd === 6 || m >= CLOSE || m < OPEN;
    const out = { entry: null, exitLong: flat, exitShort: flat, sl: 0, tp: null };
    if (flat || !(x.atr[i] > 0)) return out;
    const r = evaluate(x, i, m);
    return r ? { ...out, ...r } : out;
  },
});
/** target : 'poc' / 'opp' (autre bord) / nombre (k × le risque). */
const tpOf = (target, side, price, sl, vp) => {
  if (typeof target === 'number') return target * sl;
  const lvl = target === 'poc' ? vp.poc : side === 'long' ? vp.vah : vp.val;
  const d = side === 'long' ? lvl - price : price - lvl;
  return d > 0.2 * sl ? d : null;
};
const once = (x, key, i, cond) => S.firstOfDay(x, 'ny', key, cond)[i];

function va80({ target, k }) {
  const id = `a_va80_${target}_${k}`;
  return base(id, `Retour dans la zone de valeur (80 %) → ${target === 'poc' ? 'POC' : target === 'opp' ? 'autre bord' : `${target} R`}, stop ${k} ATR`, (x, i, m) => {
    if (m >= hm(12)) return null;
    const cond = (j) => {
      const v = profiles(x)[j]; const o = sessOpen(x)[j];
      if (!v || !o || j - 1 <= o.i || x.tz.ny.min[j] >= hm(12)) return false;
      if (!(o.o > v.vah || o.o < v.val)) return false;
      const inside = (q) => x.closes[q] <= v.vah && x.closes[q] >= v.val;
      return inside(j) && inside(j - 1);
    };
    if (!once(x, id, i, cond)) return null;
    const vp = profiles(x)[i]; const so = sessOpen(x)[i];
    const side = so.o > vp.vah ? 'short' : 'long';
    const sl = k * x.atr[i]; const tp = tpOf(target, side, x.closes[i], sl, vp);
    return tp ? { entry: side, sl, tp } : null;
  });
}
function failBreak({ target, k }) {
  const id = `a_fail_${target}_${k}`;
  return base(id, `Cassure ratée du bord de la zone de valeur → ${target === 'poc' ? 'POC' : `${target} R`}, stop ${k} ATR`, (x, i, m) => {
    if (m < hm(10) || m >= hm(14, 30)) return null;
    const vp = profiles(x)[i]; if (!vp) return null;
    const c = x.closes;
    const back = (j, up) => { const v = profiles(x)[j]; for (let q = j - 1; q >= j - 6 && q >= 0; q--) if (x.tz.ny.day[q] === x.tz.ny.day[j] && x.tz.ny.min[q] >= hm(9, 35) && (up ? c[q] > v.vah : c[q] < v.val)) return true; return false; };
    const win = (j) => x.tz.ny.min[j] >= hm(10) && x.tz.ny.min[j] < hm(14, 30) && profiles(x)[j] && c[j] <= profiles(x)[j].vah && c[j] >= profiles(x)[j].val;
    const sh = once(x, `${id}s`, i, (j) => win(j) && back(j, true));
    const lo = once(x, `${id}l`, i, (j) => win(j) && back(j, false));
    const side = sh ? 'short' : lo ? 'long' : null; if (!side) return null;
    const sl = k * x.atr[i]; const tp = tpOf(target, side, c[i], sl, vp);
    return tp ? { entry: side, sl, tp } : null;
  });
}
function imbalance({ target, k }) {
  const id = `a_imb_${target}_${k}`;
  return base(id, `Déséquilibre : repli sur le bord de la zone de valeur → ${target} R, stop ${k} ATR sous le bord`, (x, i, m) => {
    if (m < hm(10) || m >= hm(13)) return null;
    // Jour en déséquilibre : ouverture hors de la zone de valeur, sans y revenir pendant les 30 premières minutes
    const imbOf = (j) => {
      const v = profiles(x)[j]; const o = sessOpen(x)[j]; if (!v || !o) return null;
      const u = o.o > v.vah; const d = o.o < v.val; if (!u && !d) return null;
      for (let q = o.i; q < x.candles.length && x.tz.ny.day[q] === x.tz.ny.day[o.i] && x.tz.ny.min[q] < hm(10); q++) if (u ? x.candles[q].l <= v.vah : x.candles[q].h >= v.val) return null;
      return { up: u, lvl: u ? v.vah : v.val };
    };
    const cond = (j) => {
      if (x.tz.ny.min[j] < hm(10) || x.tz.ny.min[j] >= hm(13)) return false;
      const b = imbOf(j); if (!b) return false;
      const tl = 0.25 * x.atr[j];
      return b.up ? x.candles[j].l <= b.lvl + tl && x.closes[j] > b.lvl : x.candles[j].h >= b.lvl - tl && x.closes[j] < b.lvl;
    };
    if (!once(x, id, i, cond)) return null;
    const { up, lvl } = imbOf(i);
    const side = up ? 'long' : 'short';
    const sl = Math.abs(x.closes[i] - lvl) + k * x.atr[i];
    return { entry: side, sl, tp: target * sl };
  });
}
function sweep({ kind, target }) {
  const id = `a_sweep_${kind}_${target}`;
  return base(id, `Balayage ${kind === 'pd' ? 'du plus haut / plus bas de la veille' : 'du range des 15 premières min'} → ${target} R`, (x, i, m) => {
    const from = kind === 'pd' ? hm(9, 45) : hm(10);
    if (m < from || m >= hm(14)) return null;
    const lv = (j) => { if (kind === 'pd') { const v = profiles(x)[j]; return v ? [v.ph, v.pl] : null; } const R = S.rangeOf(x, 'ny', OPEN, 15); return R.hi[j] === null ? null : [R.hi[j], R.lo[j]]; };
    const k = x.candles;
    const okT = (j) => x.tz.ny.min[j] >= from && x.tz.ny.min[j] < hm(14);
    const sh = once(x, `${id}s`, i, (j) => { const l = lv(j); return okT(j) && l && k[j].h > l[0] && k[j].c < l[0]; });
    const lo = once(x, `${id}l`, i, (j) => { const l = lv(j); return okT(j) && l && k[j].l < l[1] && k[j].c > l[1]; });
    if (sh) { const sl = k[i].h - k[i].c + 0.2 * x.atr[i]; return { entry: 'short', sl, tp: target * sl }; }
    if (lo) { const sl = k[i].c - k[i].l + 0.2 * x.atr[i]; return { entry: 'long', sl, tp: target * sl }; }
    return null;
  });
}

function candidates() {
  const C = [];
  for (const target of ['opp', 'poc', 0.75]) for (const k of [1, 2]) C.push(va80({ target, k }));
  for (const target of ['poc', 0.5, 0.75]) for (const k of [1, 2]) C.push(failBreak({ target, k }));
  for (const target of [0.5, 0.75, 1]) for (const k of [0.5, 1]) C.push(imbalance({ target, k }));
  for (const kind of ['pd', 'or']) for (const target of [0.5, 0.75, 1, 1.5]) C.push(sweep({ kind, target }));
  return C;
}

(async () => {
  const qs = require('./src/oanda').nySession(aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const t0 = qs[0].t + 30 * 86400; const t1 = qs[qs.length - 1].t; const mid = (t0 + t1) / 2;
  const opt = { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' };
  const trades = (s) => backtest(s, qs, opt).list.filter((t) => t.entryT >= t0).map((t) => ({ ...t, sid: `nas100:${s.id}`, market: 'nas100', intraday: true, contractUsd: t.entry * 82, contractFee: 2.5 }));
  const days = ((t1 - t0) / 86400) * (5 / 7);
  const rows = [];
  for (const s of candidates()) {
    const l = trades(s);
    const a = rStats(l.filter((t) => t.entryT < mid)); const b = rStats(l.filter((t) => t.entryT >= mid)); const all = rStats(l);
    rows.push({ s, l, a, b, all, ok: a.expR > 0.02 && b.expR > 0.02 && all.worstRun <= 8 && a.n >= 30 && b.n >= 30 });
  }
  rows.sort((p, q) => Math.min(q.a.expR, q.b.expR) - Math.min(p.a.expR, p.b.expR));
  console.log('=== Nasdaq (QQQ séance seule, nov. 2024 → nov. 2026) · R moyen 1re / 2e année · gagnants · pire série · baisse max · trades / jour ===');
  for (const r of rows) console.log(`${r.ok ? '✅' : '  '} ${r.s.id.padEnd(20)} ${(r.a.expR >= 0 ? '+' : '') + r.a.expR.toFixed(2)} / ${(r.b.expR >= 0 ? '+' : '') + r.b.expR.toFixed(2)} R · ${r.all.win.toFixed(0)} % · ${String(r.all.worstRun).padStart(2)} · ${r.all.maxDdR.toFixed(1).padStart(5)} R · ${(r.l.length / days).toFixed(2)} /j  ${r.s.name}`);
  const kept = rows.filter((r) => r.ok);
  console.log(`\n${kept.length} candidate(s) retenue(s).`);
  if (!kept.length) return;

  const { all } = await buildTrades(cfg, CACHE);
  const L = accountOf(cfg, 'lucid');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const daily = all.filter((t) => !t.intraday && L.strategies.includes(t.sid)).map((t) => ({ ...t, riskPct: L.riskOf(...strat(t.sid)) })).filter((t) => t.riskPct > 0);
  const cur = cfg.lucidIntradayStrategies.flatMap((k) => trades(selectStrategies([k.split(':')[1]])[0]));
  const R = { capital: 50_000, steps: 1, target1: 6, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, bestDayPct: cfg.lucidConsistency, minDays: 2, contracts: true, maxContracts: 40, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay, dayStopPct: cfg.ftmoDayStop };
  const sizer = RULES[cfg.ftmoSizing] || RULES.fixe;
  const halfStart = t0 + (t1 - 365 * 86400 - t0) / 2;
  const evalLucid = (intra) => {
    const list = [...daily, ...intra.map((t) => ({ ...t, riskPct: cfg.lucidIntradayRisk }))].filter((t) => t.entryT >= t0);
    const one = (a, e) => challengeStats(list, { riskPct: 1, sizer, horizonDays: 365, start: a, ...(e ? { end: e + 365 * 86400 } : {}), ...R });
    const c = one(t0); const h1 = one(t0, halfStart); const h2 = one(halfStart);
    const st = rStats([...intra].sort((p, q) => p.exitT - q.exitT));
    return `réussite ${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j) · moitiés ${h1.passRate.toFixed(0)} / ${h2.passRate.toFixed(0)} % · intraday ${(intra.length / days).toFixed(1)} /j, ${st.win.toFixed(0)} % gagnants, pire série ${st.worstRun}`;
  };
  console.log(`\n=== Lucid 50K, départ chaque semaine · réglage actuel : ${cfg.lucidIntradayStrategies.map((k) => k.split(':')[1]).join(', ')} ===`);
  console.log(`${'actuel'.padEnd(34)} ${evalLucid(cur)}`);
  for (const r of kept) console.log(`${('+ ' + r.s.id).padEnd(34)} ${evalLucid([...cur, ...r.l])}`);
  const fam = new Map();
  for (const r of kept) { const f = r.s.id.split('_').slice(0, 2).join('_'); if (!fam.has(f)) fam.set(f, r); }
  const best = [...fam.values()];
  if (best.length > 1) console.log(`${('+ ' + best.map((r) => r.s.id).join(' + ')).padEnd(34)} ${evalLucid([...cur, ...best.flatMap((r) => r.l)])}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
