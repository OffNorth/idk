const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { PaperBook } = require('../src/paper');
const { portfolioMessage, paperCloseMessage } = require('../src/format');

const cfg = {
  paperEnabled: true, paperSizeUsd: 100, paperTpPct: 100, paperSlPct: 40,
  paperTrailStartPct: 50, paperTrailPct: 30, paperMaxHoldHours: 48, paperFeePct: 2,
  goldSizeUsd: 1000,
};

function tmpStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'paper-')));
}

const item = (price) => ({
  token: { chain: 'solana', address: 'TOKpump', symbol: 'TOK', url: 'https://x', priceUsd: price, marketCap: 300_000 },
  result: { total: 72 },
});

test('ouverture : une seule position par token, frais inclus, persistée', () => {
  const store = tmpStore();
  const book = new PaperBook(store, cfg);
  const pos = book.open(item(0.001));
  assert.ok(pos);
  assert.strictEqual(book.open(item(0.002)), null, 'pas de doublon');
  assert.ok(Math.abs(pos.entryEff - 0.00102) < 1e-12);
  assert.ok(new PaperBook(store, cfg).isOpen('solana:TOKpump'), 'relu depuis le disque');
});

test('clôture : PnL avec frais, stats et messages', () => {
  const store = tmpStore();
  const book = new PaperBook(store, cfg);
  const pos = book.open(item(0.001));
  pos.peak = 0.0021;
  pos.last = 0.002;
  // clôture directe via la logique interne : on simule un update avec un prix x2
  const realFetch = require('../src/dexscreener').fetchPairs;
  const dex = require('../src/dexscreener');
  dex.fetchPairs = async () => new Map([['TOKpump', {
    chainId: 'solana', baseToken: { address: 'TOKpump', name: 'Tok', symbol: 'TOK' }, priceUsd: '0.002',
    marketCap: 600_000, liquidity: { usd: 50_000 }, url: 'https://x',
  }]]);
  return book.update().then((closed) => {
    dex.fetchPairs = realFetch;
    assert.strictEqual(closed.length, 1);
    const t = closed[0];
    assert.match(t.reason, /take profit/);
    // 0.002*0.98 / 0.00102 - 1 = +92.16 %
    assert.ok(Math.abs(t.pnlPct - 92.157) < 0.01, `pnl ${t.pnlPct}`);
    const s = book.stats();
    assert.strictEqual(s.trades, 1);
    assert.strictEqual(s.wins, 1);
    assert.match(paperCloseMessage(t), /Paper trade clôturé/);
    assert.match(portfolioMessage(s, null, cfg), /Trades clôturés : 1/);
  });
});

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
  const candles = closes.map((c, i) => ({ t: i * 3600, o: c, h: c + 3, l: c - 3, c }));
  for (const s of STRATEGIES) {
    const r = backtest(s, candles, { size: 1000, feePct: 0.05 });
    assert.ok(r.trades > 0, `${s.id} doit trader`);
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
