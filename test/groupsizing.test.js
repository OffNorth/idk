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

test('compte financé : risque selon la marge restante avant la perte max (FUNDED_CUSHION)', () => {
  const { cushionMul } = require('../src/sizing');
  assert.strictEqual(cushionMul(1), 1);
  assert.strictEqual(cushionMul(0.5), 0.5);
  assert.strictEqual(cushionMul(0.1), 0.25, 'au plus bas × 0,25');
  assert.strictEqual(cushionMul(3), 1, 'jamais plus que le risque normal');
  // Compte FTMO financé à mi-chemin de la perte max : taille divisée par 2
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const T0 = Date.UTC(2026, 10, 16, 10) / 1000;
  const notionalAt = (balance, cushion) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cushion-'));
    const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, ftmoEnabled: true,
      ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '2step', ftmoSizing: 'fixe', ftmoAi: 'off', lucidEnabled: false, fundedCushion: cushion };
    const { Store } = require('../src/store'); const store = new Store(dir);
    const { createFtmo } = require('../src/ftmoAccount');
    const f = createFtmo({ cfg, store, account: 'gold' });
    f.forceFunded(T0 - 86400);
    store.saveJson('ftmo.json', { ...f.load(), balance, dayStart: balance, peak: 100000 });
    f.onCycle([{ type: 'open', market: { id: 'gold', name: 'Gold' }, strategy: { id: 'x_rsi2', name: 'Scalp' }, pos: { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 } }], { gold: 2000 }, T0);
    return Object.values(f.load().open)[0]?.notional;
  };
  const full = notionalAt(100000, true), half = notionalAt(95000, true), off = notionalAt(95000, false);
  assert.ok(full > 0 && Math.abs(half / (off) - 0.5) < 0.01, `${full} / ${half} / ${off}`);
});
