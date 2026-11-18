const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('résumé du jour : trades regroupés par stratégie (scalp seul, puis toutes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, nasEnabled: false, digestAll: false, goldStrategies: ['season', 'x_rsi2', 'm_bb@5m'] };
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
  assert.match(txt, /Résumé du jour/);
  assert.match(txt, /3 trades clôturés · 33 % gagnants · <b>\+\$0<\/b>/); // +8 −3 −5
  assert.match(txt, /1 position ouverte/);
  assert.match(txt, /Scalp RSI 2[^\n]*2 trades, 1 gagnant/);
  assert.doesNotMatch(txt, /Saison/);
  assert.match(txt, /Compte FTMO simulé/);
  // Toutes les stratégies : la clôture de la stratégie journalière et sa nouvelle position apparaissent
  const acc = store.loadJson('gold.json', {});
  acc.accounts.season.position = { side: 'long', entry: 4010, sl: 3800, size: 1100, entryT: now - 300 };
  store.saveJson('gold.json', acc);
  const all = scalpDigest({ ...cfg, digestAll: true }, store, activeMarkets(cfg), Date.now() - 86_400_000);
  assert.match(all, /Saison de l’or[^\n]*📈 achat à \$4010\.00/);
  assert.match(all, /4 trades clôturés/);
  assert.match(all, /1 nouvelle position/);
});
