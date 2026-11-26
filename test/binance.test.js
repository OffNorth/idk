const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const binance = require('../src/binance');
const markets = require('../src/markets');
const cfg0 = () => ({ ...require('../src/config'), oandaToken: '', intradayFeed: 'auto', binanceFeed: true });
const NOW = Date.UTC(2026, 10, 25, 15, 0); // mercredi 10 h à New York : marché ouvert

/** Faux serveur Binance : bougies régulières jusqu'à `endMs` (prix 4000 + minute / 100). */
function fakeBinance({ endMs = NOW, status = 200, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({ code: 0, msg: status === 451 ? 'Service unavailable from a restricted location' : 'Service Unavailable' }) };
    const q = new URL(url).searchParams;
    const sec = { '1m': 60, '5m': 300, '15m': 900 }[q.get('interval')];
    const limit = Number(q.get('limit'));
    const last = Math.floor(endMs / 1000 / sec) * sec;
    let start = q.get('startTime') ? Math.ceil(Number(q.get('startTime')) / 1000 / sec) * sec : last - (limit - 1) * sec;
    const rows = [];
    for (let t = start; t <= last && rows.length < limit; t += sec) { const p = 4000 + t / 6000; rows.push([t * 1000, String(p), String(p + 1), String(p - 1), String(p + 0.5), '12']); }
    return { ok: true, status: 200, json: async () => rows };
  };
}
const reset = () => { markets._bn.clear(); markets._memo.clear(); };

test('Binance : bougies lues, et retirées quand le vrai marché de l’or est fermé (week-end, pause de 17 h)', () => {
  const c = binance.parseKlines([[1764000000000, '1', '2', '0.5', '1.5', '3'], ['x']]);
  assert.deepStrictEqual(c, [{ t: 1764000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 }]);
  const at = (d, h, m = 0) => ({ t: Date.UTC(2026, 10, d, h, m) / 1000 }); // novembre : New York = UTC − 5
  const kept = binance.metalsOpen([at(25, 15), at(25, 22, 30), at(25, 23), at(27, 21, 55), at(27, 22), at(28, 12), at(29, 22, 55), at(29, 23)]);
  assert.deepStrictEqual(kept.map((x) => new Date(x.t * 1000).toISOString().slice(5, 16)),
    ['11-25T15:00', '11-25T23:00', '11-27T21:55', '11-29T23:00'], 'pause 17 h ET, vendredi 17 h → dimanche 18 h ET retirés');
  assert.strictEqual(binance.openNow(NOW / 1000), true);
  assert.strictEqual(binance.openNow(Date.UTC(2026, 10, 28, 12) / 1000), false);
});

test('Binance : or en temps réel sans compte (5 min sur 60 jours, 15 min, 1 min), source « binance »', async () => {
  reset();
  const calls = [];
  const out = await markets.binanceIntraday(cfg0(), 'gold', ['5m', '1m'], { fetcher: fakeBinance({ calls }), now: NOW });
  assert.ok(out && out.m5.length > 10000, 'environ 60 jours de bougies 5 min');
  assert.strictEqual(out.m5[out.m5.length - 1].t, NOW / 1000, 'bougie en cours comprise');
  assert.ok(out.series['15m'].length > 3000 && out.series['1m'].length > 2000);
  assert.ok(calls.every((u) => u.startsWith('https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT')));
  assert.ok(!calls.some((u) => /key|signature/i.test(u)), 'aucune clé');
  assert.ok(Math.abs(out.price - out.m5[out.m5.length - 1].c) < 1e-9);
  assert.strictEqual(markets.useBinance(cfg0(), 'gold'), true);
  assert.strictEqual(markets.binanceActive(cfg0(), 'gold'), true, 'cours d’exécution pris chez Binance');
  assert.strictEqual(markets.useBinance(cfg0(), 'nas100'), false, 'indices : pas de contrat Binance');
  assert.strictEqual(markets.useBinance({ ...cfg0(), oandaToken: 'x' }, 'gold'), false, 'OANDA prioritaire');
  assert.strictEqual(markets.useBinance({ ...cfg0(), binanceFeed: false }, 'gold'), false);
});

