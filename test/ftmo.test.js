const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftmo-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '2step', ...extra };
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
  const { cfg, store } = setup({ ftmoCombined: false, ftmoNasEnabled: true, ftmoNasStrategies: ['nas100:x_orb5'], ftmoNasRisk: 0.5 });
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

test('compte FTMO unique or + Nasdaq : un risque par marché', () => {
  const { cfg, store } = setup({ ftmoCombined: true, ftmoNasEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoNasStrategies: ['nas100:x_orb5'], ftmoRisk: 0.5, ftmoComboNasRisk: 1 });
  const { createFtmo, ftmoAccounts } = require('../src/ftmoAccount');
  assert.deepStrictEqual(ftmoAccounts(cfg).map((a) => a.id), ['gold']);
  const acct = createFtmo({ cfg, store, account: 'gold' });
  const nasMarket = { id: 'nas100', name: 'Nasdaq 100' };
  const pos = { side: 'long', entry: 20000, sl: 19800, initSl: 19800, entryT: T0 }; // stop 1 %
  acct.onCycle([{ type: 'open', market: nasMarket, strategy: { id: 'x_orb5', name: 'ORB' }, pos }], { nas100: 20000 }, T0);
  acct.onCycle([{ type: 'close', market: nasMarket, strategy: { id: 'x_orb5' }, trade: { ...pos, exit: 20200, exitT: T0 + 600, reason: 'objectif' } }], { nas100: 20200 }, T0 + 600);
  // risque Nasdaq 1 % de 100 000 $ sur un stop de 1 % → 100 000 $ engagés ; +1 % → +1 000 $ (moins les frais)
  assert.ok(Math.abs(acct.load().balance - 101000) < 20, String(acct.load().balance));
});

test('levier dynamique : risque divisé par 2 dès 2 positions ouvertes', () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoSizing: 'plusieurs positions → moins' });
  const { createFtmo } = require('../src/ftmoAccount');
  const acct = createFtmo({ cfg, store, account: 'gold' });
  const mk = (k) => ({ type: 'open', market, strategy: { id: 'x_rsi2', name: 'Scalp' }, pos: { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 + k } });
  acct.onCycle([mk(0), mk(1), mk(2)], { gold: 2000 }, T0 + 2);
  const n = Object.values(acct.load().open).map((p) => Math.round(p.notional));
  // risque 1 % sur un stop de 1 % → 100 000 $ ; la 3e position (2 déjà ouvertes) → 50 000 $
  assert.deepStrictEqual(n, [100000, 100000, 50000]);
});

test('challenge 1 étape : perte du jour 3 %, perte max suiveuse, réussite directe vers le compte financé', () => {
  const { createFtmo } = require('../src/ftmoAccount');
  const mk = (k, entry, sl) => ({ type: 'open', market, strategy, pos: { side: 'long', entry, sl, initSl: sl, entryT: T0 + k * DAY } });
  const cl = (k, entry, exit) => ({ type: 'close', market, strategy, trade: { side: 'long', entry, exit, exitT: T0 + k * DAY + 60, entryT: T0 + k * DAY, reason: 'test' } });
  // Réussite : +11 % répartis sur 4 jours (aucun jour > 50 % du gain) → compte financé en une étape
  {
    const { cfg, store } = setup({ ftmoProgram: '1step', ftmoRisk: 1, ftmoCombined: false });
    const a = createFtmo({ cfg, store, account: 'gold' });
    let res = [];
    for (let k = 0; k < 4; k++) {
      a.onCycle([mk(k, 2000, 1980)], { gold: 2000 }, T0 + k * DAY);
      // stop 1 %, risque 1 % → 100 000 $ engagés ; +2,75 % → +2 750 $
      res = a.onCycle([cl(k, 2000, 2055)], { gold: 2055 }, T0 + k * DAY + 60);
    }
    assert.ok(res.some((m) => m.type === 'pass'), 'réussite');
    assert.strictEqual(a.load().phase, 'funded');
  }
  // Perte max suiveuse : +5 % puis −10,5 % depuis le plus haut → échec (alors que le solde reste au-dessus de 90 000 $)
  {
    const { cfg, store } = setup({ ftmoProgram: '1step', ftmoRisk: 1, ftmoCombined: false });
    const a = createFtmo({ cfg, store, account: 'gold' });
    a.onCycle([mk(0, 2000, 1980)], { gold: 2000 }, T0);
    a.onCycle([cl(0, 2000, 2100)], { gold: 2100 }, T0 + 60); // +5 000 $
    let failed = false;
    for (let k = 1; k <= 4 && !failed; k++) {
      a.onCycle([mk(k, 2000, 1980)], { gold: 2000 }, T0 + k * DAY);
      const r = a.onCycle([cl(k, 2000, 1945)], { gold: 1945 }, T0 + k * DAY + 60); // −2 750 $ par jour (< 3 %)
      failed = r.some((m) => m.type === 'fail' && /perte maximale/.test(m.why));
    }
    assert.ok(failed, 'échec sur la perte max suiveuse');
  }
});
