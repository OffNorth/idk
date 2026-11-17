const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { GoldTrader } = require('../src/gold');
const { portfolioMessage, goldEventMessage } = require('../src/format');

const cfg = { goldEnabled: true, goldSizeUsd: 1000, goldFeePct: 0.05, goldStrategies: ['all'] };

test('or : indicateurs', () => {
  const { ema, rsi, sma, supertrend, donchian } = require('../src/indicators');
  assert.deepStrictEqual(ema([1, 1, 1], 3), [1, 1, 1]);
  assert.deepStrictEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.ok(rsi(up)[39] > 90, 'RSI haut en tendance haussière');
  const candles = up.map((c, i) => ({ t: i * 3600, o: c, h: c + 1, l: c - 1, c }));
  assert.strictEqual(supertrend(candles).dir[39], 1, 'supertrend haussier');
  assert.strictEqual(donchian(candles, 5).hh[10], 110, 'plus haut des 5 bougies précédentes');
});

test('or : chaque stratégie produit des trades cohérents en backtest', () => {
  const { STRATEGIES } = require('../src/strategies');
  const { backtest } = require('../src/gold');
  // marché synthétique : tendances + oscillations
  const closes = Array.from({ length: 600 }, (_, i) => 2000 + 80 * Math.sin(i / 40) + 15 * Math.sin(i / 3) + i * 0.2);
  const candles = closes.map((c, i) => ({ t: i * 3600, o: c, h: c + 3, l: c - 3, c, v: 10 + (i % 7) }));
  for (const s of STRATEGIES.filter((x) => !x.scalp)) {
    const r = backtest(s, candles, { size: 1000, feePct: 0.05 });
    if (!['hold', 'fibo', 'insidebar', 'dollar'].includes(s.id)) assert.ok(r.trades > 0, `${s.id} doit trader`);
    for (const t of r.list) {
      assert.ok(Number.isFinite(t.pnlUsd), `${s.id} PnL fini`);
      assert.ok(t.exitT >= t.entryT, `${s.id} sortie après entrée`);
      if (t.reason === 'stop loss' && !s.trail) assert.ok(t.pnlPct < 0.5, `${s.id} un stop initial ne gagne pas beaucoup`);
    }
  }
});

test('or : stop prioritaire sur objectif dans une même bougie', () => {
  const { hitInCandle } = require('../src/gold');
  const pos = { side: 'long', sl: 99, tp: 102 };
  assert.deepStrictEqual(hitInCandle(pos, { h: 103, l: 98 }), { price: 99, reason: 'stop loss' });
  assert.deepStrictEqual(hitInCandle(pos, { h: 103, l: 100 }), { price: 102, reason: 'take profit' });
  assert.strictEqual(hitInCandle({ side: 'short', sl: 105, tp: 95 }, { h: 104, l: 96 }), null);
});

test('or : réinvestissement des gains en backtest', () => {
  const { STRATEGIES } = require('../src/strategies');
  const { backtest } = require('../src/gold');
  const closes = Array.from({ length: 800 }, (_, i) => 2000 * (1 + i / 800) + 60 * Math.sin(i / 25));
  const candles = closes.map((c, i) => ({ t: i * 3600, o: c, h: c + 3, l: c - 3, c, v: 10 }));
  const s = STRATEGIES.find((x) => x.id === 'meanrev');
  const fixed = backtest(s, candles, { size: 1000 });
  const comp = backtest(s, candles, { compound: true, capital: 1000, curveEvery: 24 });
  assert.ok(comp.trades > 2);
  // capital final = départ + somme des gains, et chaque trade mise le capital du moment
  assert.ok(Math.abs(comp.capital - (1000 + comp.list.reduce((a, t) => a + t.pnlUsd, 0))) < 1e-6);
  for (let k = 1; k < comp.list.length; k++) assert.ok(Math.abs(comp.list[k].size - comp.list[k - 1].capital) < 1e-6);
  assert.strictEqual(fixed.trades, comp.trades, 'mêmes signaux');
  assert.ok(comp.curve.length > 10 && comp.curve.every((p) => Number.isFinite(p.v)));
});

test('graphique PNG valide', () => {
  const { renderEquityChart, PALETTE } = require('../src/chart');
  const png = renderEquityChart([{ points: [{ t: 0, v: 1000 }, { t: 86400, v: 1100 }], rgb: PALETTE[0].rgb }], { width: 300, height: 200, baseline: 1000 });
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.strictEqual(png.readUInt32BE(16), 300);
  assert.strictEqual(png.readUInt32BE(20), 200);
});

test('or : bilan et messages', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'gold-')));
  const trader = new GoldTrader(store, cfg);
  const stats = trader.stats();
  assert.strictEqual(stats.rows.length, require('../src/strategies').STRATEGIES.filter((s) => !s.scalp).length, 'toutes les stratégies (hors scalp)');
  assert.match(portfolioMessage(stats, cfg), /Bilan paper trading — Or/);
  const strategy = trader.strategies[0];
  const pos = { side: 'long', entry: 4000, sl: 3980, tp: 4040, size: 1000, entryT: 0 };
  assert.match(goldEventMessage({ type: 'open', strategy, pos, rsi: 55 }), /ACHAT/);
  const trade = { ...pos, exit: 4040, exitT: 7200, reason: 'take profit', pnlPct: 0.9, pnlUsd: 9 };
  assert.match(goldEventMessage({ type: 'close', strategy, trade }), /\+0\.9%/);
});
