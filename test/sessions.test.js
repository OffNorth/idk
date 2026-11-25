const test = require('node:test');
const assert = require('node:assert');
const { backtest } = require('../src/gold');
const { selectStrategies } = require('../src/strategies');

const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
/** Bougies 5 min sur plusieurs jours ; px(t) donne le cours. */
function candles(fromIso, days, px) {
  const out = [];
  const t0 = Date.parse(fromIso) / 1000;
  for (let t = t0; t < t0 + days * 86400; t += 300) {
    const c = px(t);
    out.push({ t, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });
  }
  return out;
}
const run = (id, c) => backtest(selectStrategies([id])[0], c, { size: 1000, feePct: 0.005, barSec: 300, market: 'gold' }).list;

test('g_asiabrk : range 0 h → 7 h UTC, une seule cassure par jour avant 11 h, sortie 19 h UTC', () => {
  const iso = '2026-03-02T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  const c = candles(iso, 4, (t) => {
    if (t < day) return 4000 + Math.sin(t / 900);
    const h = (t - day) / 3600;
    return h < 7 ? 4000 + (h % 1 < 0.5 ? 2 : -2) : h < 8 ? 4000 : 4010; // cassure du plus haut (4 002,5) à 8 h
  });
  const tr = run('g_asiabrk', c).filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(hhmm(tr[0].entryT), '08:00');
  assert.strictEqual(hhmm(tr[0].exitT), '19:00');
  assert.ok(Math.abs(tr[0].initSl - 3997.5) < 1e-9, 'stop sous le plus bas du range asiatique');
});

test('g_nypdl / n_pdlbrk : cassure du plus haut de la veille, une entrée par jour, sortie à l’heure (New York)', () => {
  // Hiver : New York = UTC − 5. Veille plate à 4 000 (± 1), jour J : 4 010 à partir de 15 h UTC (10 h NY)
  const iso = '2026-01-12T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  const c = candles(iso, 4, (t) => (t < day + 15 * 3600 ? 4000 + Math.sin(t / 900) : 4010));
  const tr = run('g_nypdl', c).filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(hhmm(tr[0].entryT), '15:00');
  assert.strictEqual(hhmm(tr[0].exitT), '21:55', 'sortie 16 h 55 NY');
  const n = backtest(selectStrategies(['n_pdlbrk'])[0], candles(iso, 4, (t) => (t < day + 15 * 3600 ? 26000 + Math.sin(t / 900) * 5 : 26100)), { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' }).list.filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(n.length, 1);
  assert.strictEqual(hhmm(n[0].entryT), '15:00');
  assert.strictEqual(hhmm(n[0].exitT), '20:55', 'sortie 15 h 55 NY');
});

test('séances : g_asiabrk, g_nypdl sur le compte FTMO, n_pdlbrk retirée ; pas sur Lucid (variantes « objectif 0,5 R » à la place)', () => {
  const cfg = require('../src/config');
  assert.ok(cfg.ftmoStrategies.includes('gold:g_asiabrk') && cfg.ftmoStrategies.includes('gold:g_nypdl'));
  assert.ok(!cfg.ftmoNasStrategies.includes('nas100:n_pdlbrk'), 'n_pdlbrk retirée du compte FTMO');
  const L = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  assert.strictEqual(L.riskOf('nas100', { id: 'n_pdlbrk', tf: '5m' }), 0);
  assert.ok(L.riskOf('nas100', { id: 'n_mom10_t05', tf: '5m' }) > 0);
  assert.strictEqual(L.riskOf('nas100', { id: 'n_noise_t05', tf: '5m' }), 0, 'retirée (faible avantage, npm run speed)');
  assert.strictEqual(L.riskOf('nas100', { id: 'ibs', tf: '1d' }), 0, 'LUCID_EXCLUDE');
  assert.strictEqual(require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true }, 'gold').riskOf('gold', { id: 'down3', tf: '1d' }), cfg.ftmoRisk * cfg.ftmoRiskMul, 'FTMO × FTMO_RISK_MUL');
  assert.strictEqual(L.riskOf('gold', { id: 'down3', tf: '1d' }), cfg.ftmoRisk * cfg.lucidRiskMul, 'Lucid sans FTMO_RISK_MUL');
  assert.strictEqual(L.riskOf('nas100', { id: 'n_noise', tf: '5m' }), 0, 'Lucid ne prend plus l’originale');
  assert.strictEqual(L.riskOf('gold', { id: 'g_nypdl', tf: '5m' }), 0);
  assert.strictEqual(L.riskOf('gold', { id: 'g_asiabrk', tf: '5m' }), 0);
});

