const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftmo-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ...extra };
  const { Store } = require('../src/store');
  return { cfg, store: new Store(dir) };
}
const market = { id: 'gold', name: 'Or' };
const strategy = { id: 'x_rsi2', name: 'Scalp RSI 2' };
const DAY = 86400;
const T0 = Date.UTC(2026, 10, 16, 10) / 1000; // lundi 10 h UTC

test('simulateur : réussite d’un challenge et échec sur la perte maximale', () => {
  const { runPhase, rMultiple } = require('../src/ftmo');
  // Stop à 1 % du prix, gain de 2 % → +2 R ; risque 1 % → +2 % du compte par trade
  const win = (k) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct: 2 });
  assert.strictEqual(rMultiple(win(0)), 2);
  const p = runPhase([0, 1, 2, 3, 4].map(win), { riskPct: 1, target: 10 });
  assert.strictEqual(p.outcome, 'target');
  assert.ok(p.days >= 4);
  const lose = (k) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct: -1 });
  assert.strictEqual(runPhase(Array.from({ length: 12 }, (_, k) => lose(k)), { riskPct: 1 }).outcome, 'maxloss');
});

test('compte FTMO en direct : taille au risque, étape 1 réussie, puis échec sur la perte du jour', () => {
  const { cfg, store } = setup();
  const { createFtmo } = require('../src/ftmoAccount');
  const f = createFtmo({ cfg, store });
  const trade = (k, exit, t = T0 + k * DAY) => {
    const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t }; // stop à 1 %
    f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, t);
    return f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit, exitT: t + 1800, entryT: t, reason: 'signal' } }], { gold: exit }, t + 1800);
  };
  // Taille : 1 % de 100 000 $ / 1 % de distance → 100 000 $ engagés ; +3 % → +3 000 $
  trade(0, 4120);
  assert.strictEqual(Math.round(f.load().balance), 103000);
  trade(1, 4120);
  trade(2, 4120);
  const msgs = trade(3, 4040); // +1 % → total ≥ +10 % en 4 jours
  assert.ok(msgs.some((m) => m.type === 'pass' && m.phase === 1), 'étape 1 réussie');
  assert.strictEqual(f.load().phase, 2);
  // Étape 2 : une perte de 6 % dans la journée → échec (perte du jour 5 %), nouveau challenge
  const t = T0 + 10 * DAY;
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, t);
  const out = f.onCycle([], { gold: 3760 }, t + 600); // −6 % en latent
  assert.ok(out.some((m) => m.type === 'fail' && /jour/.test(m.why)));
  assert.strictEqual(f.load().attempt, 2);
  assert.strictEqual(f.load().phase, 1);
});

test('image et vue du panneau FTMO', async () => {
  const { cfg, store } = setup();
  const { render } = require('../src/interactive');
  const out = await render(cfg, store, 'f', 'gold');
  assert.strictEqual(out.png.subarray(1, 4).toString(), 'PNG');
  assert.match(out.caption, /Compte FTMO simulé/);
});

test('2e compte FTMO (Nasdaq) : indépendant du compte or', async () => {
  const { cfg, store } = setup({ ftmoNasEnabled: true, ftmoNasStrategies: ['nas100:x_orb5'], ftmoNasRisk: 0.5 });
  const { createFtmo, ftmoAccounts } = require('../src/ftmoAccount');
  assert.deepStrictEqual(ftmoAccounts(cfg).map((a) => a.id), ['nas100', 'gold']);
  const nas = createFtmo({ cfg, store, account: 'nas100' });
  const gold = createFtmo({ cfg, store, account: 'gold' });
  const nasMarket = { id: 'nas100', name: 'Nasdaq 100' };
  const pos = { side: 'long', entry: 20000, sl: 19900, initSl: 19900, entryT: T0 }; // stop 0,5 %
  const evs = [{ type: 'open', market: nasMarket, strategy: { id: 'x_orb5', name: 'ORB' }, pos }];
  nas.onCycle(evs, { nas100: 20000 }, T0);
  gold.onCycle(evs, { nas100: 20000 }, T0);
  nas.onCycle([{ type: 'close', market: nasMarket, strategy: { id: 'x_orb5' }, trade: { ...pos, exit: 20200, exitT: T0 + 600, reason: 'objectif' } }], { nas100: 20200 }, T0 + 600);
  // risque 0,5 % de 100 000 $ sur un stop de 0,5 % → 100 000 $ engagés ; +1 % → +1 000 $
  assert.strictEqual(Math.round(nas.load().balance), 101000);
  assert.strictEqual(gold.load().balance, 100000, 'le compte or ne suit pas le Nasdaq');
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'ftmo-nas.json')));
  const { render } = require('../src/interactive');
  const out = await render(cfg, store, 'f', 'nas100');
  assert.match(out.caption, /FTMO simulé 🇺🇸 Nasdaq/);
});
