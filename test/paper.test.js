const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { PaperBook } = require('../src/paper');
const { signal, ema, rsi } = require('../src/gold');
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

test('or : indicateurs et signal de croisement', () => {
  assert.deepStrictEqual(ema([1, 1, 1], 3), [1, 1, 1]);
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.ok(rsi(up)[39] > 90, 'RSI haut en tendance haussière');

  // Baisse longue puis forte hausse → croisement haussier à un moment donné
  const noise = (i) => (i % 2 ? 2.5 : -2.5);
  const closes = [...Array.from({ length: 80 }, (_, i) => 200 - i * 0.5 + noise(i)), ...Array.from({ length: 60 }, (_, i) => 160 + i * 0.8 + noise(i))];
  const candles = closes.map((c, i) => ({ t: i * 3600, o: c, h: c + 1, l: c - 1, c }));
  let found = null;
  for (let n = 60; n <= candles.length; n++) {
    const s = signal(candles.slice(0, n));
    if (s.side) { found = s; break; }
  }
  assert.ok(found, 'un signal doit apparaître');
  assert.strictEqual(found.side, 'long');
});
