#!/usr/bin/env node
/**
 * Test en masse de stratégies intraday Nasdaq (QQQ 1 min Polygon nov. 2024 → nov. 2026, regroupé en 5 et 15 min) :
 * familles de MOMENTUM (le retour à la moyenne ne marche pas en intraday sur le Nasdaq : 1 variante sur 112, voir
 * `npm run nas-scalp-grid`).
 *   - cassure du range d'ouverture (5 à 60 min), avec ou sans filtre (VWAP, sens de la veille)
 *   - momentum intraday : le sens de la journée à 10 h / 10 h 30 / 12 h prédit la dernière demi-heure / heure
 *   - croisement du VWAP dans la tendance 1 h
 *   - cassure du plus haut / plus bas de n bougies dans la tendance 1 h
 *   - gap d'ouverture : continuation ou comblement
 *   - repli sur le VWAP dans la tendance 1 h
 * Frais 0,003 % par côté + financement 6 %/an. 3 tranches de 8 mois : choix si positif sur les tranches 1 ET 2
 * (≥ 40 trades), vérification sur la tranche 3 (≥ 20 trades).
 *
 *   npm run nas-intraday-grid
 *   npm run gold-intraday-grid   (les mêmes familles de momentum sur l'or, PAXG 2020–2026, séance 7 h–20 h UTC)
 */
const path = require('path');
const { aggregate } = require('./src/history');
const { backtest } = require('./src/gold');
const { computeScalp2, helpers } = require('./src/scalp2');
const { ema } = require('./src/indicators');

const { trendUp, trendDown, weekday } = helpers;
const CACHE = path.join(__dirname, 'data', 'research');
const GOLD = process.argv[2] === 'gold';
const FEE = GOLD ? 0.005 : 0.003;
const FIN = GOLD ? 0 : 6;
// Séance : Nasdaq 9 h 30 → 16 h (New York) ; or 7 h → 20 h UTC (ouverture de Londres → fin d'après-midi à New York)
const OPEN = GOLD ? 7 * 60 : 9 * 60 + 30;
const CLOSE = GOLD ? 20 * 60 : 16 * 60;
/** Heure « Nasdaq » (minutes New York) transposée à la séance du marché testé (même écart depuis l'ouverture). */
const T = (nyMin) => OPEN + (nyMin - (9 * 60 + 30));

