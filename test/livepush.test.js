const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, telegramToken: '1:SECRET', channelId: '-100777', ftmoEnabled: true, ftmoCombined: true,
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
  assert.ok(Array.isArray(ftmo.archive));
  assert.ok(Array.isArray(live.paper));
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

test('interface en direct : anciens trades (archive des challenges et trades paper), taille bornée', () => {
  const { cfg, store } = setup();
  const mk = (i) => ({ side: 'short', entry: 4000, exit: 3990, initSl: 4010, entryT: T0 + i * 600, exitT: T0 + i * 600 + 300, pnlPct: 0.25, reason: 'signal de sortie', size: 1000 });
  store.saveJson('gold.json', { lastPrice: 4000, accounts: { g_mom8: { closed: Array.from({ length: 900 }, (_, i) => mk(i)), position: null }, autre: { closed: [mk(1)] } } });
  store.saveJson('ftmo-archive.json', Array.from({ length: 400 }, (_, i) => ({ market: 'gold', sid: 'g_mom8', side: 'long', entry: 1, exit: 2, entryT: i, exitT: i + 1, pnl: 10, attempt: 1 })));
  const live = require('../src/livePush').buildLive(cfg, store);
  assert.strictEqual(live.paper.length, 500); // 500 plus récents, stratégies suivies seulement
  assert.ok(live.paper.every((t) => t.sid === 'g_mom8'));
  assert.strictEqual(live.paper[499].entryT, T0 + 899 * 600);
  const ftmo = live.accounts.find((a) => a.id === 'ftmo');
  assert.strictEqual(ftmo.archive.length, 300);
  assert.strictEqual(ftmo.archive[0].attempt, 1);
  assert.ok(JSON.stringify(live).length < 400_000);
});
