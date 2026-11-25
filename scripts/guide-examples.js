#!/usr/bin/env node
/**
 * Exemples réels pour le guide « trader sans le bot » du PDF (npm run pdf) : dernier trade de chaque stratégie type sur
 * les vraies données Yahoo (5 min sur 60 jours pour l'intraday, journalier sur 2 ans), avec les bougies du jour, les
 * niveaux utiles (range, déclencheur), l'entrée, le stop, l'objectif, la sortie et le résultat. Heures de Paris.
 *   node scripts/guide-examples.js > docs/guide-examples.json
 */
const { fetchYahoo } = require('../src/yahoo');
const { selectStrategies } = require('../src/strategies');
const { backtest } = require('../src/gold');
const { computeAll } = require('../src/indicators');
const { nySession } = require('../src/oanda');

const paris = (t) => new Date(t * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const parisDay = (t) => new Date(t * 1000).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const nyKey = (t) => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const lonKey = (t) => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const nyMin = (t) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value])); return (Number(p.hour) % 24) * 60 + Number(p.minute); };
const utcMin = (t) => Math.floor((t % 86400) / 60);

// Fiches : stratégie type, symbole Yahoo, unité de temps, niveaux à tracer
const FICHES = [
  { key: 'orb', sid: 'n_orb30l_t075', sym: '^NDX', tf: '5m', mk: 'nas100', maxRisk: 500, levels: (day) => rangeLv(day, (t) => nyMin(t) >= 570 && nyMin(t) < 600, 'range des 30 premières min') },
  { key: 'crabel', sid: 'n_crabel4_t05', sym: '^NDX', tf: '5m', mk: 'nas100', maxRisk: 500, levels: (day) => rangeLv(day, (t) => nyMin(t) >= 570 && nyMin(t) < 600, 'range des 30 premières min') },
  { key: 'williams', sid: 'n_wvb05_t075', sym: '^NDX', tf: '5m', mk: 'nas100', maxRisk: 500, levels: (day, prev) => williamsLv(day, prev, 0.5) },
  { key: 'mom', sid: 'n_mom10_t05', sym: '^NDX', tf: '5m', mk: 'nas100', maxRisk: 500, levels: () => [] },
  { key: 'londres', sid: 'g_orb30', sym: 'GC=F', tf: '5m', mk: 'gold', session: 'utc', levels: (day) => rangeLv(day, (t) => utcMin(t) >= 420 && utcMin(t) < 450, 'range 8 h – 8 h 30 (Paris, hiver)') },
  { key: 'asie', sid: 'g_asiabrk', sym: 'GC=F', tf: '5m', mk: 'gold', session: 'utc', levels: (day) => rangeLv(day, (t) => utcMin(t) < 420, 'range de la nuit asiatique') },
  { key: 'repli', sid: 'rsi2', sym: '^GSPC', tf: '1d', mk: 'spx', maxRisk: 370 },
  { key: 'double7', sid: 'double7', sym: '^GSPC', tf: '1d', mk: 'spx', maxRisk: 370 },
];
function rangeLv(day, inRange, label) {
  const r = day.filter((c) => inRange(c.t));
  if (!r.length) return [];
  return [{ v: Math.max(...r.map((c) => c.h)), label: `haut du ${label}` }, { v: Math.min(...r.map((c) => c.l)), label: `bas du ${label}` }];
}
function williamsLv(day, prev, k) {
  if (!day.length || !prev.length) return [];
  const amp = Math.max(...prev.map((c) => c.h)) - Math.min(...prev.map((c) => c.l));
  const o = day[0].o;
  return [{ v: o, label: 'ouverture' }, { v: o + k * amp, label: `ouverture + ${String(k).replace('.', ',')} × amplitude de la veille` }, { v: o - k * amp, label: `ouverture − ${String(k).replace('.', ',')} × amplitude de la veille` }];
}

