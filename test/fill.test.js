const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-'));
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, ftmoEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoNasStrategies: [], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '1step', ftmoSizing: 'fixe', ftmoAi: 'off', lucidEnabled: false, ftmoCombined: true, ftmoIntradayRisk: 0, ...extra };
  const { Store } = require('../src/store');
  return { cfg, store: new Store(dir) };
}
const market = { id: 'gold', name: 'Or' };
const strategy = { id: 'x_rsi2', name: 'Scalp RSI 2', tf: '1d' };
const DAY = 86400;
const T0 = Date.UTC(2026, 10, 16, 15) / 1000; // lundi 15 h UTC

test('exécution 30 s après le signal : entrée au cours relevé, stop au même niveau, sortie sur signal au cours relevé', () => {
  const { cfg, store } = setup();
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  const out = f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4002 }, T0 + 30, { fills: { gold: { price: 4002, t: T0 + 30 } } });
  const o = out.find((m) => m.type === 'open').p;
  assert.strictEqual(o.entry, 4002);
  assert.strictEqual(o.signal, 4000);
  assert.strictEqual(o.sl, 3960);
  assert.strictEqual(o.entryT, T0, 'clé du trade paper gardée pour la réconciliation');
  // Taille : 1 % de 100 000 $ sur 42 $ de stop (1,05 %) → ≈ 95 238 $
  assert.ok(Math.abs(o.notional - 100000 * 1 / ((42 / 4002) * 100)) < 1e-6);
  const { ftmoTradeMessage } = require('../src/cycle');
  assert.match(ftmoTradeMessage({ type: 'open', p: o }, f.status({ gold: 4002 }), null), /Entrée \$4002\.00 \(signal \$4000\.00, 2\.00 contre toi\)/);
  // Sortie sur signal : cours 30 s plus tard
  const c = f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 4040, exitT: T0 + 3600, reason: 'signal de sortie' } }], { gold: 4038 }, T0 + 3630, { fills: { gold: { price: 4038, t: T0 + 3630 } } });
  const tr = c.find((m) => m.type === 'trade').p;
  assert.strictEqual(tr.exit, 4038);
  assert.strictEqual(tr.signalExit, 4040);
  assert.strictEqual(tr.exitT, T0 + 3630);
});

test('exécution différée : stop et objectif restent au niveau ; cours au-delà du stop → pas de trade', () => {
  const { cfg, store } = setup();
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  const c = f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 3960, exitT: T0 + 600, reason: 'stop loss' } }], { gold: 3950 }, T0 + 630, { fills: { gold: { price: 3950, t: T0 + 630 } } });
  assert.strictEqual(c.find((m) => m.type === 'trade').p.exit, 3960);
  const pos2 = { ...pos, entryT: T0 + DAY };
  const out = f.onCycle([{ type: 'open', market, strategy, pos: pos2 }], { gold: 3955 }, T0 + DAY + 30, { fills: { gold: { price: 3955, t: T0 + DAY + 30 } } });
  assert.ok(!out.some((m) => m.type === 'open'));
  assert.strictEqual(f.load().missed, 1);
});

test('délai : attente puis cours relevé seulement pour les marchés avec un ordre au marché', async () => {
  const { delayedFills, marketsToFill } = require('../src/fill');
  const acc = { follows: (ev) => ev.strategy.id === 'x_rsi2' };
  const now = Math.floor(Date.now() / 1000);
  const evs = [
    { type: 'open', market, strategy, pos: {} },
    { type: 'close', market: { id: 'nas100' }, strategy, trade: { reason: 'stop loss' } },
    { type: 'open', market: { id: 'spx' }, strategy: { id: 'autre' }, pos: {} },
  ];
  assert.deepStrictEqual(marketsToFill(evs, [acc]), ['gold']);
  let slept = 0;
  const fills = await delayedFills({ fillDelaySec: 30 }, evs, [acc], { sleep: async (ms) => { slept = ms; }, fetcher: async (sym) => (sym === 'GC=F' ? [{ t: now - 60, c: 4001.5 }] : []) });
  assert.strictEqual(slept, 30_000);
  assert.strictEqual(fills.gold.price, 4001.5);
  assert.strictEqual(await delayedFills({ fillDelaySec: 0 }, evs, [acc]), null);
  // Marché fermé (dernière bougie trop ancienne) : pas de cours, le prix du signal reste
  const closed = await delayedFills({ fillDelaySec: 30 }, evs, [acc], { sleep: async () => {}, fetcher: async () => [{ t: now - 3600, c: 1 }] });
  assert.deepStrictEqual(closed, {});
  // Bougie 1 min plus ancienne que les données du signal (Yahoo : 1 min en retard sur le 5 min) : pas un cours « après »
  // le signal → ignorée, le compte garde le prix du signal ; à jour → prise
  const quote = async (sym) => (sym === 'GC=F' ? [{ t: now - 600, c: 3545.1 }] : []);
  const stale = await delayedFills({ fillDelaySec: 30 }, evs, [acc], { sleep: async () => {}, fetcher: quote, since: { gold: now - 300 } });
  assert.deepStrictEqual(stale, {});
  const fresh = await delayedFills({ fillDelaySec: 30 }, evs, [acc], { sleep: async () => {}, fetcher: quote, since: { gold: now - 900 } });
  assert.strictEqual(fresh.gold.price, 3545.1);
});

