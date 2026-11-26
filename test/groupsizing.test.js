const test = require('node:test');
const assert = require('node:assert');
const { ruleFor } = require('../src/sizing');

test('taille selon la corrélation : FTMO réduit si le même groupe est ouvert ou à 3 positions ; Lucid inchangé', () => {
  const cfg = { ftmoSizing: 'plusieurs positions → moins', ftmoGroupSizing: true };
  const f = ruleFor(cfg, 'FTMO');
  const st = (markets) => ({ balance: 1e5, capital: 1e5, dayStart: 1e5, target: 10, open: markets.length, openTrades: markets.map((market) => ({ market })) });
  assert.strictEqual(f({ market: 'spx' }, st(['nas100'])), 0.5, 'S&P avec un Nasdaq ouvert');
  assert.strictEqual(f({ market: 'gold' }, st(['nas100'])), 1, 'or avec un Nasdaq ouvert : groupes différents');
  assert.strictEqual(f({ market: 'gold' }, st(['nas100', 'eurusd'])), 1, '2 positions d’autres groupes : taille normale');
  assert.strictEqual(f({ market: 'silver' }, st(['gold', 'nas100', 'eurusd'])), 0.25, 'même groupe et 3 positions');
  assert.strictEqual(ruleFor(cfg, 'Lucid')({ market: 'gold' }, st(['nas100', 'eurusd'])), 0.5, 'Lucid : ancienne règle (2 positions)');
  assert.strictEqual(ruleFor({ ...cfg, ftmoGroupSizing: false }, 'FTMO')({ market: 'spx' }, st(['nas100'])), 1, 'FTMO_GROUP_SIZING=0');
});
