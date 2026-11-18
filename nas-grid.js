#!/usr/bin/env node
/**
 * Test en masse de stratégies Nasdaq 100 (achat seul, journalier, ^NDX 1985–2026) — avec garde-fous contre le hasard.
 *
 * ~300 variantes de 11 familles (replis, RSI, chutes, moyennes, croisements, momentum, cassures, calendrier, jours de la
 * semaine, volatilité, autres marchés). Pour chacune :
 *   alpha = gain des trades − ce qu'aurait rapporté le Nasdaq pendant les mêmes jours en position (rendement moyen du jour),
 *   en % par an. Un alpha > 0 veut dire que la stratégie choisit de MEILLEURS jours que le hasard, pas juste qu'elle est
 *   investie dans un marché qui monte.
 * Choix sur 1985–2009 : alpha > 0 sur 1985–1999 ET 2000–2009, au moins 30 trades.
 * Vérification sur 2010–2026 (jamais utilisée pour choisir) : alpha > 0.
 * Frais 0,003 % par côté + financement CFD 6 %/an.
 *
 *   npm run nas-grid
 */
const path = require('path');
const { cachedYahoo } = require('./src/yahoo');
const { backtest } = require('./src/gold');
const { sma, rsi, atr, ema } = require('./src/indicators');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const P = [['1985–1999', 0, Y(2000)], ['2000–2009', Y(2000), Y(2010)], ['2010–2026', Y(2010), Infinity]];

