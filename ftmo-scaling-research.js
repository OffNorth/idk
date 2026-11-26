#!/usr/bin/env node
/**
 * Compte FTMO financé avec le vrai scaling (npm run ftmo-scaling), règles officielles FTMO (ftmo.com, scaling plan, nov. 2026) :
 *   tous les 4 mois, si le gain net de la période atteint +10 % du solde de départ, avec au moins 2 retraits et un solde positif
 *   → solde + 25 % du capital initial (hypothèse : +25 000 $ par palier sur un 100K), plafond 2 000 000 $ tous comptes confondus.
 *   Retraits des gains tous les 14 jours, 90 % pour le trader (challenge 1 étape). Sorties partielles + stop suiveur (réglage
 *   actuel du compte financé). Départ chaque semaine 2009–2023, 3 ans au plus.
 * Mesures selon le risque (× du risque d'évaluation) : comptes en vie, paliers atteints, revenu du trader par mois (année 1 / 2 / 3),
 * puis le total avec 1, 2 ou 3 comptes identiques (mêmes trades : ils gagnent et perdent ensemble).
 */
const path = require('path');
const cfg = require('./src/config');
const { backtest } = require('./src/gold');
const { aggregate } = require('./src/history');
const { challengeStats, runPhase } = require('./src/ftmo');
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
const withTrail = (s) => ({
  ...s,
  trail(pos, ind, i) {
    const prev = s.trail ? s.trail(pos, ind, i) : NaN;
    const long = pos.side === 'long'; const r = Math.abs(pos.entry - pos.initSl);
    const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
    if (!(fav >= ACT * r)) return prev;
    const next = long ? pos.best - DIST * r : pos.best + DIST * r;
    return Number.isFinite(prev) ? (long ? Math.max(prev, next) : Math.min(prev, next)) : next;
  },
});
const part = (k) => (s) => { const t = withTrail(s); return k ? withTp(t, k, s.id, s.name) : t; };