test('Binance bloqué (pays / hébergeur) : Yahoo tout de suite, nouvel essai 30 min plus tard', async () => {
  reset();
  const calls = [];
  const f = fakeBinance({ status: 451, calls });
  assert.strictEqual(await markets.binanceIntraday(cfg0(), 'gold', ['5m'], { fetcher: f, now: NOW }), null);
  const n = calls.length;
  assert.strictEqual(await markets.binanceIntraday(cfg0(), 'gold', ['5m'], { fetcher: f, now: NOW + 20 * 60_000 }), null);
  assert.strictEqual(calls.length, n, 'pas de nouvel appel avant 30 min');
  assert.strictEqual(markets.binanceActive(cfg0(), 'gold', NOW + 20 * 60_000), false, 'cours d’exécution Yahoo');
  markets._memo.clear();
  const ok = await markets.binanceIntraday(cfg0(), 'gold', ['5m'], { fetcher: fakeBinance({ endMs: NOW + 31 * 60_000 }), now: NOW + 31 * 60_000 });
  assert.ok(ok?.m5.length, 'Binance revenu');
});

test('Binance qui marchait puis coupure : passage ignoré moins de 10 min, puis Yahoo', async () => {
  reset();
  assert.ok(await markets.binanceIntraday(cfg0(), 'silver', ['5m'], { session: true, fetcher: fakeBinance(), now: NOW }));
  markets._memo.delete('bn:silver:5m');
  const down = fakeBinance({ status: 503 });
  await assert.rejects(markets.binanceIntraday(cfg0(), 'silver', ['5m'], { session: true, fetcher: down, now: NOW + 60_000 }), /503/);
  markets._memo.delete('bn:silver:5m');
  await assert.rejects(markets.binanceIntraday(cfg0(), 'silver', ['5m'], { session: true, fetcher: down, now: NOW + 6 * 60_000 }));
  markets._memo.delete('bn:silver:5m');
  assert.strictEqual(await markets.binanceIntraday(cfg0(), 'silver', ['5m'], { session: true, fetcher: down, now: NOW + 12 * 60_000 }), null);
});

test('Binance → Yahoo quand Binance tombe : positions ramenées avec le dernier écart mesuré', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnfeed-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...cfg0(), dataDir: dir };
  const { MarketTrader } = require('../src/gold');
  let up = true;
  const market = { id: 'gold', name: 'Or', file: 'gold.json', strategies: ['g_mom8'], startCapital: 1000, enabled: true,
    basis: async (feed) => { if (feed !== 'binance' || !up) throw new Error('injoignable'); return -21.5; } };
  store.saveJson('gold.json', { accounts: { g_mom8: { position: { side: 'long', entry: 4100, sl: 4080, initSl: 4080, tp: 4150, best: 4110, size: 1000, entryT: 1 }, closed: [], capital: 1000 } } });
  const tr = new MarketTrader(market, store, cfg);
  await tr.switchFeed('yahoo', 'binance');
  assert.strictEqual(tr.state.accounts.g_mom8.position.entry, 4078.5);
  assert.strictEqual(tr.state.feedBasis.binance, -21.5);
  up = false;
  await tr.switchFeed('binance', 'yahoo');
  assert.strictEqual(tr.state.accounts.g_mom8.position.entry, 4100, 'retour exact malgré Binance injoignable');
  assert.strictEqual(tr.state.feed, 'yahoo');
});

test('site : trades passés par Binance ramenés à l’échelle des bougies Yahoo', () => {
  const { toChartScale } = require('../src/livePush');
  const off = { gold: { b: -20, since: 1000 } };
  const open = [{ market: 'gold', entry: 4080, sl: 4060, tp: 4120, entryT: 500 }, { market: 'nas100', entry: 25000, entryT: 500 }];
  toChartScale(open, off, true);
  assert.deepStrictEqual([open[0].entry, open[0].sl, open[0].tp, open[1].entry], [4100, 4080, 4140, 25000]);
  const closed = [{ market: 'gold', entry: 4080, exit: 4090, exitT: 900 }, { market: 'gold', entry: 4080, exit: 4090, exitT: 1100 }];
  toChartScale(closed, off);
  assert.deepStrictEqual(closed.map((t) => t.exit), [4090, 4110], 'trade clos avant le passage sur Binance : inchangé');
});