test('Lucid : règle de régularité 40 % pendant l’évaluation', () => {
  const { lucidProgram } = require('../src/ftmoAccount');
  assert.strictEqual(lucidProgram(50_000).bestDay, 40);
  assert.strictEqual(lucidProgram(50_000, { lucidConsistency: 50 }).bestDay, 50);
  assert.strictEqual(lucidProgram(100_000).payout.cap, 3000);
});

test('compte financé Lucid : retrait simulé après 5 jours gagnants (≤ 50 % du gain, ≤ 2 000 $), 90 % pour le trader', () => {
  const { cfg, store } = setup({ lucidEnabled: true, lucidCapital: 50_000, lucidRiskMul: 1 });
  const { createFtmo } = require('../src/ftmoAccount');
  const lu = createFtmo({ cfg, store, account: 'lucid' });
  const s0 = lu.load();
  store.saveJson('lucid.json', { ...s0, phase: 'funded', funded: { since: T0 - DAY }, startedAt: T0 - DAY });
  const msgs = [];
  for (let k = 0; k < 6; k++) {
    const t = T0 + k * DAY;
    const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t };
    msgs.push(...lu.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, t));
    // 1 MGC (40 000 $) : +1 % → +400 $ − 3,5 $ de frais par jour
    msgs.push(...lu.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 4040, exitT: t + 600, reason: 'signal de sortie' } }], { gold: 4040 }, t + 600));
  }
  const pay = msgs.filter((m) => m.type === 'payout');
  assert.strictEqual(pay.length, 1, 'un retrait au 6e jour (5 jours gagnants clôturés)');
  const gain = 5 * 396.5;
  assert.ok(Math.abs(pay[0].amount - gain * 0.5) < 0.01, String(pay[0].amount));
  assert.ok(Math.abs(pay[0].trader - pay[0].amount * 0.9) < 0.01);
  const s = lu.load();
  assert.strictEqual(s.funded.payouts.length, 1);
  assert.ok(Math.abs(s.balance - (50_000 + 6 * 396.5 - pay[0].amount)) < 0.01);
});

test('compte financé FTMO : retrait de tout le gain tous les 14 jours, le compte repart du capital', () => {
  const { cfg, store } = setup();
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  store.saveJson('ftmo.json', { ...f.load(), phase: 'funded', funded: { since: T0 }, startedAt: T0 });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 4040, exitT: T0 + 600, reason: 'signal de sortie' } }], { gold: 4040 }, T0 + 600);
  assert.ok(!f.onCycle([], { gold: 4040 }, T0 + 5 * DAY).some((m) => m.type === 'payout'), 'pas avant 14 jours');
  const out = f.onCycle([], { gold: 4040 }, T0 + 15 * DAY);
  const p = out.find((m) => m.type === 'payout');
  assert.ok(p);
  assert.strictEqual(Math.round(p.amount), 1000);
  assert.strictEqual(Math.round(p.trader), 800);
  assert.strictEqual(Math.round(f.load().balance), 100000);
});

