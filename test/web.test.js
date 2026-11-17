const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('mini-app : page, API état / catalogue, clé WEB_TOKEN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  const cfg = { ...require('../src/config'), dataDir: dir, webToken: 'secret' };
  const { Store } = require('../src/store');
  const { startWeb } = require('../src/web');
  const store = new Store(dir);
  // Compte d'or fictif : une position ouverte et un trade clôturé
  store.saveJson('gold.json', {
    lastPrice: 2100,
    lastUpdate: Date.now(),
    curve: [{ t: 1_700_000_000, eq: { season: 1000 } }],
    accounts: {
      season: {
        capital: 1050, lastEvalT: 0,
        position: { side: 'long', entry: 2000, sl: 1900, tp: null, size: 1050, best: 2000, entryT: 1_700_000_000, checkedFrom: 0 },
        closed: [{ side: 'long', entry: 1900, exit: 1995, entryT: 1_690_000_000, exitT: 1_695_000_000, pnlUsd: 50, pnlPct: 5, reason: 'signal de sortie', size: 1000 }],
      },
    },
  });
  const server = startWeb({ cfg, store, port: 0, host: '127.0.0.1', log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Paper trading/);

    assert.strictEqual((await fetch(`${base}/api/state`)).status, 401, 'clé exigée');

    const state = await (await fetch(`${base}/api/state?k=secret`)).json();
    const gold = state.markets.find((m) => m.id === 'gold');
    assert.ok(gold, 'marché or présent');
    const season = gold.strategies.find((s) => s.id === 'season');
    assert.strictEqual(season.capital, 1050);
    assert.strictEqual(season.position.side, 'long');
    assert.strictEqual(season.position.unrealizedPct, 5); // 2000 → 2100
    assert.strictEqual(season.closed.length, 1);
    assert.ok(gold.feed.some((e) => e.type === 'close' && e.id === 'season'));

    const cat = await (await fetch(`${base}/api/catalog?k=secret`)).json();
    const ids = cat.strategies.map((s) => s.id);
    for (const id of ['golden', 'trendmix', 'mom12_1', 'seasonplus', 'macro']) assert.ok(ids.includes(id), id);
    assert.ok(cat.strategies.find((s) => s.id === 'season').active.includes('gold'));
  } finally {
    server.close();
  }
});
