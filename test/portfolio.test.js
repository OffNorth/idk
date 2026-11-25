const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pp = require('../src/personalPortfolio');

// Bougies journalières synthétiques (jours ouvrés) : croissance régulière g par jour
function series(from, n, p0, g) {
  const out = []; let t = from; let p = p0;
  while (out.length < n) { const wd = new Date(t * 1000).getUTCDay(); if (wd !== 0 && wd !== 6) { out.push({ t, o: p, h: p * 1.002, l: p * 0.998, c: p, v: 1 }); p *= 1 + g; } t += 86400; }
  return out;
}
const T0 = Date.UTC(2020, 0, 1) / 1000;
const data = () => ({ SPY: series(T0, 600, 300, 0.0004), EFA: series(T0, 600, 60, 0.0002), QQQ: series(T0, 600, 200, 0.0005), GLD: series(T0, 600, 150, 0.0003),
  SHY: series(T0, 600, 80, 0.00005), EURUSD: series(T0, 600, 1.1, 0), VIX: series(T0, 600, 15, 0) });

test('portefeuille perso : 50 % monde, 10 % or, 40 % bot, rééquilibré chaque mois ; valeur en €', () => {
  const d = data();
  const start = d.SPY[300].t;
  const s = pp.simulate(d, { start, capital: 10_000 });
  assert.ok(s.value > 10_000, 'marchés en hausse : le portefeuille monte');
  assert.strictEqual(s.sleeves.length, 5);
  assert.ok(Math.abs(Object.values(s.weights).reduce((a, x) => a + x, 0) - 1) < 1e-9);
  assert.ok(s.maxDrawdown <= 0 && s.drawdown <= 0);
  assert.deepStrictEqual(pp.WEIGHTS, { WORLD: 0.5, GLD: 0.1, BOT: 0.4 });
});

test('portefeuille perso : ouverture au premier passage, un calcul par jour après 22 h UTC, /portefeuille', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const d = data();
  const fetcher = async (sym) => (sym === 'EURUSD=X' ? d.EURUSD : sym === '^VIX' ? d.VIX : d[sym]);
  const cfg = { portfolioEnabled: true, portfolioCapital: 10_000 };
  const t1 = (d.SPY[400].t + 23 * 3600) * 1000;
  assert.deepStrictEqual(await pp.update(cfg, store, { fetcher, now: t1 }), []);
  assert.ok(store.loadJson(pp.FILE, null).startT, 'compte ouvert');
  // Le lendemain, avant 22 h UTC : rien ; après : recalcul
  const t2 = (d.SPY[410].t + 10 * 3600) * 1000;
  await pp.update(cfg, store, { fetcher, now: t2 });
  const t3 = (d.SPY[420].t + 23 * 3600) * 1000;
  require('../src/personalPortfolio').loadData; // (cache par jour : les données de test sont relues)
  await pp.update(cfg, store, { fetcher, now: t3 });
  const st = store.loadJson(pp.FILE, null);
  assert.ok(st.value > 0);
  assert.match(pp.report(cfg, store), /Portefeuille perso \(simulé\)/);
  assert.ok(pp.view(store).sleeves.length === 5);
});