test('règle du meilleur jour : objectif effectif pour la taille des trades (pas d’écrasement à × 0,4)', async () => {
  const { effectiveTarget } = require('../src/ftmo');
  assert.ok(Math.abs(effectiveTarget(10, 50, 100000, 7569) - 15.138) < 1e-9);
  assert.strictEqual(effectiveTarget(10, 0, 100000, 7569), 10);
  assert.strictEqual(effectiveTarget(10, 50, 100000, 3000), 10);
  const { cfg, store } = setup({ ftmoSizing: 'objectif : dégressif doux', ftmoRisk: 1 });
  const { createFtmo } = require('../src/ftmoAccount');
  const f = createFtmo({ cfg, store });
  // Compte à +10,27 %, meilleur jour 7 569 $ (74 % du gain) : objectif effectif 15,138 %
  store.saveJson('ftmo.json', { ...f.load(), balance: 110270, peak: 110270, eodPeak: 110270, dayStart: 110270, day: '2026-11-16', days: ['a', 'b', 'c'], dayPnl: { a: 2768, b: 7569, c: -67 } });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  const o = f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0).find((m) => m.type === 'open').p;
  const want = 1 - 0.75 * (10.27 / 15.138);
  assert.ok(Math.abs(o.mul - want) < 0.01, `${o.mul} ≈ ${want}`);
  assert.ok(o.mul > 0.45);
  const st = f.status({ gold: 4000 });
  assert.strictEqual(Math.round(st.needed), 15138);
  const v = await require('../src/interactive').render(cfg, store, 'f', 'gold');
  assert.match(v.caption, /Règle du meilleur jour/);
});

test('/financer : évaluation bloquée → compte financé, risque normal (plus de réduction), positions gardées', () => {
  const { cfg, store } = setup({ ftmoSizing: 'objectif : dégressif doux', ftmoRisk: 1 });
  const { createFtmo, financerReport } = require('../src/ftmoAccount');
  const f = createFtmo({ cfg, store });
  store.saveJson('ftmo.json', { ...f.load(), balance: 110270, peak: 110270, dayStart: 110270, day: '2026-11-16', days: ['a', 'b', 'c'], dayPnl: { a: 2768, b: 7569, c: -67 }, closed: [{ market: 'gold', sid: 'x_rsi2', entryT: 1, exitT: 2, pnl: 7569 }] });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  const txt = financerReport(cfg, store, 'ftmo');
  assert.match(txt, /ne serait pas validée : meilleur jour 74 % du gain &gt; 50 %/);
  const s = f.load();
  assert.strictEqual(s.phase, 'funded');
  assert.strictEqual(s.balance, 100000);
  assert.strictEqual(Object.keys(s.open).length, 1, 'position ouverte gardée');
  assert.match(s.history.at(-1).outcome, /réussite forcée/);
  assert.ok(f.archived().some((t) => t.pnl === 7569), 'trades de l’évaluation archivés');
  // Nouveau trade : risque plein (× 1) en compte financé
  const pos2 = { ...pos, side: 'long', entryT: T0 + 60 };
  const o = f.onCycle([{ type: 'open', market, strategy: { ...strategy, id: 'x_rsi2' }, pos: pos2 }], { gold: 4000 }, T0 + 60).find((m) => m.type === 'open');
  assert.ok(o);
  assert.strictEqual(o.p.mul, 1);
  assert.match(financerReport(cfg, store, 'ftmo'), /déjà en compte financé/);
});

test('Lucid : intraday Nasdaq choisi pris à 0,2 % (1 MNQ), intraday or ignoré', () => {
  const { cfg, store } = setup({ lucidEnabled: true, lucidCapital: 50_000, lucidRiskMul: 1.25, lucidIntradayRisk: 0.2, lucidEvalIntradayMul: 1, lucidIntradayStrategies: ['nas100:n_noise'], ftmoStrategies: ['gold:g_orb30'], ftmoNasStrategies: ['nas100:n_noise'] });
  const lu = require('../src/ftmoAccount').createFtmo({ cfg, store, account: 'lucid' });
  const nas = { id: 'nas100', name: 'Nasdaq 100' };
  // Risque 0,2 % de 50 000 $ = 100 $ ; stop 0,25 % sur 26 000 → 65 $ par MNQ (52 000 $) → 1 contrat
  const out = lu.onCycle([{ type: 'open', market: nas, strategy: { id: 'n_noise', name: 'noise', tf: '5m' }, pos: { side: 'short', entry: 26000, sl: 26065, initSl: 26065, entryT: T0 } }], { nas100: 26000 }, T0);
  const o = out.find((x) => x.type === 'open');
  assert.ok(o, 'n_noise pris');
  assert.strictEqual(o.p.n, 1);
  assert.strictEqual(o.p.contract, 'MNQ');
  const out2 = lu.onCycle([{ type: 'open', market, strategy: { id: 'g_orb30', name: 'orb', tf: '5m' }, pos: { side: 'long', entry: 4000, sl: 3990, initSl: 3990, entryT: T0 + 60 } }], { gold: 4000, nas100: 26000 }, T0 + 60);
  assert.ok(!out2.some((x) => x.type === 'open'), 'intraday or non pris');
});

