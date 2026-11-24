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

test('g_nypdl / n_pdlbrk : cassure du plus haut de la veille, une entrée par jour, sortie à l’heure (New York)', () => {
  // Hiver : New York = UTC − 5. Veille plate à 4 000 (± 1), jour J : 4 010 à partir de 15 h UTC (10 h NY)
  const iso = '2026-01-12T00:00:00Z';
  const day = Date.parse(iso) / 1000 + 2 * 86400;
  const c = candles(iso, 4, (t) => (t < day + 15 * 3600 ? 4000 + Math.sin(t / 900) : 4010));
  const tr = run('g_nypdl', c).filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(tr.length, 1);
  assert.strictEqual(tr[0].side, 'long');
  assert.strictEqual(hhmm(tr[0].entryT), '15:00');
  assert.strictEqual(hhmm(tr[0].exitT), '21:55', 'sortie 16 h 55 NY');
  const n = backtest(selectStrategies(['n_pdlbrk'])[0], candles(iso, 4, (t) => (t < day + 15 * 3600 ? 26000 + Math.sin(t / 900) * 5 : 26100)), { size: 1000, feePct: 0.003, barSec: 300, market: 'nas100' }).list.filter((x) => x.entryT >= day && x.entryT < day + 86400);
  assert.strictEqual(n.length, 1);
  assert.strictEqual(hhmm(n[0].entryT), '15:00');
  assert.strictEqual(hhmm(n[0].exitT), '20:55', 'sortie 15 h 55 NY');
});

test('séances : g_asiabrk, g_nypdl, n_pdlbrk sur le compte FTMO ; seule n_pdlbrk sur Lucid', () => {
  const cfg = require('../src/config');
  assert.ok(cfg.ftmoStrategies.includes('gold:g_asiabrk') && cfg.ftmoStrategies.includes('gold:g_nypdl'));
  assert.ok(cfg.ftmoNasStrategies.includes('nas100:n_pdlbrk'));
  const L = require('../src/ftmoAccount').accountOf({ ...cfg, ftmoEnabled: true, lucidEnabled: true }, 'lucid');
  assert.ok(L.riskOf('nas100', { id: 'n_pdlbrk', tf: '5m' }) > 0);
  assert.strictEqual(L.riskOf('gold', { id: 'g_nypdl', tf: '5m' }), 0);
  assert.strictEqual(L.riskOf('gold', { id: 'g_asiabrk', tf: '5m' }), 0);
});
