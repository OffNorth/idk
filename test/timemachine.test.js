const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, ftmoCombined: true, ftmoProgram: '1step', ftmoCapital: 100000, ftmoRisk: 1, ftmoIntradayRisk: 0.5, ftmoDayStop: 0, ftmoSizing: 'fixe', lucidEnabled: false, ...extra };
  const { Store } = require('../src/store');
  return { cfg, store: new Store(dir) };
}
const NOW = Date.UTC(2026, 10, 23, 18) / 1000;
// Journée type : 1 trade intraday or (stop 1 %), +x % ou −x %
const day = (p) => [{ s: 'gold:g_orb30', i: 1, m: 'gold', o: 9 * 3600, d: 3600, e: 4000, l: 3960, p, w: Math.min(0, p), c: 40000, f: 3.5 }];

test('runPhase : départ depuis l’état du compte (solde, meilleur jour, jours déjà tradés)', () => {
  const { runPhase } = require('../src/ftmo');
  const T = NOW + 86400;
  const tr = [{ entryT: T, exitT: T + 600, entry: 100, initSl: 99, pnlPct: 1 }];
  // Déjà à +9,5 % sur 3 jours, meilleur jour 2 000 $ : +1 % de plus (risque 1 %) → +10,5 %, 4e jour → réussite
  const r = runPhase(tr, { riskPct: 1, target: 10, bestDayPct: 50, start: { balance: 109500, peak: 109500, dayPnl: { a: 2000 }, days: 3 } });
  assert.strictEqual(r.outcome, 'target');
  // Meilleur jour trop gros (8 000 $ > 50 % de 10 600 $) : pas de réussite
  const r2 = runPhase(tr, { riskPct: 1, target: 10, bestDayPct: 50, start: { balance: 109500, peak: 109500, dayPnl: { a: 8000 }, days: 3 } });
  assert.strictEqual(r2.outcome, 'open');
});

test('Time Machine : tout gagnant → 100 % de réussite, tout perdant → 0 %, reproductible', () => {
  const { cfg, store } = setup();
  const { simulate, line } = require('../src/timeMachine');
  const win = simulate(cfg, store, 'gold', { days: [day(1), day(0.8)], paths: 50, now: NOW, seed: 1 });
  assert.strictEqual(win.passPct, 100);
  assert.ok(win.medianDays > 0 && win.medianDays < 60, String(win.medianDays));
  const lose = simulate(cfg, store, 'gold', { days: [day(-1)], paths: 50, now: NOW, seed: 1 });
  assert.strictEqual(lose.passPct, 0);
  assert.strictEqual(lose.failPct, 100);
  const mix = (seed) => simulate(cfg, store, 'gold', { days: [day(1), day(-1), day(0)], paths: 200, now: NOW, seed }).passPct;
  assert.strictEqual(mix(7), mix(7));
  assert.match(line(win), /Time Machine \(50 années simulées\) : réussite <b>100 %<\/b>/);
});

test('Time Machine : compte financé → part des comptes encore en vie', () => {
  const { cfg, store } = setup();
  const { simulate, line } = require('../src/timeMachine');
  const state = { attempt: 3, phase: 'funded', capital: 100000, balance: 100000, peak: 100000, dayPnl: {}, days: [] };
  const r = simulate(cfg, store, 'gold', { days: [day(-1)], paths: 20, now: NOW, seed: 1, state });
  assert.strictEqual(r.alive[365], 0);
  assert.match(line(r), /compte financé encore en vie/);
});

test('Time Machine : données réelles (src/mcDays.json) et rapport /timemachine', () => {
  const d = require('../src/mcDays.json');
  assert.ok(d.days.length > 400);
  const { cfg, store } = setup({ ftmoStrategies: require('../src/config').ftmoStrategies, ftmoNasStrategies: require('../src/config').ftmoNasStrategies, ftmoIntradayRisk: 0.15, ftmoRisk: 2 });
  const { simulate } = require('../src/timeMachine');
  const r = simulate(cfg, store, 'gold', { paths: 30, now: NOW, seed: 3 });
  assert.strictEqual(r.pass + r.daily + r.maxloss + r.open, 30);
  assert.match(require('../src/timeMachine').report(cfg, store), /Time Machine[\s\S]*Réussite \d+ %/);
});