(async () => {
  const nd = await cachedYahoo(CACHE, '^NDX', '1d');
  const ext = async (s) => { const d = await cachedYahoo(CACHE, s, '1d').catch(() => []); const m = new Map(d.map((x) => [x.t, x.c])); let last = null; return nd.map((c) => { if (m.has(c.t)) last = m.get(c.t); return last; }); };
  const X = { vix: await ext('^VIX'), tnx: await ext('^TNX'), dxy: await ext('DX-Y.NYB'), oil: await ext('CL=F'), gold: await ext('GC=F'), spx: await ext('^GSPC') };
  const c = nd.map((k) => k.c);
  const n = c.length;
  const A = atr(nd, 14);
  const S = {};
  const sm = (k) => (S[k] ||= sma(c, k));
  const R = {};
  const rs = (k) => (R[k] ||= rsi(c, k));
  const lowN = (k) => (S[`lo${k}`] ||= c.map((_, i) => (i >= k - 1 ? Math.min(...c.slice(i - k + 1, i + 1)) : null)));
  const highN = (k) => (S[`hi${k}`] ||= c.map((_, i) => (i >= k - 1 ? Math.max(...c.slice(i - k + 1, i + 1)) : null)));
  const ret = (i, k) => (i >= k ? c[i] / c[i - k] - 1 : null);
  const xret = (key, i, k) => (i >= k && X[key][i] && X[key][i - k] ? X[key][i] / X[key][i - k] - 1 : null);
  const rv = c.map((_, i) => { if (i < 21) return null; let s = 0; for (let j = i - 19; j <= i; j++) { const r = Math.log(c[j] / c[j - 1]); s += r * r; } return Math.sqrt(s / 20); });
  const rvAvg = sma(rv.map((v) => v ?? 0), 250);
  // Calendrier : jour de bourse du mois (1, 2…) et jours restants (1 = dernier)
  const tdom = []; const left = [];
  for (let i = 0; i < n; i++) { const m = new Date(nd[i].t * 1000).getUTCMonth(); tdom.push(i > 0 && new Date(nd[i - 1].t * 1000).getUTCMonth() === m ? tdom[i - 1] + 1 : 1); }
  for (let i = n - 1; i >= 0; i--) { const m = new Date(nd[i].t * 1000).getUTCMonth(); left[i] = i < n - 1 && new Date(nd[i + 1].t * 1000).getUTCMonth() === m ? left[i + 1] + 1 : 1; }
  const wd = nd.map((k) => new Date(k.t * 1000).getUTCDay());
  const trendF = { aucun: () => true, sma200: (i) => sm(200)[i] !== null && c[i] > sm(200)[i], sma100: (i) => sm(100)[i] !== null && c[i] > sm(100)[i] };

  const V = []; // variantes : { name, family, entry(i), exit(i, bars) }
  const add = (family, name, entry, exit, maxBars = 0) => V.push({ family, name, entry, exit, maxBars });
  for (const k of [3, 5, 7, 10, 15, 20]) for (const m of [3, 5, 10]) for (const tf of ['aucun', 'sma200', 'sma100'])
    add('repli', `plus bas ${k} j → plus haut ${m} j, filtre ${tf}`, (i) => c[i] <= lowN(k)[i] && trendF[tf](i), (i) => c[i] >= highN(m)[i - 1]);
  for (const k of [2, 3, 4, 5, 7, 14]) for (const x of [5, 10, 15, 20, 25, 30]) for (const ex of [50, 70])
    add('RSI', `RSI ${k} < ${x}, sortie > ${ex}, sma200`, (i) => rs(k)[i] !== null && rs(k)[i] < x && trendF.sma200(i), (i) => rs(k)[i] > ex);
  for (const k of [1, 2, 3, 5, 10]) for (const d of [1.5, 2, 3, 5, 8])
    add('chute', `−${d} % en ${k} j, sma200, sortie > plus haut de la veille`, (i) => ret(i, k) !== null && ret(i, k) < -d / 100 && trendF.sma200(i), (i) => c[i] > nd[i - 1].h, 10);
  for (const m of [20, 50, 100, 150, 200, 250]) for (const b of [0, 1, 2])
    add('moyenne', `prix > SMA ${m} (marge ${b} %)`, (i) => sm(m)[i] !== null && c[i] > sm(m)[i] * (1 + b / 100), (i) => c[i] < sm(m)[i] * (1 - b / 100));
  for (const [f, s] of [[5, 50], [10, 50], [20, 50], [10, 100], [20, 100], [50, 100], [20, 150], [50, 150], [20, 200], [50, 200], [100, 200], [5, 20], [10, 30]])
    add('croisement', `SMA ${f} > SMA ${s}`, (i) => sm(f)[i] !== null && sm(s)[i] !== null && sm(f)[i] > sm(s)[i], (i) => sm(f)[i] < sm(s)[i]);
  for (const k of [21, 63, 126, 189, 252]) for (const skip of [0, 21]) if (k > skip)
    add('momentum', `hausse sur ${k} j${skip ? ' sauf le dernier mois' : ''}`, (i) => i >= k && c[i - skip] / c[i - k] > 1, (i) => !(i >= k && c[i - skip] / c[i - k] > 1));
  for (const k of [20, 50, 100, 200, 252]) for (const m of [10, 20, 50]) if (m < k)
    add('cassure', `plus haut ${k} j → plus bas ${m} j`, (i) => c[i] >= highN(k)[i], (i) => c[i] <= lowN(m)[i]);
  for (const k of [-3, -2, -1, 1, 2, 3, 5]) for (const h of [1, 3, 5])
    add('calendrier', `${k < 0 ? `${-k}e dernier jour du mois` : `${k}e jour du mois`}, garder ${h} j`, (i) => (k < 0 ? left[i] === -k : tdom[i] === k), () => false, h);
  for (const d of [1, 2, 3, 4, 5]) add('jour', `achat à la clôture du ${['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'][d]}, 1 j`, (i) => wd[i] === d, () => false, 1);
  for (const f of [0.8, 1, 1.2]) for (const m of [50, 100, 200])
    add('volatilité', `volatilité 20 j < ${f} × moyenne 1 an, prix > SMA ${m}`, (i) => rv[i] !== null && rvAvg[i] && rv[i] < f * rvAvg[i] && c[i] > sm(m)[i], (i) => !(rv[i] < f * 1.1 * rvAvg[i]) || c[i] < sm(m)[i]);
  for (const [key, lab] of [['tnx', 'taux 10 ans'], ['dxy', 'dollar'], ['oil', 'pétrole'], ['gold', 'or'], ['vix', 'VIX'], ['spx', 'S&P 500']])
    for (const k of [5, 10, 20]) for (const d of [-8, -4, -2, 2, 4, 8])
      add('autres marchés', `${lab} ${d > 0 ? '+' : ''}${d} % en ${k} j, Nasdaq > SMA 50`, (i) => { const r = xret(key, i, k); return r !== null && (d < 0 ? r < d / 100 : r > d / 100) && c[i] > sm(50)[i]; }, () => false, k);

  // Rendement moyen d'une journée de Nasdaq par période (pour l'alpha)
  const dayMean = P.map(([, a, b]) => { let s = 0; let m = 0; for (let i = 1; i < n; i++) if (nd[i].t >= a && nd[i].t < b) { s += c[i] / c[i - 1] - 1; m++; } return (s / m) * 100; });
  const idxOf = new Map(nd.map((k, i) => [k.t, i]));
  const yrs = P.map(([, a, b]) => (Math.min(b, nd[n - 1].t) - Math.max(a, nd[0].t)) / (365.25 * 86400));

  const results = [];
  for (const v of V) {
    const strat = {
      id: 'grid', tf: '1d', warmup: 260,
      evaluate(ind, i) {
        return { entry: v.entry(i) ? 'long' : null, exitLong: false, exitShort: true, sl: 4 * A[i], tp: null };
      },
    };
    // sortie : par signal ou au bout de maxBars séances
    let openIdx = -1;
    strat.evaluate = (ind, i) => {
      const e = v.entry(i);
      const out = openIdx >= 0 && (v.exit(i) || (v.maxBars && i - openIdx >= v.maxBars));
      if (out) openIdx = -1;
      const sig = { entry: openIdx < 0 && !out && e ? 'long' : null, exitLong: out, exitShort: true, sl: 4 * A[i], tp: null };
      if (sig.entry) openIdx = i;
      return sig;
    };
    const r = backtest(strat, nd, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 86400, ind: { closes: c } });
    const per = P.map(([lab, a, b], k) => {
      const l = r.list.filter((t) => t.entryT >= a && t.entryT < b);
      const days = l.reduce((s, t) => s + Math.max(1, (idxOf.get(t.exitT) ?? 0) - (idxOf.get(t.entryT) ?? 0)), 0);
      const gain = l.reduce((s, t) => s + t.pnlPct, 0);
      return { lab, n: l.length, gain, alpha: (gain - days * dayMean[k]) / yrs[k], expo: days / (yrs[k] * 252) };
    });
    const chosen = per[0].alpha > 0 && per[1].alpha > 0 && per[0].n + per[1].n >= 30;
    results.push({ v, per, chosen, valid: chosen && per[2].alpha > 0 && per[2].n >= 10 });
  }

  const fam = [...new Set(V.map((v) => v.family))];
  console.log(`=== ${V.length} variantes testées sur ^NDX 1985–2026 (alpha = gain au-delà du simple fait d'être investi, %/an) ===\n`);
  console.log('FAMILLE'.padEnd(16) + 'testées  choisies (1985–2009)  confirmées (2010–2026)');
  for (const f of fam) {
    const r = results.filter((x) => x.v.family === f);
    console.log(`${f.padEnd(16)}${String(r.length).padStart(6)}  ${String(r.filter((x) => x.chosen).length).padStart(10)}            ${String(r.filter((x) => x.valid).length).padStart(8)}`);
  }
  const chosen = results.filter((x) => x.chosen);
  const valid = results.filter((x) => x.valid);
  console.log(`\nTotal : ${results.length} testées · ${chosen.length} choisies · ${valid.length} confirmées sur 2010–2026 (${chosen.length ? ((valid.length / chosen.length) * 100).toFixed(0) : 0} % des choisies)`);
  console.log('\nLes 25 meilleures confirmées (alpha %/an : 1985–1999 · 2000–2009 · 2010–2026 · part du temps investi 2010–2026) :');
  for (const x of valid.sort((a, b) => Math.min(...b.per.map((p) => p.alpha)) - Math.min(...a.per.map((p) => p.alpha))).slice(0, 25)) {
    console.log(`  [${x.v.family}] ${x.v.name.padEnd(56)} ${x.per.map((p) => `${p.alpha >= 0 ? '+' : ''}${p.alpha.toFixed(1)}`).join(' · ')} · ${(x.per[2].expo * 100).toFixed(0)} % · ${x.per[2].n} trades`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