(async () => {
  const A = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const strat = (sid) => { const [m, id] = sid.split(':'); return [m, selectStrategies([id])[0] || { id, tf: '1d' }]; };
  const qs = nySession(aggregate(await polygonBars(CACHE, 'QQQ', 1, '2024-11-18', { maxAgeH: Infinity }), 300, 60));
  const sids = A.strategies.filter((k) => A.riskOf(...strat(k)) > 0);
  const isIntra = (s) => s.tf && s.tf !== '1d';
  let A0 = 0;
  const lists = {};
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
  const evalList = await listOf(null);
  // Compte financé : ⅓ +1 R, ⅓ +2 R, ⅓ stop suiveur (trade combiné)
  const l1 = new Map((await listOf(1)).map((t) => [`${t.sid}|${t.entryT}`, t]));
  const l2 = new Map((await listOf(2)).map((t) => [`${t.sid}|${t.entryT}`, t]));
  const fundList = evalList.map((t) => { const a = l1.get(`${t.sid}|${t.entryT}`) || t; const b = l2.get(`${t.sid}|${t.entryT}`) || t;
    return { ...t, pnlPct: (t.pnlPct + a.pnlPct + b.pnlPct) / 3, exitT: Math.max(t.exitT, a.exitT, b.exitT) }; });

  const sizer = RULES[cfg.ftmoSizing];
  const RF = { steps: 1, capital: 100_000, target: 10, dailyPct: 3, maxPct: 10, trailingMax: true, bestDayPct: 50, minDays: 4, dayStopPct: cfg.ftmoDayStop, riskPct: 1, sizer };

  const fl = fundList.filter((t) => !(t.intraday && t.market !== 'gold'));
  const C0 = 100_000; const PERIOD = 4 * 30.4 * DAY; const MONTH = 30.4 * DAY;
  console.log('=== FTMO 1 étape 100K financé, scaling officiel (départ chaque semaine 2009–2023, 36 mois) ===');
  console.log('risque     en vie 12/24/36 mois · paliers (moy. / ≥1 / ≥4) · revenu trader par mois : an 1 / an 2 / an 3 · moyenne 36 mois');
  const rows = [];
  for (const mul of [0.25, 0.35, 0.5, 0.75, 1]) {
    const list = fl.map((t) => ({ ...t, riskPct: t.riskPct * mul }));
    let n = 0, a12 = 0, a24 = 0, a36 = 0, ups = 0, up1 = 0, up4 = 0, lifeSum = 0;
    const inc = [0, 0, 0];
    for (let s = Y(2009) + 60 * DAY; s < Y(2023); s += 7 * DAY) {
      n++;
      const until = s + 36 * MONTH;
      let C = C0, bal = C0, t = s, lastPay = s, k = 0, alive = true, end = until;
      while (t < until) {
        const segEnd = Math.min(t + PERIOD, until);
        const paid = [];
        const payout = ({ t: tt, balance, capital }) => { const g = balance - capital; if (tt - lastPay < 14 * DAY || g <= 0) return 0; lastPay = tt; paid.push(tt); return g; };
        const r = runPhase(list, { ...RF, bestDayPct: 0, capital: C, from: t, until: segEnd, target: Infinity, payout, start: { balance: bal, peak: bal } });
        for (const p of r.paid) { const m = Math.floor((p.t - s) / (12 * MONTH)); if (m < 3) inc[m] += p.amount * 0.9; }
        if (r.outcome === 'daily' || r.outcome === 'maxloss') { alive = false; end = r.at; break; }
        const profit = r.balance - bal + r.paid.reduce((x, p) => x + p.amount, 0);
        bal = r.balance;
        if (segEnd - t >= PERIOD - DAY && profit >= 0.10 * C && r.paid.length >= 2 && bal > 0 && C < 2_000_000) { C = Math.min(C + 0.25 * C0, 2_000_000); bal += 0.25 * C0; k++; }
        t = segEnd;
      }
      const life = (end - s) / MONTH;
      lifeSum += Math.min(36, life);
      if (life >= 12) a12++; if (life >= 24) a24++; if (alive || life >= 36 - 0.5) a36++;
      ups += k; if (k >= 1) up1++; if (k >= 4) up4++;
    }
    const pc = (x) => `${Math.round((x / n) * 100)} %`;
    const m = inc.map((x) => x / n / 12);
    rows.push({ mul, m, avg: (inc[0] + inc[1] + inc[2]) / n / 36, life: lifeSum / n, perLife: (inc[0] + inc[1] + inc[2]) / n, alive36: a36 / n });
    console.log(`× ${String(mul).replace('.', ',').padEnd(6)} ${pc(a12).padStart(5)} / ${pc(a24).padStart(5)} / ${pc(a36).padStart(5)} · ${(ups / n).toFixed(1)} / ${pc(up1)} / ${pc(up4)} · ${m.map((x) => `${Math.round(x).toLocaleString('fr-FR')} $`.padStart(8)).join(' /')} · ${Math.round((inc[0] + inc[1] + inc[2]) / n / 36).toLocaleString('fr-FR')} $`);
  }
  // Avec rachat : compte perdu → nouveau challenge (réussite ≈ 55 %, ≈ 1,7 mois par tentative, prix remboursé au 1er retrait,
  // tentatives ratées perdues : hypothèse 600 $ le challenge 100K). Régime permanent : gain d'une vie de compte ÷ (durée + attente).
  const P = 0.55, TRY = 1.7, FEE = 600;
  console.log('\nAvec rachat après une perte (réussite 55 %, 1,7 mois par tentative, 600 $ par challenge raté) :');
  for (const r of rows) {
    const wait = r.alive36 >= 0.999 ? 0 : TRY / P;
    const lost = r.alive36 >= 0.999 ? 0 : (1 / P - 1) * FEE;
    // Compte encore en vie à 36 mois : pas de rachat dans la fenêtre ; sinon cycle vie + attente
    const v = (r.perLife - (1 - r.alive36) * lost) / (r.life + (1 - r.alive36) * wait);
    console.log(`× ${String(r.mul).replace('.', ',').padEnd(6)} durée de vie moyenne ${r.life.toFixed(1)} mois (sur 36) · ${Math.round(r.perLife).toLocaleString('fr-FR')} $ par compte · avec rachat ≈ ${Math.round(v)} $/mois`);
  }
  console.log('\nPlusieurs comptes identiques : revenu × N, mais ils sont perdus ensemble (mêmes trades, même jour).');
  for (const r of rows) console.log(`× ${String(r.mul).replace('.', ',').padEnd(6)} 1 compte ${Math.round(r.avg)} $/mois · 2 comptes ${Math.round(2 * r.avg)} $ · 3 comptes ${Math.round(3 * r.avg)} $`);
})().catch((e) => { console.error(e); process.exit(1); });