(async () => {
  // Or : or au comptant réel (HistData 2009–2026, `npm run histdata`) ; PAXG seulement avec PAXG=1 (cotation trompeuse en intraday)
  const spot = path.join(CACHE, 'xauusd-5m.json');
  const q5 = GOLD ? (!process.env.PAXG && require('fs').existsSync(spot)
    ? JSON.parse(require('fs').readFileSync(spot, 'utf8')).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
    : await require('./src/history').loadKlines(CACHE, { interval: '5m' })) : aggregate(await require('./src/polygon').polygonBars(CACHE, 'QQQ', 1, '2024-11-18'), 300, 60);
  const sets = { '5m': { c: q5, sec: 300 }, '15m': { c: aggregate(q5, 900, 300), sec: 900 } };
  const results = [];
  for (const [tf, d] of Object.entries(sets)) {
    const x = computeScalp2(d.c, d.sec, GOLD ? 'gold' : 'nas100');
    const n = d.c.length;
    const cl = x.closes;
    const m = x.min;
    const mins = d.sec / 60;
    const e20 = ema(cl, 20);
    const inSess = (i) => weekday(x, i) && m[i] >= OPEN && m[i] < CLOSE;
    // Fin de bougie (heure à laquelle on connaît la clôture)
    const endMin = (i) => m[i] + mins;
    // Range d'ouverture de N minutes, ouverture de séance, rendement depuis la veille
    const orr = {};
    const range = (N) => {
      if (orr[N]) return orr[N];
      const hi = new Array(n).fill(null);
      const lo = new Array(n).fill(null);
      let dd = null; let h = -Infinity; let l = Infinity;
      for (let i = 0; i < n; i++) {
        if (x.day[i] !== dd) { dd = x.day[i]; h = -Infinity; l = Infinity; }
        if (inSess(i) && m[i] < OPEN + N) { h = Math.max(h, d.c[i].h); l = Math.min(l, d.c[i].l); }
        if (inSess(i) && m[i] >= OPEN + N && h > -Infinity) { hi[i] = h; lo[i] = l; }
      }
      return (orr[N] = { hi, lo });
    };
    const sOpen = new Array(n).fill(null);
    { let dd = null; let o = null; for (let i = 0; i < n; i++) { if (x.day[i] !== dd) { dd = x.day[i]; o = null; } if (o === null && inSess(i)) o = d.c[i].o; sOpen[i] = o; } }
    // Prix à une heure donnée de la séance (clôture de la dernière bougie terminée avant cette heure)
    const at = {};
    const priceAt = (hm) => {
      if (at[hm]) return at[hm];
      const out = new Array(n).fill(null);
      let dd = null; let p = null;
      for (let i = 0; i < n; i++) { if (x.day[i] !== dd) { dd = x.day[i]; p = null; } if (inSess(i) && endMin(i) <= hm) p = cl[i]; out[i] = p; }
      return (at[hm] = out);
    };
    // Premier signal du jour seulement (une entrée par jour)
    const firstOfDay = (cond) => {
      const out = new Array(n).fill(false);
      let dd = null; let done = false;
      for (let i = 0; i < n; i++) { if (x.day[i] !== dd) { dd = x.day[i]; done = false; } if (!done && cond(i)) { out[i] = true; done = true; } }
      return out;
    };
    const flatAt = (hm) => (i) => !weekday(x, i) || endMin(i) >= hm || m[i] < OPEN;

    const V = [];
    const add = (fam, name, o) => V.push({ fam, name, ...o });
    // 1. Cassure du range d'ouverture
    for (const N of [5, 15, 30, 60]) {
      if (N < mins) continue;
      const R = range(N);
      for (const filt of ['aucun', 'VWAP', 'veille']) {
        const okL = (i) => filt === 'aucun' || (filt === 'VWAP' ? cl[i] > x.vwap[i] : sOpen[i] > x.pClose[i]);
        const okS = (i) => filt === 'aucun' || (filt === 'VWAP' ? cl[i] < x.vwap[i] : sOpen[i] < x.pClose[i]);
        const up = firstOfDay((i) => R.hi[i] !== null && cl[i] > R.hi[i] && m[i] < T(12 * 60));
        const dn = firstOfDay((i) => R.lo[i] !== null && cl[i] < R.lo[i] && m[i] < T(12 * 60));
        for (const side of ['achat', 'vente', 'les deux']) {
          add('cassure ouverture', `range ${N} min, ${side}, filtre ${filt}`, {
            buy: (i) => side !== 'vente' && up[i] && okL(i), sell: (i) => side !== 'achat' && dn[i] && okS(i),
            sl: (i, long) => Math.max(0.2 * x.atr[i], long ? cl[i] - R.lo[i] : R.hi[i] - cl[i]), flat: flatAt(CLOSE - 5),
          });
        }
      }
    }
    // 2. Momentum intraday : sens de la journée à une heure donnée → position jusqu'à la clôture
    for (const [obs, ent] of [[T(10 * 60), T(15 * 60)], [T(10 * 60), T(15 * 60 + 30)], [T(10 * 60 + 30), T(15 * 60)], [T(10 * 60 + 30), T(15 * 60 + 30)], [T(12 * 60), T(15 * 60)], [T(15 * 60 + 30), T(15 * 60 + 30)]]) {
      const P = priceAt(obs);
      for (const th of [0, 0.25, 0.5]) {
        const go = (sgn) => firstOfDay((i) => inSess(i) && endMin(i) >= ent && P[i] !== null && x.pClose[i] && sgn * (P[i] / x.pClose[i] - 1) * 100 > th);
        const up = go(1); const dn = go(-1);
        const lab = (h) => `${Math.floor(h / 60)} h${h % 60 ? h % 60 : ''}`;
        add('momentum intraday', `sens veille → ${lab(obs)} > ${th} %, entrée ${lab(ent)}`, {
          buy: (i) => up[i], sell: (i) => dn[i], sl: (i) => 3 * x.atr[i], flat: flatAt(CLOSE - 5),
        });
      }
    }
    // 3. Croisement du VWAP dans la tendance 1 h
    for (const lim of [T(12 * 60), T(15 * 60)]) {
      add('VWAP', `croise le VWAP dans la tendance 1 h, avant ${lim / 60} h`, {
        buy: (i) => m[i] < lim && x.vwap[i - 1] !== null && cl[i - 1] <= x.vwap[i - 1] && cl[i] > x.vwap[i] && trendUp(x, i),
        sell: (i) => m[i] < lim && x.vwap[i - 1] !== null && cl[i - 1] >= x.vwap[i - 1] && cl[i] < x.vwap[i] && trendDown(x, i),
        exitL: (i) => cl[i] < x.vwap[i], exitS: (i) => cl[i] > x.vwap[i], sl: (i) => 1.5 * x.atr[i], flat: flatAt(CLOSE - 5),
      });
    }
    // 4. Cassure de n bougies dans la tendance 1 h
    for (const k of [10, 20, 40]) for (const ex of ['EMA 20', 'clôture']) {
      add('cassure n bougies', `cassure ${k} bougies dans la tendance, sortie ${ex}`, {
        buy: (i) => i > k && trendUp(x, i) && cl[i] > Math.max(...d.c.slice(i - k, i).map((c) => c.h)) && m[i] >= OPEN + 15,
        sell: (i) => i > k && trendDown(x, i) && cl[i] < Math.min(...d.c.slice(i - k, i).map((c) => c.l)) && m[i] >= OPEN + 15,
        exitL: (i) => ex === 'EMA 20' && cl[i] < e20[i], exitS: (i) => ex === 'EMA 20' && cl[i] > e20[i], sl: (i) => 2 * x.atr[i], flat: flatAt(CLOSE - 5),
      });
    }
    // 5. Gap d'ouverture
    for (const g of [0.3, 0.6, 1]) for (const mode of ['continuation', 'comblement']) {
      const gap = (i) => (sOpen[i] && x.pClose[i] ? (sOpen[i] / x.pClose[i] - 1) * 100 : 0);
      const up = firstOfDay((i) => inSess(i) && m[i] >= OPEN + 15 && (mode === 'continuation' ? gap(i) > g && cl[i] > sOpen[i] : gap(i) < -g));
      const dn = firstOfDay((i) => inSess(i) && m[i] >= OPEN + 15 && (mode === 'continuation' ? gap(i) < -g && cl[i] < sOpen[i] : gap(i) > g));
      add('gap', `gap > ${g} %, ${mode}`, {
        buy: (i) => up[i], sell: (i) => dn[i], sl: (i) => 2 * x.atr[i], flat: flatAt(CLOSE - 5),
        exitL: (i) => mode === 'comblement' && x.pClose[i] && cl[i] >= x.pClose[i], exitS: (i) => mode === 'comblement' && x.pClose[i] && cl[i] <= x.pClose[i],
      });
    }
    // 6. Repli sur le VWAP dans la tendance 1 h, objectif 1,5 R
    for (const rr of [1, 2]) {
      add('repli VWAP', `touche le VWAP dans la tendance, objectif ${rr} R`, {
        buy: (i) => trendUp(x, i) && cl[i] > x.vwap[i] && d.c[i].l <= x.vwap[i] && m[i] >= OPEN + 30 && m[i] < T(15 * 60),
        sell: (i) => trendDown(x, i) && cl[i] < x.vwap[i] && d.c[i].h >= x.vwap[i] && m[i] >= OPEN + 30 && m[i] < T(15 * 60),
        sl: (i) => 1 * x.atr[i], tp: (i) => rr * x.atr[i], flat: flatAt(CLOSE - 5),
      });
    }

    const a = d.c[0].t;
    const b = d.c[n - 1].t;
    const cuts = [a, a + (b - a) / 3, a + (2 * (b - a)) / 3, Infinity];
    for (const v of V) {
      const strat = {
        id: 'grid', tf, warmup: 300,
        evaluate(ind, i) {
          const fl = v.flat(i);
          const out = { entry: null, exitLong: fl || (v.exitL ? v.exitL(i) : false), exitShort: fl || (v.exitS ? v.exitS(i) : false), sl: 0, tp: null };
          if (fl || !inSess(i)) return out;
          if (v.buy(i)) return { ...out, entry: 'long', sl: v.sl(i, true), tp: v.tp ? v.tp(i) : null };
          if (v.sell(i)) return { ...out, entry: 'short', sl: v.sl(i, false), tp: v.tp ? v.tp(i) : null };
          return out;
        },
      };
      const r = backtest(strat, d.c, { size: 1000, feePct: FEE, financingPct: FIN, barSec: d.sec, ind: x });
      const parts = [0, 1, 2].map((k) => { const l = r.list.filter((t) => t.entryT >= cuts[k] && t.entryT < cuts[k + 1]); return { n: l.length, sum: l.reduce((s, t) => s + t.pnlPct, 0) }; });
      const chosen = parts[0].sum > 0 && parts[1].sum > 0 && parts[0].n + parts[1].n >= (GOLD ? 100 : 40);
      results.push({ tf, v, parts, chosen, valid: chosen && parts[2].sum > 0 && parts[2].n >= (GOLD ? 50 : 20), list: r.list, perDay: r.list.length / (((b - a) / 86400) * (252 / 365)) });
    }
  }
  const fams = [...new Set(results.map((r) => `${r.v.fam} ${r.tf}`))];
  console.log(`=== ${results.length} variantes intraday ${GOLD ? 'or (au comptant, HistData' : 'Nasdaq (QQQ'} 5 / 15 min, frais ${FEE} % + financement) · choix tranches 1 + 2, vérification tranche 3 ===\n`);
  for (const f of fams) {
    const r = results.filter((x) => `${x.v.fam} ${x.tf}` === f);
    console.log(`  ${f.padEnd(24)} ${String(r.length).padStart(3)} testées · ${String(r.filter((x) => x.chosen).length).padStart(3)} choisies · ${String(r.filter((x) => x.valid).length).padStart(3)} confirmées`);
  }
  const chosen = results.filter((x) => x.chosen);
  const valid = results.filter((x) => x.valid);
  console.log(`\nTotal : ${results.length} testées · ${chosen.length} choisies · ${valid.length} confirmées (${chosen.length ? ((valid.length / chosen.length) * 100).toFixed(0) : 0} %)`);
  console.log('\nLes 5 meilleures sur les tranches de choix, même non retenues (tranche 1 · 2 · 3, trades) :');
  for (const r of [...results].sort((p, q) => q.parts[0].sum + q.parts[1].sum - p.parts[0].sum - p.parts[1].sum).slice(0, 5)) {
    console.log(`  [${r.tf}] ${r.v.fam.padEnd(18)} ${r.v.name.padEnd(48)} ${r.parts.map((p) => `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(1)} %`).join(' · ')} · ${r.parts.reduce((s, p) => s + p.n, 0)}`);
  }
  console.log('\nConfirmées (gain net cumulé % : tranche 1 · 2 · 3, trades, trades / jour) :');
  for (const r of valid.sort((p, q) => q.parts[2].sum - p.parts[2].sum)) {
    console.log(`  [${r.tf}] ${r.v.fam.padEnd(18)} ${r.v.name.padEnd(48)} ${r.parts.map((p) => `${p.sum >= 0 ? '+' : ''}${p.sum.toFixed(1)} %`).join(' · ')} · ${r.parts.reduce((s, p) => s + p.n, 0)} · ${r.perDay.toFixed(2)}/j`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
