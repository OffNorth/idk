const test = require('node:test');
const assert = require('node:assert');
const { hardFilters, score, applyRugcheck } = require('../src/scoring');
const { tokenMessage } = require('../src/format');

const cfg = {
  minMarketCap: 100_000, maxMarketCap: 2_000_000, minLiquidity: 15_000, minVolume24h: 30_000,
  minTxns24h: 150, minAgeHours: 1, maxAgeHours: 720, maxPriceChange24h: 1500, rugcheckMaxScore: 50,
};

const base = () => ({
  chain: 'solana', address: 'AbcPump111pump', name: 'Test <Dog>', symbol: 'TDOG', dex: 'pumpswap',
  url: 'https://dexscreener.com/solana/x', marketCap: 500_000, liquidity: 60_000,
  vol: { m5: 2_000, h1: 40_000, h6: 120_000, h24: 400_000 },
  change: { m5: 1, h1: 8, h6: 25, h24: 60 },
  txns: { h1: { buys: 300, sells: 200, total: 500 }, h6: { buys: 1000, sells: 800, total: 1800 }, h24: { buys: 2500, sells: 2000, total: 4500 } },
  ageHours: 30, twitter: 'https://x.com/t', telegram: null, website: null, sources: ['boost'],
});

test('token sain dans la fourchette : accepté avec un bon score', () => {
  const t = base();
  assert.deepStrictEqual(hardFilters(t, cfg), []);
  const r = score(t);
  assert.ok(r.total > 60 && r.total <= 100, `score ${r.total}`);
});

test('MC hors fourchette rejetée', () => {
  assert.match(hardFilters({ ...base(), marketCap: 50_000 }, cfg)[0], /MC trop basse/);
  assert.match(hardFilters({ ...base(), marketCap: 3_000_000 }, cfg)[0], /MC trop haute/);
});

test('ventes massives et liquidité ridicule rejetées', () => {
  const t = base();
  t.txns.h1 = { buys: 20, sells: 180, total: 200 };
  assert.ok(hardFilters(t, cfg).some((r) => /ventes massives/.test(r)));
  assert.ok(hardFilters({ ...base(), liquidity: 16_000, marketCap: 1_900_000 }, cfg).some((r) => /piège/.test(r)));
});

test('RugCheck : mint authority = rejet, risques = pénalité', () => {
  const r = score(base());
  const fatal = applyRugcheck(r, { available: true, fatal: 'Mint Authority still enabled', score: 10, dangers: [] }, cfg);
  assert.ok(fatal.rejected);
  const pen = applyRugcheck(r, { available: true, fatal: null, score: 20, dangers: ['Top 10 holders high ownership'] }, cfg);
  assert.ok(pen.total < r.total && !pen.rejected);
});

test('message Telegram échappe le HTML', () => {
  const msg = tokenMessage({ token: base(), result: score(base()), rug: null });
  assert.ok(msg.includes('Test &lt;Dog&gt;'));
  assert.ok(msg.includes('pump.fun/coin/AbcPump111pump'));
});