test('/reset : nouveau challenge au capital de départ, positions fermées au dernier cours, historique et archive gardés', () => {
  const { cfg, store } = setup();
  const acc = require('../src/ftmoAccount');
  const f = acc.createFtmo({ cfg, store });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 4040, exitT: T0 + 3600, reason: 'take profit' } }], { gold: 4040 }, T0 + 3600);
  f.onCycle([{ type: 'open', market, strategy, pos: { ...pos, entryT: T0 + 7200 } }], { gold: 4040 }, T0 + 7200);
  const before = f.load();
  assert.strictEqual(Object.keys(before.open).length, 1);
  store.saveJson('gold.json', { lastPrice: 4010 });
  assert.match(acc.resetReport(cfg, store, ''), /Pour confirmer/);
  assert.strictEqual(f.load().attempt, before.attempt, 'sans « ok » : rien ne change');
  const txt = acc.resetReport(cfg, store, 'ftmo ok');
  assert.match(txt, /remis à zéro/);
  const after = f.load();
  assert.strictEqual(after.attempt, before.attempt + 1);
  assert.strictEqual(after.balance, after.capital);
  assert.deepStrictEqual(after.open, {});
  assert.strictEqual(after.history.at(-1).outcome, 'réinitialisé (/reset)');
  const arch = f.archived();
  assert.strictEqual(arch.length, 2, 'trade clôturé + position fermée au reset gardés dans l’archive');
  assert.strictEqual(arch.at(-1).exit, 4010);
});

test('Lucid pendant l’évaluation : journée finie après 1 trade perdant ou un gain du jour ≥ 25 % de l’objectif ; pas en compte financé', () => {
  const { cfg, store } = setup({ lucidEnabled: true, lucidCapital: 50_000, lucidRiskMul: 1.25, lucidIntradayRisk: 0.45, lucidEvalIntradayMul: 1, lucidIntradayStrategies: ['nas100:n_noise'], ftmoStrategies: [], ftmoNasStrategies: ['nas100:n_noise'], lucidDayProfitCapPct: 25, lucidMaxLossesDay: 1 });
  const acc = require('../src/ftmoAccount');
  const lu = acc.createFtmo({ cfg, store, account: 'lucid' });
  const nas = { id: 'nas100', name: 'Nasdaq 100' };
  const st = { id: 'n_noise', name: 'noise', tf: '5m' };
  const open = (t, entry, sl) => lu.onCycle([{ type: 'open', market: nas, strategy: st, pos: { side: 'long', entry, sl, initSl: sl, entryT: t } }], { nas100: entry }, t);
  const close = (t, entryT, entry, sl, exit) => lu.onCycle([{ type: 'close', market: nas, strategy: st, trade: { side: 'long', entry, sl, initSl: sl, entryT, exit, exitT: t, reason: exit <= sl ? 'stop loss' : 'take profit' } }], { nas100: exit }, t);
  // 1er trade perdant → plus de trade ce jour-là
  assert.ok(open(T0, 26000, 25950).some((m) => m.type === 'open'));
  close(T0 + 600, T0, 26000, 25950, 25950);
  assert.ok(!open(T0 + 1200, 26000, 25950).some((m) => m.type === 'open'), 'arrêt après 1 perte');
  // Lendemain : reprise
  assert.ok(open(T0 + 86400, 26000, 25950).some((m) => m.type === 'open'), 'nouveau jour');
  // Compte financé : pas de limite
  const s = lu.load(); s.phase = 'funded'; s.dayLosses = 5; store.saveJson('lucid.json', s);
  assert.ok(open(T0 + 86400 + 600, 26100, 26050).some((m) => m.type === 'open'), 'compte financé : pas de limite de journée');
});

