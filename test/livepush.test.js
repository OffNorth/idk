const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), dataDir: dir, telegramToken: '1:SECRET', channelId: '-100777', ftmoEnabled: true, ftmoCombined: true,
    ftmoStrategies: ['gold:g_mom8'], ftmoNasStrategies: [], ftmoProgram: '1step', ftmoSizing: 'fixe', ftmoAi: 'off', ftmoDayStop: 0, ftmoFeeGold: 0,
    lucidEnabled: true, lucidIntradayRisk: 0.5, livePush: true, livePushUrl: 'https://exemple.test/bot', nasEnabled: false, spxEnabled: false, eurusdEnabled: false };
  return { cfg, store, dir };
}
const T0 = Date.UTC(2026, 10, 16, 12, 30) / 1000;

test('interface en direct : état des comptes avec entrée / SL / TP, sans secret', () => {
  const { cfg, store, dir } = setup();
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, tp: 4080, entryT: T0 };
  store.saveJson('gold.json', { lastPrice: 4010, accounts: { g_mom8: { position: pos, closed: [] } } });
  const { createFtmo } = require('../src/ftmoAccount');
  createFtmo({ cfg, store }).onCycle([{ type: 'open', market: { id: 'gold', name: 'Or' }, strategy: { id: 'g_mom8', name: 'Élan', tf: '5m' }, pos }], { gold: 4000 }, T0);
  const live = require('../src/livePush').buildLive(cfg, store, 'abc');
  const ftmo = live.accounts.find((a) => a.id === 'ftmo');
  assert.ok(ftmo && ftmo.open.length === 1);
  const o = ftmo.open[0];
  assert.deepStrictEqual([o.entry, o.sl, o.tp, o.side], [4000, 3960, 4080, 'long']);
  assert.ok(o.pnl > 0, 'latent au dernier cours');
  assert.strictEqual(live.markets[0].symbol, 'GC=F');
  const json = JSON.stringify(live);
  assert.ok(!json.includes('SECRET') && !json.includes('-100777') && !json.includes(dir));
});

test('interface en direct : envoi avec la clé du bot, au plus toutes les 15 s, erreur réseau sans planter', async () => {
  const { cfg, store } = setup();
  const L = require('../src/livePush');
  L.resetThrottle();
  const calls = [];
  const ok = async (url, o) => { calls.push({ url, o }); return { ok: true, text: async () => '' }; };
  assert.strictEqual(await L.pushLive(cfg, store, { now: 1_000_000, fetchImpl: ok }), true);
  assert.match(calls[0].url, /action=put&slot=main/);
  assert.strictEqual(calls[0].o.headers['x-bot-key'], store.loadJson('bot-push-key.json').key);
  assert.strictEqual(await L.pushLive(cfg, store, { now: 1_005_000, fetchImpl: ok }), false); // < 15 s
  const ko = async () => { throw new Error('réseau coupé'); };
  assert.strictEqual(await L.pushLive(cfg, store, { now: 1_020_000, fetchImpl: ko }), false);
  // même clé ensuite
  await L.pushLive(cfg, store, { now: 1_040_000, fetchImpl: ok });
  assert.strictEqual(calls[1].o.headers['x-bot-key'], calls[0].o.headers['x-bot-key']);
});
