const test = require('node:test');
const assert = require('node:assert');
const { backtest } = require('../src/gold');
const { selectStrategies } = require('../src/strategies');

const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
/** Bougies 5 min sur plusieurs jours ; px(t) donne le cours. */
function candles(fromIso, days, px) {
  const out = [];
  const t0 = Date.parse(fromIso) / 1000;
  for (let t = t0; t < t0 + days * 86400; t += 300) {
    const c = px(t);
    out.push({ t, o: c, h: c + 0.5, l: c - 0.5, c, v: 1 });
  }
  return out;
}
const run = (id, c) => backtest(selectStrategies([id])[0], c, { size: 1000, feePct: 0.005, barSec: 300, market: 'gold' }).list;

test('g_asiabrk : range 0 h → 7 h UTC, une seule cassure par jour avant 11 h, sortie 19 h UTC', () => {
  const iso = '2026-03-02T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  const c = candles(iso, 4, (t) => {
    if (t < day) return 4000 + Math.sin(t / 900);
    const h = (t - day) / 3600;
    return h < 7 ? 4000 + (h % 1 < 0.5 ? 2 : -2) : h < 8 ? 4000 : 4010; // cassure du plus haut (4 002,5) à 8 h
  });
  const tr = run('g_asiabrk', c).filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(hhmm(tr[0].entryT), '08:00');
  assert.strictEqual(hhmm(tr[0].exitT), '19:00');
  assert.ok(Math.abs(tr[0].initSl - 3997.5) < 1e-9, 'stop sous le plus bas du range asiatique');
});

test('séances : stratégies en paper trading à l’essai, pas sur les comptes FTMO / Lucid', () => {
  const cfg = require('../src/config');
  const ids = selectStrategies(cfg.goldStrategies).map((s) => s.id);
  assert.ok(ids.includes('g_asiabrk'));
  assert.ok(![...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies].some((s) => /asiabrk|fixfade/.test(s)));
});
