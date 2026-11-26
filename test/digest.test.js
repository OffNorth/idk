const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('résumé du jour : trades regroupés par stratégie (scalp seul, puis toutes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-'));
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, ftmoEnabled: true, lucidEnabled: false, nasEnabled: false, digestAll: false, goldStrategies: ['season', 'x_rsi2', 'm_bb@5m'] };
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const now = Math.floor(Date.now() / 1000);
  const t = (pnlUsd, ago) => ({ side: 'long', entry: 4000, exit: 4000 * (1 + pnlUsd / 1000), entryT: now - ago - 900, exitT: now - ago, pnlUsd, pnlPct: pnlUsd / 10, size: 1000, reason: 'signal' });
  store.saveJson('gold.json', {
    lastPrice: 4000,
    accounts: {
      x_rsi2: { capital: 1012, lastEvalT: 0, position: null, closed: [t(8, 3600), t(-3, 7200), t(7, 90_000 * 3)] }, // le 3e est trop ancien
      'm_bb@5m': { capital: 995, lastEvalT: 0, position: { side: 'long', entry: 4000, sl: 3990, size: 995, entryT: now - 60 }, closed: [t(-5, 1800)] },
      season: { capital: 1100, lastEvalT: 0, position: null, closed: [t(100, 600)] }, // journalière : pas dans le résumé
    },
  });
  const { scalpDigest, isScalp } = require('../src/cycle');
  const { activeMarkets } = require('../src/markets');
  assert.strictEqual(isScalp({ tf: '5m' }), true);
  assert.strictEqual(isScalp({ tf: '1d' }), false);
  const txt = scalpDigest(cfg, store, activeMarkets(cfg), Date.now() - 86_400_000);
  assert.match(txt, /Daily summary/);
  assert.match(txt, /3 trades closed · 33% winners · <b>\+\$0<\/b>/); // +8 −3 −5
  assert.match(txt, /1 open position/);
  assert.match(txt, /Scalp RSI 2[^\n]*2 trades, 1 winner/);
  assert.doesNotMatch(txt, /Saison/);
  assert.match(txt, /Simulated FTMO account/);
  // Toutes les stratégies : la clôture de la stratégie journalière et sa nouvelle position apparaissent
  const acc = store.loadJson('gold.json', {});
  acc.accounts.season.position = { side: 'long', entry: 4010, sl: 3800, size: 1100, entryT: now - 300 };
  store.saveJson('gold.json', acc);
  const all = scalpDigest({ ...cfg, digestAll: true }, store, activeMarkets(cfg), Date.now() - 86_400_000);
  assert.match(all, /Gold season[^\n]*📈 buy at \$4010\.00/);
  assert.match(all, /4 trades closed/);
  assert.match(all, /1 new position/);
});

test('mode FTMO seul : le groupe ne reçoit que les messages du compte FTMO', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-'));
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, publishFtmoOnly: true, ftmoEnabled: true, lucidEnabled: false, ftmoCombined: false, ftmoStrategies: ['gold:g_orb30'], ftmoRisk: 0.5, ftmoDayStop: 0, nasEnabled: false, spxEnabled: false, eurusdEnabled: false, autoAdapt: false };
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const { MarketTrader } = require('../src/markets');
  const orig = MarketTrader.prototype.run;
  const now = Math.floor(Date.now() / 1000);
  // Faux passage : une ouverture d'une stratégie suivie par le compte FTMO, une autre qui ne l'est pas
  MarketTrader.prototype.run = async function run() {
    const pos = (side, entry, sl) => ({ side, entry, sl, initSl: sl, size: 1000, entryT: now });
    return [
      { type: 'open', market: this.market, strategy: { id: 'g_orb30', name: 'ORB 30', tf: '5m' }, pos: pos('short', 3733, 3742) },
      { type: 'open', market: this.market, strategy: { id: 'down3', name: 'Down 3', tf: '1d' }, pos: pos('long', 3733, 3700) },
    ];
  };
  const sent = [];
  const channel = { sendText: async (t) => sent.push(t), sendPhoto: async (p, c) => sent.push(c), summaryDue: () => true, chartDue: () => false, markSummary: () => {}, markChart: () => {} };
  try {
    await require('../src/cycle').runCycle({ cfg, store, channel, publish: true });
  } finally {
    MarketTrader.prototype.run = orig;
  }
  assert.strictEqual(sent.length, 1, sent.join('\n---\n'));
  assert.match(sent[0], /FTMO/);
  assert.match(sent[0], /g_orb30/);
});
