const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoNasStrategies: [], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '1step', ftmoSizing: 'fixe', ftmoAi: 'off', lucidEnabled: false, ftmoCombined: true, ftmoIntradayRisk: 0, ...extra };
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
