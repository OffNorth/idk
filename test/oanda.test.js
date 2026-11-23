const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cfg0 = () => ({ ...require('../src/config'), oandaToken: 'jeton-de-test', oandaEnv: 'practice', intradayFeed: 'auto' });
const candle = (t, c, complete = true) => ({ complete, volume: 10, time: `${t}.000000000`, mid: { o: String(c), h: String(c + 1), l: String(c - 1), c: String(c) } });
const ok = (json) => ({ ok: true, status: 200, json: async () => json });

test('OANDA : bougies (horodatage UNIX, prix milieu), en-têtes, pagination sur 5 000 bougies', async () => {
  const { fetchOanda, parseCandles } = require('../src/oanda');
  assert.deepStrictEqual(parseCandles({ candles: [candle(1795000200, 4000.5, false)] }), [{ t: 1795000200, o: 4000.5, h: 4001.5, l: 3999.5, c: 4000.5, v: 10 }]);
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    const from = Number(new URL(url).searchParams.get('from'));
    const n = from === 1795000000 ? 5000 : 3; // 1re page pleine, 2e page courte
    return ok({ candles: Array.from({ length: n }, (_, k) => candle(from + k * 300, 4000 + k)) });
  };
  const rows = await fetchOanda(cfg0(), 'XAU_USD', 300, { from: 1795000000 }, fetcher);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(rows.length, 5003);
  assert.match(calls[0].url, /^https:\/\/api-fxpractice\.oanda\.com\/v3\/instruments\/XAU_USD\/candles\?price=M&granularity=M5/);
  assert.strictEqual(calls[0].opts.headers.authorization, 'Bearer jeton-de-test');
  assert.strictEqual(calls[0].opts.headers['accept-datetime-format'], 'UNIX');
  await assert.rejects(fetchOanda({ ...cfg0(), oandaToken: '' }, 'XAU_USD', 300), /OANDA_TOKEN/);
  await assert.rejects(fetchOanda(cfg0(), 'XAU_USD', 300, {}, async () => ({ ok: false, status: 401 })), /HTTP 401/);
});

test('OANDA : séance de New York seulement (Nasdaq, S&P), cours en direct', async () => {
  const { nySession, oandaQuote } = require('../src/oanda');
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  // Lundi 23/11/2026 (heure d'hiver : New York = UTC − 5)
  const rows = ['2026-11-23T14:25:00Z', '2026-11-23T14:30:00Z', '2026-11-23T20:55:00Z', '2026-11-23T21:00:00Z', '2026-11-22T15:00:00Z'].map((s) => ({ t: at(s) }));
  assert.deepStrictEqual(nySession(rows).map((c) => c.t), [at('2026-11-23T14:30:00Z'), at('2026-11-23T20:55:00Z')]);
  const now = Math.floor(Date.now() / 1000);
  assert.strictEqual(await oandaQuote(cfg0(), 'gold', async () => ok({ candles: [candle(now - 10, 3661.2)] })), 3661.2);
  assert.strictEqual(await oandaQuote(cfg0(), 'gold', async () => ok({ candles: [candle(now - 3600, 3661.2)] })), null, 'marché fermé');
  assert.strictEqual(await oandaQuote({ ...cfg0(), oandaToken: '' }, 'gold'), null);
});

test('changement de source Yahoo → OANDA : positions ouvertes décalées de l’écart de cotation (paper et compte FTMO)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...cfg0(), dataDir: dir };
  const { MarketTrader } = require('../src/gold');
  const market = { id: 'gold', name: 'Or', file: 'gold.json', strategies: ['g_mom8'], startCapital: 1000, enabled: true, basis: async () => -12.5 };
  store.saveJson('gold.json', { accounts: { g_mom8: { position: { side: 'long', entry: 3613.8, sl: 3590.3, initSl: 3590.3, tp: null, best: 3681, size: 1000, entryT: 1 }, closed: [], capital: 1000 } } });
  store.saveJson('ftmo.json', { capital: 100000, balance: 100000, open: { k: { market: 'gold', entry: 3613.8, sl: 3590.3, signal: 3614.4 }, n: { market: 'nas100', entry: 26989, sl: 26373 } } });
  const tr = new MarketTrader(market, store, cfg);
  await tr.switchFeed('yahoo', 'oanda');
  const p = tr.state.accounts.g_mom8.position;
  assert.ok(Math.abs(p.entry - 3601.3) < 1e-9 && Math.abs(p.sl - 3577.8) < 1e-9 && Math.abs(p.best - 3668.5) < 1e-9);
  assert.strictEqual(p.tp, null);
  const f = store.loadJson('ftmo.json');
  assert.ok(Math.abs(f.open.k.entry - 3601.3) < 1e-9 && Math.abs(f.open.k.signal - 3601.9) < 1e-9);
  assert.strictEqual(f.open.n.entry, 26989, 'Nasdaq non touché');
  assert.strictEqual(tr.state.feed, 'oanda');
  assert.strictEqual(tr.state.feedSwitch.shift, -12.5);
});

test('OANDA en panne : passage ignoré pendant 30 min, puis retour sur Yahoo', async () => {
  const { oandaIntraday } = require('../src/markets');
  const realFetch = global.fetch;
  const realNow = Date.now;
  let now = Date.now();
  Date.now = () => now;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    const cfg = cfg0();
    await assert.rejects(oandaIntraday(cfg, 'eurusd', ['5m']), /OANDA/);
    now += 10 * 60_000;
    await assert.rejects(oandaIntraday(cfg, 'eurusd', ['5m']));
    now += 25 * 60_000;
    assert.strictEqual(await oandaIntraday(cfg, 'eurusd', ['5m']), null, 'après 30 min : Yahoo');
  } finally {
    global.fetch = realFetch;
    Date.now = realNow;
  }
});
