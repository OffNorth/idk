#!/usr/bin/env node
/**
 * Plusieurs objectifs sur un trade (sorties partielles) pour le compte FTMO (npm run ftmo-partial).
 * Chaque trade est découpé : une part fermée à un objectif fixe (en R), le reste suivi par le stop suiveur actuel du
 * compte (dès +2 R, stop à 1 R du meilleur cours). Le trade combiné = moyenne pondérée des parts (même entrée, même stop).
 *   Variantes : ½ à +1 R · ½ à +1,5 R · ½ à +2 R · ⅓ à +1 R + ⅓ à +2 R · (référence : tout au stop suiveur).
 * Mesures, sur l'historique complet (2009–19 | 2020–26 | nov. 24–26) :
 *   - évaluation : réussite du challenge 1 étape en moins d'un an (délai médian) ;
 *   - compte financé (départ chaque semaine, 12 mois, retrait de tout le gain tous les 14 jours, 80 % pour le trader) :
 *     retraits moyens pour le trader et part des comptes perdus (perte du jour ou perte max) en 12 mois.
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, fundedRun } = require('./src/ftmo');
const { RULES } = require('./src/sizing');
const { buildTrades } = require('./src/ftmoTrades');
const { accountOf } = require('./src/ftmoAccount');
const { selectStrategies } = require('./src/strategies');
const { nySession } = require('./src/oanda');
const { polygonBars } = require('./src/polygon');
const { withTp } = require('./src/sessions');

const CACHE = path.join(__dirname, 'data', 'research');
const Y = (y) => Date.UTC(y, 0, 1) / 1000;
const DAY = 86400;
const ACT = cfg.ftmoTrailActR || 2;
const DIST = cfg.ftmoTrailDistR ?? 1;

function withTrail(s) {
  return {
    ...s,
    trail(pos, ind, i) {
      const prev = s.trail ? s.trail(pos, ind, i) : NaN;
      const long = pos.side === 'long';
      const r = Math.abs(pos.entry - pos.initSl);
      const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
      if (!(fav >= ACT * r)) return prev;
      const next = long ? pos.best - DIST * r : pos.best + DIST * r;
      if (!Number.isFinite(prev)) return next;
      return long ? Math.max(prev, next) : Math.min(prev, next);
    },
  };
}
// Une part = objectif fixe k R (null = stop suiveur seul)
const part = (k) => (s) => { const t = withTrail(s); return k ? withTp(t, k, s.id, s.name) : t; };
const VARIANTS = {
  'tout au stop suiveur (actuel)': [[1, null]],
  '½ à +1 R, ½ suiveur': [[0.5, 1], [0.5, null]],
  '½ à +1,5 R, ½ suiveur': [[0.5, 1.5], [0.5, null]],
  '½ à +2 R, ½ suiveur': [[0.5, 2], [0.5, null]],
  '⅓ +1 R, ⅓ +2 R, ⅓ suiveur': [[1 / 3, 1], [1 / 3, 2], [1 / 3, null]],
};

(async () => {
  const A = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const isIntra = (s) => s.tf && s.tf !== '1d';
  const lists = {};
  let A0 = 0;
  const listOf = async (k) => {
    if (lists[k ?? 'x']) return lists[k ?? 'x'];
    const wrap = part(k);
    const { all, q5 } = await buildTrades(cfg, CACHE, { wrap });
    A0 = q5[0].t + 30 * DAY;
    const base = all.filter((t) => sids.includes(t.sid) && !(t.intraday && t.market === 'nas100'));
    const nas = sids.filter((x) => x.startsWith('nas100:') && isIntra(strat(x)[1])).flatMap((x) => backtest(wrap(strat(x)[1]), qs, { size: 1000, feePct: 0.003, financingPct: 6, barSec: 300, market: 'nas100' })
      .list.map((t) => ({ ...t, sid: x, market: 'nas100', intraday: true })));
    return (lists[k ?? 'x'] = [...base, ...nas].map((t) => ({ ...t, riskPct: A.riskOf(...strat(t.sid)) })));
  };
  // Trade combiné : même entrée / stop que la part « suiveur », résultat = moyenne pondérée des parts
  const combine = async (spec) => {
    const parts = await Promise.all(spec.map(async ([w, k]) => [w, await listOf(k)]));
    const key = (t) => `${t.sid}|${t.entryT}`;
    const maps = parts.map(([w, l]) => [w, new Map(l.map((t) => [key(t), t]))]);
    const ref = parts.find(([, , k]) => k == null)?.[1] || (await listOf(null));
    return ref.map((t) => {
      let pnl = 0; let exitT = t.exitT;
      for (const [w, m] of maps) { const u = m.get(key(t)) || t; pnl += w * u.pnlPct; exitT = Math.max(exitT, u.exitT); }
      return { ...t, pnlPct: pnl, exitT };
    });
  };
  const sizer = RULES[cfg.ftmoSizing];
  const RF = { steps: 1, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer };
  const per = (l) => Object.entries({ B: [Y(2009) + 60 * DAY, Y(2020)], C: [Y(2020), Infinity], A: [A0, Infinity] }).map(([k, [a, b]]) => {
    const x = l.filter((t) => t.entryT >= a && t.entryT < b && (k === 'A' || !(t.intraday && t.market !== 'gold')));
    const c = challengeStats(x, { horizonDays: 365, start: a, ...(Number.isFinite(b) ? { end: b } : {}), ...RF });
    return `${c.passRate.toFixed(0).padStart(3)} % (${c.medianDays ? c.medianDays.toFixed(0) : '—'} j)`;
  }).join(' | ');
  const funded = (l) => {
    // 2009–2026 sans intraday hors or (comme les périodes longues), départ chaque semaine, 12 mois
    const x = l.filter((t) => !(t.intraday && t.market !== 'gold'));
    const opts = { ...RF, capital: 100_000, funded: { rule: 'ftmo', every: 14, days: 365 } };
    let n = 0; let paid = 0; let lost = 0;
    for (let s = Y(2009) + 60 * DAY; s < Y(2025); s += 7 * DAY) {
      const r = fundedRun(x, opts, s);
      n++; paid += r.paid * 0.8; if (r.lost && r.months <= 12) lost++;
    }
    return `retraits moyens ${Math.round(paid / n).toLocaleString('fr-FR').padStart(7)} $ · comptes perdus en 12 mois ${((lost / n) * 100).toFixed(0)} %`;
  };
  console.log('FTMO · évaluation : réussite < 1 an (délai) 2009–19 | 2020–26 | nov. 24–26  ||  compte financé 12 mois (2009–2024)');
  for (const [name, spec] of Object.entries(VARIANTS)) {
    const l = await combine(spec);
    console.log(`${name.padEnd(30)} ${per(l)}  ||  ${funded(l)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
