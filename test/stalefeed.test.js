const test = require('node:test');
const assert = require('node:assert');

test('bougies Yahoo figées, cours à jour : bougies maison 1 / 5 / 15 min ; marché fermé ou bougies à jour : rien', async () => {
  const { patch, _books } = require('../src/staleFeed');
  _books.clear();
  const T = 1_800_000_000 - (1_800_000_000 % 3600); // heure ronde
  const bar = (t, c) => ({ t, o: c, h: c, l: c, c, v: 1 });
  const y5 = Array.from({ length: 12 }, (_, i) => bar(T + i * 300, 100 + i)); // Yahoo : dernière bougie 5 min à T + 55 min
  const y1 = Array.from({ length: 60 }, (_, i) => bar(T + i * 60, 100));
  const data = () => ({ price: 111, stops: y5, series: { '5m': y5, '1m': y1, '15m': [bar(T, 100), bar(T + 900, 101), bar(T + 1800, 102), bar(T + 2700, 103)] }, feed: 'yahoo' });
  const market = { id: 'gold', yahooSymbol: 'GC=F' };
  const logs = [];
  const log = (x) => logs.push(x);
  const end = T + 3600;
  // Bougies à jour (10 min) : rien
  let out = await patch(market, data(), { now: end + 600, quoteOf: async () => ({ price: 120, t: end + 590 }), log });
  assert.ok(!out.synthetic);
  // Figées depuis 40 min mais cours figé aussi (marché fermé) : rien
  out = await patch(market, data(), { now: end + 2400, quoteOf: async () => ({ price: 111, t: end }), log });
  assert.ok(!out.synthetic);
  // Figées, cours qui avance : un relevé par minute pendant 12 minutes
  for (let k = 0; k < 12; k++) {
    const now = end + 2400 + k * 60;
    out = await patch(market, data(), { now, quoteOf: async () => ({ price: 120 + k, t: now - 30 }), log });
  }
  assert.ok(out.synthetic);
  assert.strictEqual(out.price, 131);
  const own1 = out.series['1m'].filter((b) => b.syn);
  assert.strictEqual(own1.length, 12);
  assert.ok(out.series['1m'].every((b, i, a) => !i || b.t > a[i - 1].t), '1 min triées, sans doublon');
  assert.ok(out.series['5m'].every((b, i, a) => !i || b.t > a[i - 1].t), '5 min triées, sans doublon');
  assert.ok(out.series['15m'].every((b, i, a) => !i || b.t > a[i - 1].t), '15 min triées, sans doublon');
  const last5 = out.stops[out.stops.length - 1];
  assert.ok(last5.syn && last5.c === 131 && last5.h >= last5.l);
  assert.ok(logs.some((x) => /secours avec des bougies maison/.test(x)));
  // OANDA : jamais touché
  out = await patch(market, { ...data(), feed: 'oanda' }, { now: end + 9999, quoteOf: async () => ({ price: 1, t: end + 9990 }), log });
  assert.ok(!out.synthetic);
  // Yahoo revient : fin du secours
  out = await patch(market, { ...data(), stops: [...y5, bar(end + 3000, 130)], series: { ...data().series, '5m': [...y5, bar(end + 3000, 130)] } }, { now: end + 3300, quoteOf: async () => ({ price: 130, t: end + 3290 }), log });
  assert.ok(!out.synthetic);
  assert.ok(logs.some((x) => /fin du secours/.test(x)));
});