test('variantes Lucid « objectif 0,5 R » : même entrée et même stop que l’originale, gain pris à 0,5 × le risque', () => {
  const base = selectStrategies(['n_orb5s'])[0];
  const v = selectStrategies(['n_orb5s_t05'])[0];
  assert.ok(v && v.tf === base.tf);
  const iso = '2026-01-12T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  // Ouverture 26 000, cassure du plus bas des 5 premières min puis baisse régulière
  const c = candles(iso, 4, (t) => (t < day + 14.5 * 3600 ? 26000 + Math.sin(t / 900) * 5 : 26000 - ((t - day - 14.5 * 3600) / 300) * 4));
  const opt = { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' };
  const a = backtest(base, c, opt).list.filter((x) => x.entryT >= day);
  const b = backtest(v, c, opt).list.filter((x) => x.entryT >= day);
  assert.ok(a.length && b.length);
  assert.strictEqual(b[0].entryT, a[0].entryT);
  assert.strictEqual(b[0].initSl, a[0].initSl);
  assert.strictEqual(b[0].reason, 'take profit');
  assert.ok(Math.abs((b[0].entry - b[0].exit) - 0.5 * (b[0].initSl - b[0].entry)) < 1e-6, 'objectif à 0,5 R');
});

test('Lucid : cassures du Nasdaq avec objectif (n_orb10l_t075, n_orb30l_t075, n_or60_t05)', () => {
  const cfg = require('../src/config');
  const L = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  for (const id of ['n_orb10l_t075', 'n_orb30l_t075', 'n_or60_t05']) {
    assert.ok(selectStrategies([id])[0], id);
    assert.ok(L.riskOf('nas100', { id, tf: '5m' }) > 0, id);
  }
  // Cassure à la hausse des 10 premières min (hiver : 9 h 30 NY = 14 h 30 UTC), objectif 0,75 R
  const iso = '2026-01-12T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  const c = candles(iso, 4, (t) => { const h = (t - day) / 3600; return t < day ? 26000 + Math.sin(t / 900) * 5 : h < 14.5 ? 26000 : h < 14.67 ? 26000 + (h % 0.1 < 0.05 ? 10 : -10) : 26000 + (h - 14.67) * 200; });
  const tr = backtest(selectStrategies(['n_orb10l_t075'])[0], c, { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' }).list.filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(tr[0].reason, 'take profit');
  assert.ok(Math.abs((tr[0].exit - tr[0].entry) - 0.75 * (tr[0].entry - tr[0].initSl)) < 1e-6, 'objectif 0,75 R');
});

test('Crabel NR4 (n_crabel4_t05, Lucid) : pas de trade sans journée étroite la veille, cassure du range des 30 premières min sinon', () => {
  const cfg = require('../src/config');
  const L = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  assert.ok(L.riskOf('nas100', { id: 'n_crabel4_t05', tf: '5m' }) > 0);
  const s = selectStrategies(['n_crabel4_t05'])[0];
  const start = Date.parse('2026-01-05T00:00:00Z') / 1000;
  const days = 30;
  // Séances de 14 h 30 à 21 h UTC (hiver) ; amplitude ± 40 sauf la veille du dernier jour (± 5 : NR4) ; dernier jour : cassure à la hausse
  const amp = (d) => (d === days - 2 ? 5 : 40);
  const c = [];
  for (let d = 0; d < days; d++) {
    const t0 = start + d * 86400;
    if ([0, 6].includes(new Date(t0 * 1000).getUTCDay())) continue;
    for (let t = t0 + 14.5 * 3600; t < t0 + 21 * 3600; t += 300) {
      const k = (t - t0 - 14.5 * 3600) / 300;
      const last = d === days - 1;
      const px = last ? (k < 6 ? 26000 + (k % 2 ? 4 : -4) : 26000 + (k - 5) * 20) : 26000 + (k % 2 ? amp(d) : -amp(d));
      c.push({ t, o: px, h: px + 1, l: px - 1, c: px, v: 1 });
    }
  }
  const tr = backtest(s, c, { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' }).list;
  assert.ok(tr.length >= 1, 'un trade le jour après la journée NR4');
  const last = tr[tr.length - 1];
  assert.strictEqual(last.side, 'long');
  assert.ok(last.entryT >= start + (days - 1) * 86400, 'seulement le dernier jour');
  assert.strictEqual(last.reason, 'take profit');
});

test('Williams (cassure de volatilité) : achat au-dessus de l’ouverture + k × amplitude de la veille, stop à l’ouverture ; sur Lucid seulement', () => {
  const cfg = require('../src/config');
  const F = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const L = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  for (const id of ['n_crabel7_15_t075', 'n_wvb05_t075', 'n_wvb07_t05']) assert.ok(L.riskOf('nas100', { id, tf: '5m' }) > 0, id);
  assert.ok(!F.strategies.some((k) => /nas100:n_(crabel|wvb)/.test(k)), 'versions Nasdaq pas sur le compte FTMO');
  const s = selectStrategies(['n_wvb05'])[0];
  const start = Date.parse('2026-01-05T00:00:00Z') / 1000;
  const c = [];
  let lastDay = 0;
  for (let d = 0; d < 32; d++) {
    const t0 = start + d * 86400;
    if ([0, 6].includes(new Date(t0 * 1000).getUTCDay())) continue;
    lastDay = t0;
    for (let t = t0 + 14.5 * 3600; t < t0 + 21 * 3600; t += 300) {
      const k = (t - t0 - 14.5 * 3600) / 300;
      // séances de ± 20 autour de 26 000 (amplitude 40) ; dernier jour : +30 à 11 h NY (> ouverture + 0,5 × 40)
      const px = d === 31 && k >= 18 ? 26030 : 26000 + (k % 2 ? 20 : -20) * (d === 31 ? 0.25 : 1);
      c.push({ t, o: px, h: px + 0.5, l: px - 0.5, c: px, v: 1 });
    }
  }
  const tr = backtest(s, c, { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' }).list.filter((x) => x.entryT >= lastDay);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(new Date(tr[0].entryT * 1000).toISOString().slice(11, 16), '16:00', 'clôture de la bougie de 11 h NY');
  assert.ok(Math.abs(tr[0].initSl - 25995) < 1e-6, 'stop à l’ouverture du jour');
});

test('S&P 500 : Crabel NR7 30 min (s_crabel7_30) sur le compte FTMO seulement, marché S&P', () => {
  const cfg = require('../src/config');
  const { accountOf } = require('../src/ftmoAccount');
  const s = selectStrategies(['s_crabel7_30'])[0];
  assert.deepStrictEqual(s.markets, ['spx']);
  assert.ok(cfg.ftmoStrategies.includes('spx:s_crabel7_30'));
  assert.ok(accountOf({ ...cfg, ftmoEnabled: true }, 'gold').riskOf('spx', s) > 0);
  assert.strictEqual(accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid').riskOf('spx', s), 0);
  assert.ok(selectStrategies(cfg.spxStrategies).some((x) => x.id === 's_crabel7_30'), 'paper S&P');
});

test('Argent et Dow Jones : marchés du compte Lucid (micro SIL / MYM), heure de New York, séance seule ; pas sur FTMO', async () => {
  const cfg = require('../src/config');
  const { accountOf, MICRO } = require('../src/ftmoAccount');
  const { marketById } = require('../src/markets');
  const L = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const F = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  for (const [id, sid, contract] of [['silver', 'n_wvb05_t075', 'SIL'], ['dow', 'n_mom10_t1be', 'MYM']]) {
    const s = selectStrategies([sid])[0];
    assert.strictEqual(L.riskOf(id, s, 'funded'), cfg.lucidIntradayRisk, `${id} : risque intraday Lucid (financé)`);
    assert.strictEqual(L.riskOf(id, s, 1), cfg.lucidIntradayRisk * cfg.lucidEvalIntradayMul, `${id} : risque majoré pendant l'évaluation`);
    assert.ok(!F.strategies.includes(`${id}:${sid}`), `${id} : pas sur FTMO`);
    assert.strictEqual(MICRO[id].name, contract);
    assert.ok(selectStrategies(cfg[`${id}Strategies`]).some((x) => x.id === sid), `${id} : paper`);
    // Bougies 24 h sur 24 (comme le future SI=F) → seulement 9 h 30 – 16 h New York
    const t0 = Date.parse('2026-11-23T00:00:00Z') / 1000;
    const all = Array.from({ length: 288 }, (_, k) => ({ t: t0 + k * 300, o: 50, h: 50, l: 50, c: 50, v: 1 }));
    const m = marketById({ ...cfg, oandaToken: '' }, id);
    assert.ok(m.session && m.enabled);
    // Marché « nas100 » et marché du Dow : mêmes minutes de New York pour les stratégies 5 min
    const { computeScalp2 } = require('../src/scalp2');
    assert.deepStrictEqual(computeScalp2(all, 300, id).min.slice(0, 3), computeScalp2(all, 300, 'nas100').min.slice(0, 3));
    assert.strictEqual(require('../src/oanda').nySession(all).length, 78);
  }
});

test('Lucid : Double 7 et RSI 2 sur le S&P 500 (journalières propres à Lucid), Dow en break-even (n_mom10_t1be)', () => {
  const cfg = require('../src/config');
  const { accountOf } = require('../src/ftmoAccount');
  const L = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const F = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  for (const id of ['double7', 'rsi2']) {
    const s = selectStrategies([id])[0];
    assert.ok(L.strategies.includes(`spx:${id}`));
    assert.strictEqual(L.riskOf('spx', s), cfg.ftmoSpxRisk * cfg.lucidRiskMul, `spx:${id} au risque des journalières Lucid`);
    assert.ok(!F.strategies.includes(`spx:${id}`), 'pas sur FTMO');
    assert.ok(selectStrategies(cfg.spxStrategies).some((x) => x.id === id), 'paper S&P');
  }
  // Break-even : objectif 1 R ; après +0,5 R le stop remonte au prix d'entrée (jamais redescendu)
  const be = selectStrategies(['n_mom10_t1be'])[0];
  assert.ok(cfg.lucidIntradayStrategies.includes('dow:n_mom10_t1be') && !cfg.lucidIntradayStrategies.includes('dow:n_mom10_t05'));
  assert.ok(cfg.lucidIntradayStrategies.includes('spx:n_mom10_t1be') && selectStrategies(cfg.spxStrategies).some((x) => x.id === 'n_mom10_t1be'), 'S&P en break-even (Lucid)');
  const pos = { side: 'long', entry: 100, initSl: 98, sl: 98, best: 100.9 };
  assert.ok(!Number.isFinite(be.trail(pos, {}, 0)), 'pas encore +0,5 R');
  pos.best = 101;
  assert.strictEqual(be.trail(pos, {}, 0), 100);
  const sh = { side: 'short', entry: 100, initSl: 102, sl: 102, best: 98.9 };
  assert.strictEqual(be.trail(sh, {}, 0), 100);
});

test('Lucid : risque intraday × LUCID_EVAL_INTRADAY_MUL pendant l’évaluation, normal une fois financé ; journalières et FTMO inchangés', () => {
  const cfg = { ...require('../src/config'), ftmoEnabled: true, lucidEnabled: true, lucidIntradayRisk: 0.45, lucidEvalIntradayMul: 3 };
  const { accountOf } = require('../src/ftmoAccount');
  const L = accountOf(cfg, 'lucid');
  const n = selectStrategies(['n_mom10_t05'])[0];
  assert.ok(Math.abs(L.riskOf('nas100', n, 1) - 1.35) < 1e-9);
  assert.ok(Math.abs(L.riskOf('nas100', n, 2) - 1.35) < 1e-9);
  assert.strictEqual(L.riskOf('nas100', n, 'funded'), 0.45);
  const d = selectStrategies(['double7'])[0];
  assert.strictEqual(L.riskOf('spx', d, 1), L.riskOf('spx', d, 'funded'), 'journalières inchangées');
  const F = accountOf({ ...cfg, ftmoEvalIntradayMul: 2, ftmoFundedRiskMul: 0.25 }, 'gold');
  const base = F.riskOf('gold', { id: 'g_orb30', tf: '5m' });
  assert.ok(Math.abs(F.riskOf('gold', { id: 'g_orb30', tf: '5m' }, 1) - 2 * base) < 1e-12, 'FTMO : intraday × 2 en évaluation');
  assert.ok(Math.abs(F.riskOf('gold', { id: 'g_orb30', tf: '5m' }, 'funded') - 0.25 * base) < 1e-12, 'FTMO financé : × 0,25');
  assert.ok(Math.abs(F.riskOf('gold', { id: 'down3', tf: '1d' }, 1) - F.riskOf('gold', { id: 'down3', tf: '1d' })) < 1e-12, 'journalières FTMO inchangées en évaluation');
  const { riskText } = require('../src/interactive');
  if (riskText) assert.match(riskText(cfg, L, 1), /1\.35 % \(intraday pendant l'évaluation, 0\.45 % une fois financé\)/);
});

test('Lucid : euro en 6E standard (pas de micro M6E chez Lucid) ; journalières Russell / Nasdaq / argent sur micros M2K / MNQ / SIL', () => {
  const cfg = require('../src/config');
  const { accountOf, MICRO } = require('../src/ftmoAccount');
  const { marketById } = require('../src/markets');
  assert.strictEqual(MICRO.eurusd.name, '6E');
  assert.strictEqual(MICRO.eurusd.mult, 125_000);
  assert.strictEqual(MICRO.russell.name, 'M2K');
  const L = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  const F = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  for (const sid of ['russell:n_low10', 'nas100:double7', 'silver:double7']) {
    const [m, id] = sid.split(':');
    const s = selectStrategies([id])[0];
    assert.ok(L.strategies.includes(sid) && L.riskOf(m, s) > 0, `${sid} sur Lucid`);
    assert.ok(!F.strategies.includes(sid), `${sid} pas sur FTMO`);
    assert.ok(selectStrategies(cfg[`${m === 'nas100' ? 'nas' : m}Strategies`]).some((x) => x.id === id), `${sid} en paper`);
  }
  assert.ok(marketById(cfg, 'russell').enabled);
});

test('FTMO : actions / ETF (TLT, Google, Palantir, Eli Lilly, Boeing) en intraday, heure de New York, levier 1:5 ; pas sur Lucid', () => {
  const cfg = require('../src/config');
  const { accountOf } = require('../src/ftmoAccount');
  const { marketById } = require('../src/markets');
  const { STOCK_IDS } = require('../src/stocks');
  const F = accountOf({ ...cfg, ftmoEnabled: true }, 'gold');
  const L = accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  for (const sid of ['tlt:n_crabel7_15', 'googl:n_crabel7_30', 'pltr:n_orb15', 'pltr:n_crabel7_15', 'pltr:n_wvb05', 'lly:n_orb5s', 'ba:n_crabel7_15']) {
    const [m, id] = sid.split(':');
    const s = selectStrategies([id])[0];
    assert.ok(s, `${id} existe`);
    assert.ok(F.strategies.includes(sid) && F.riskOf(m, s) > 0, `${sid} sur FTMO`);
    assert.strictEqual(L.riskOf(m, s), 0, `${sid} pas sur Lucid`);
    assert.ok(selectStrategies(cfg[`${m}Strategies`]).some((x) => x.id === id), `${sid} en paper`);
  }
  for (const id of STOCK_IDS) assert.ok(marketById(cfg, id)?.enabled && marketById(cfg, id).session, id);
  const { computeScalp2 } = require('../src/scalp2');
  const c = Array.from({ length: 3 }, (_, k) => ({ t: Date.parse('2026-11-23T15:00:00Z') / 1000 + k * 300, o: 1, h: 1, l: 1, c: 1, v: 1 }));
  assert.deepStrictEqual(computeScalp2(c, 300, 'pltr').min, computeScalp2(c, 300, 'nas100').min, 'heure de New York');
});
