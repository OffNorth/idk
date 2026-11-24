const test = require('node:test');
const assert = require('node:assert');

// Boucle de test de tout le bot (selftest.js), hors ligne : scénario de marché, commandes, boutons, pannes
test('boucle de test de tout le bot : 0 étape en échec', { timeout: 600_000 }, async () => {
  const { run } = require('../selftest');
  const lines = [];
  const r = await run({ log: (l) => lines.push(l) });
  assert.strictEqual(r.failed.length, 0, lines.join('\n'));
});
