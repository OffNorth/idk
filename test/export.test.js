const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('export des statistiques : comptes et trades, sans secret ni caractéristiques de l’IA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, telegramToken: '123:SECRET', channelId: '-100999', ftmoStrategies: ['gold:down3'], ftmoNasStrategies: [], goldStrategies: ['down3', 'hold'] };
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

test('sauvegarde : clé dérivée du token, fichiers privés compressés, restauration sans écraser ni la clé du site', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const B = require('../src/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  fs.writeFileSync(path.join(dir, 'ftmo.json'), '{"balance":101000}');
  fs.writeFileSync(path.join(dir, 'bot-push-key.json'), '{"key":"secret"}');
  const cfg = { telegramToken: '1:SECRET', dataDir: dir, backup: true, backupUrl: 'https://exemple.test/bot' };
  const k = B.keyOf(cfg);
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(k) && !k.includes('SECRET'));
  const { Store } = require('../src/store');
  let sent = null;
  const fetchImpl = async (url, o) => { if (url.includes('backup_put')) { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ ok: true }) }; } return { ok: true, json: async () => ({ data: sent.data }) }; };
  const r = await B.pushBackup(cfg, new Store(dir), { force: true, fetchImpl });
  assert.ok(r.ok && r.files >= 1);
  const files = B.unpack(sent.data).files;
  assert.ok(files['ftmo.json'] && !files['bot-push-key.json'], 'la clé du site n\'est jamais sauvegardée');
  assert.strictEqual((await B.pushBackup(cfg, new Store(dir), { fetchImpl })).skipped, 'recent', 'une par jour');
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bk2-'));
  const rr = await B.restoreBackup({ ...cfg, dataDir: dir2 }, { fetchImpl });
  assert.ok(rr.ok && fs.readFileSync(path.join(dir2, 'ftmo.json'), 'utf8').includes('101000'));
  assert.ok(B.looksEmpty({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bk3-')) }) && !B.looksEmpty({ dataDir: dir2 }));
});