const rOf = (t) => ((t.exit - t.entry) / Math.abs(t.entry - t.initSl)) * (t.side === 'long' ? 1 : -1);
const pick = (list, maxRisk = Infinity) => [...list].reverse().find((t) => rOf(t) > 0.2 && Math.abs(t.entry - t.initSl) <= maxRisk) || [...list].reverse().find((t) => rOf(t) > 0.2) || list[list.length - 1];
const statsOf = (list) => ({ n: list.length, win: list.length ? (list.filter((t) => rOf(t) > 0).length / list.length) * 100 : 0, avgR: list.length ? list.reduce((a, t) => a + rOf(t), 0) / list.length : 0,
  since: list.length ? parisDay(list[0].entryT) : null });

(async () => {
  const out = {};
  const vix = await fetchYahoo('^VIX', '1d', { range: '2y' }).catch(() => null);
  for (const F of FICHES) {
    const s = selectStrategies([F.sid])[0];
    try {
      if (F.tf === '1d') {
        const d = (await fetchYahoo(F.sym, '1d', { range: '2y' })).filter((k) => k.c > 0);
        const ind = computeAll(d, d, 86400, null, vix, {});
        const list = backtest(s, d, { size: 1000, feePct: 0, barSec: 86400, ind, daily: d, vix }).list;
        const t = pick(list, F.maxRisk);
        const i0 = d.findIndex((k) => k.t >= t.entryT);
        const i1 = d.findIndex((k) => k.t >= t.exitT);
        const sma200 = d.map((_, i) => (i >= 199 ? d.slice(i - 199, i + 1).reduce((a, k) => a + k.c, 0) / 200 : null));
        const sma5 = d.map((_, i) => (i >= 4 ? d.slice(i - 4, i + 1).reduce((a, k) => a + k.c, 0) / 5 : null));
        const from = Math.max(0, i0 - 25); const to = Math.min(d.length, i1 + 6);
        out[F.key] = { ...statsOf(list), sid: F.sid, name: s.name, sym: F.sym, tf: F.tf, side: t.side, entry: t.entry, sl: t.initSl, tp: t.tp, exit: t.exit, reason: t.reason,
          entryDay: parisDay(t.entryT), exitDay: parisDay(t.exitT), r: (t.exit - t.entry) / Math.abs(t.entry - t.initSl) * (t.side === 'long' ? 1 : -1),
          candles: d.slice(from, to).map((k, j) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, sma200: sma200[from + j], sma5: sma5[from + j] })), entryIdx: i0 - from, exitIdx: i1 - from };
        continue;
      }
      let c = (await fetchYahoo(F.sym, '5m', { range: '60d' })).filter((k) => k.c > 0);
      if (F.mk !== 'gold') c = nySession(c);
      const list = backtest(s, c, { size: 1000, feePct: 0, barSec: 300, market: F.mk }).list;
      // Dernier trade gagnant ; jour (NY pour les indices, UTC pour l'or) et bougies de ce jour
      const t = pick(list, F.maxRisk);
      const keyOf = F.mk === 'gold' ? (x) => new Date(x * 1000).toISOString().slice(0, 10) : nyKey;
      const k0 = keyOf(t.entryT);
      const day = c.filter((k) => keyOf(k.t) === k0 && (F.mk !== 'gold' || (utcMin(k.t) < 20 * 60)));
      const days = [...new Set(c.map((k) => keyOf(k.t)))];
      const prevKey = days[days.indexOf(k0) - 1];
      const prev = c.filter((k) => keyOf(k.t) === prevKey);
      const risk = Math.abs(t.entry - t.initSl);
      out[F.key] = { ...statsOf(list), sid: F.sid, name: s.name, sym: F.sym, tf: F.tf, side: t.side, entry: t.entry, sl: t.initSl, tp: t.tp, exit: t.exit, reason: t.reason,
        day: parisDay(t.entryT), entryTime: paris(t.entryT + 300), exitTime: paris(t.exitT), risk, r: ((t.exit - t.entry) / risk) * (t.side === 'long' ? 1 : -1),
        levels: F.levels(day, prev), candles: day.map((k) => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, hm: paris(k.t) })),
        entryIdx: day.findIndex((k) => k.t === t.entryT), exitIdx: day.findIndex((k) => k.t >= t.exitT) };
      void lonKey;
    } catch (err) {
      out[F.key] = { error: err.message };
    }
  }
  process.stdout.write(JSON.stringify(out));
})();
