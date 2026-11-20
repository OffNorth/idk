const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('export des statistiques : comptes et trades, sans secret ni caractéristiques de l’IA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), dataDir: dir, telegramToken: '123:SECRET', channelId: '-100999', ftmoStrategies: ['gold:down3'], ftmoNasStrategies: [], goldStrategies: ['down3', 'hold'] };
  store.saveJson('ftmo.json', { capital: 100000, balance: 101000, closed: [{ sid: 'down3', pnl: 1000, risk: 500 }], open: {}, dayPnl: { '2026-11-19': 1000 } });
  store.saveJson('gold.json', { lastPrice: 4000, accounts: { down3: { closed: [{ entryT: 1, exitT: 2, pnlPct: 1 }], position: null }, macd_vieux: { closed: [] } } });
  store.saveJson('ai-samples.json', [{ market: 'gold', sid: 'down3', entryT: 1, x: [1, 2, 3], p: 0.6, ok: true }]);
  const out = require('../src/export').buildExport(cfg, store, 'abc1234');
  const json = JSON.stringify(out);
  assert.strictEqual(out.version, 'abc1234');
  assert.strictEqual(out.accounts.ftmo.balance, 101000);
  assert.strictEqual(out.markets.gold.accounts.down3.followedByFtmo, true);
  assert.strictEqual(out.markets.gold.accounts.down3.closed.length, 1);
  assert.ok(!('x' in out.aiSamples[0]));
  assert.ok(!('macd_vieux' in out.markets.gold.accounts)); // ancien compte figé : pas exporté
  assert.strictEqual(out.summary.ftmo.avgR, 2);
  assert.strictEqual(out.summary.ftmo.bestDayShareOfGain, 100);
  assert.ok(!json.includes('SECRET') && !json.includes('-100999') && !json.includes(dir));
});