test('FTMO : stop suiveur — dès +2 R (meilleure clôture du paper), stop à 1 R du meilleur cours, sortie au niveau', () => {
  const { cfg, store } = setup({ ftmoTrailActR: 2, ftmoTrailDistR: 1 });
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  // Paper : meilleur cours de clôture 4 070 (+1,75 R) → pas encore de suivi
  store.saveJson('gold.json', { accounts: { x_rsi2: { position: { ...pos, best: 4070 }, closed: [] } } });
  f.onCycle([], { gold: 4065 }, T0 + 600);
  assert.strictEqual(Object.values(f.load().open)[0].sl, 3960);
  // Meilleur cours 4 090 (+2,25 R) → stop à 4 090 − 40 = 4 050
  store.saveJson('gold.json', { accounts: { x_rsi2: { position: { ...pos, best: 4090 }, closed: [] } } });
  f.onCycle([], { gold: 4085 }, T0 + 1200);
  assert.strictEqual(Object.values(f.load().open)[0].sl, 4050);
  // Le cours repasse sous 4 050 → sortie au niveau du stop suiveur (+50 $ par once)
  const out = f.onCycle([], { gold: 4044 }, T0 + 1800);
  const tr = out.find((m) => m.type === 'trade').p;
  assert.strictEqual(tr.exit, 4050);
  assert.match(tr.reason, /stop suiveur/);
});

test('FTMO financé : ⅓ fermé à +1 R, ⅓ à +2 R, le reste continue ; rien en évaluation', () => {
  const { cfg, store } = setup({ ftmoTrailActR: 0, ftmoFundedPartials: ['1', '2'] });
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 };
  // Évaluation : pas de sortie partielle
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, T0);
  store.saveJson('gold.json', { accounts: { x_rsi2: { position: { ...pos, best: 4090 }, closed: [] } } });
  assert.ok(!f.onCycle([], { gold: 4090 }, T0 + 600).some((m) => m.type === 'trade'), 'évaluation : pas de partiel');
  // Compte financé
  const s = f.load(); s.phase = 'funded'; store.saveJson('ftmo.json', s);
  const n0 = Object.values(f.load().open)[0].notional;
  const out = f.onCycle([], { gold: 4045 }, T0 + 1200); // +1,125 R (le paper a déjà vu 4 090 = +2,25 R)
  const parts = out.filter((m) => m.type === 'trade').map((m) => m.p);
  assert.deepStrictEqual(parts.map((p) => p.exit), [4040, 4080]);
  assert.match(parts[0].reason, /objectif partiel \+1 R/);
  const left = Object.values(f.load().open)[0];
  assert.ok(Math.abs(left.notional - n0 / 3) < 1e-6, 'reste ⅓ de la position');
  assert.ok(!f.onCycle([], { gold: 4085 }, T0 + 1800).some((m) => m.type === 'trade'), 'pas de partiel en double');
});

test('FTMO pendant l’évaluation : journée finie après 1 trade perdant (comme Lucid) ; pas en compte financé', () => {
  const { cfg, store } = setup({ ftmoMaxLossesDay: 1, ftmoDayProfitCapPct: 25, ftmoTrailActR: 0, ftmoFundedPartials: [] });
  const f = require('../src/ftmoAccount').createFtmo({ cfg, store });
  const pos = (t) => ({ side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t });
  assert.ok(f.onCycle([{ type: 'open', market, strategy, pos: pos(T0) }], { gold: 4000 }, T0).some((m) => m.type === 'open'));
  f.onCycle([{ type: 'close', market, strategy, trade: { ...pos(T0), exit: 3960, exitT: T0 + 600, reason: 'stop loss' } }], { gold: 3960 }, T0 + 600);
  assert.ok(!f.onCycle([{ type: 'open', market, strategy, pos: pos(T0 + 1200) }], { gold: 3990 }, T0 + 1200).some((m) => m.type === 'open'), 'arrêt après 1 perte');
  const s = f.load(); s.phase = 'funded'; store.saveJson('ftmo.json', s);
  assert.ok(f.onCycle([{ type: 'open', market, strategy, pos: pos(T0 + 1800) }], { gold: 3990 }, T0 + 1800).some((m) => m.type === 'open'), 'compte financé : pas de limite');
});
