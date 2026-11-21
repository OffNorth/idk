const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const V = require('../src/pnlVideo');

const T0 = 1795185000;
const candles = Array.from({ length: 78 }, (_, i) => { const c = 26100 - i * 13; return { t: T0 + i * 300, o: c + 5, h: c + 20, l: c - 20, c }; });
const fetcher = async () => candles;
const trade = { market: 'nas100', sid: 'n_noise', name: 'Nasdaq : sortie de la zone de bruit', side: 'short', entry: 25955.97, sl: 26007.74, exit: 25059.02, entryT: T0 + 13 * 300 + 1, exitT: T0 + 77 * 300 + 30, pnl: 7290.21, risk: 421.53, notional: 211332, account: 'FTMO', program: 'Challenge 1 étape', capital: 100000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));

test('vidéo PnL : carte image par image, fonds, arguments ffmpeg', async () => {
  const card = V.prepareCard(trade, { interval: '5m', sec: 300, candles });
  assert.strictEqual(card.frame(0).length, 540 * 675 * 4); // RGBA (transparent)
  assert.ok(card.frames >= 200);
  const png = card.png();
  assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');
  const cfg = { dataDir: tmp() };
  assert.deepStrictEqual(V.backgrounds(cfg).map((b) => b.id), ['uni', 'grille', 'particules']);
  for (const id of ['uni', 'grille', 'particules']) {
    const a = V.ffmpegArgs(cfg, id, '/o.mp4', 7.2);
    assert.ok(a.includes('pipe:0') && a.includes('/o.mp4') && a.includes('rgba') && a.join(' ').includes('overlay'));
  }
  // fond perso : enregistré, listé, utilisé, supprimé ; nom nettoyé ; 10 au plus
  assert.strictEqual(V.saveBackground(cfg, 'Plage été!', Buffer.from('x')), 'plage-ete');
  assert.ok(V.backgrounds(cfg).some((b) => b.id === 'u:plage-ete'));
  assert.ok(V.ffmpegArgs(cfg, 'u:plage-ete', '/o.mp4', 7).join(' ').includes('plage-ete.mp4'));
  // vidéo envoyée : format gardé (horizontal → 1920×1080), son conservé, carte 4:5 qui tient dans l'image
  const a2 = V.ffmpegArgs(cfg, null, '/o.mp4', 12, { file: '/ma.mp4', w: 1280, h: 720, audio: true }).join(' ');
  assert.ok(a2.includes('/ma.mp4') && a2.includes('scale=1920:1080') && a2.includes('0:a:0?'));
  assert.deepStrictEqual(V.targetFor({ w: 720, h: 1280 }), { tw: 1080, th: 1920 });
  const cs = V.cardSize(1920, 1080);
  assert.ok(cs.ch <= 1080 * 0.82 + 1 && cs.cw % 2 === 0);
  for (let i = 0; i < 9; i++) V.saveBackground(cfg, `f${i}`, Buffer.from('x'));
  assert.throws(() => V.saveBackground(cfg, 'onzieme', Buffer.from('x')), /10 fonds/);
  assert.ok(V.deleteBackground(cfg, 'plage-ete'));
  // unité des bougies selon la durée et l'ancienneté
  assert.strictEqual(V.intervalFor({ entryT: 1000, exitT: 1000 + 5 * 3600 }, 1000 + 86400).iv, '5m');
  assert.strictEqual(V.intervalFor({ entryT: 1000, exitT: 1000 + 10 * 86400 }, 1000 + 20 * 86400).iv, '1d'); // trade de 10 jours : bougies journalières
  assert.strictEqual(V.intervalFor({ entryT: 1000, exitT: 1000 + 3600 }, 1000 + 400 * 86400).iv, '1h');
});

test('vidéo PnL : MP4 produit par ffmpeg, sans ffmpeg → erreur claire', { timeout: 120000 }, async () => {
  const cfg = { dataDir: tmp() };
  if (V.ffmpegPath()) {
    const buf = await V.makeVideo(cfg, trade, 'uni', { fetcher });
    assert.ok(buf.length > 10_000);
    assert.strictEqual(buf.subarray(4, 8).toString(), 'ftyp');
  }
  const old = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '/introuvable/ffmpeg';
  try {
    await assert.rejects(V.makeVideo(cfg, trade, 'uni', { fetcher }), (e) => e.code === 'NOFFMPEG');
  } finally {
    if (old === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = old;
  }
});

test('vidéo PnL : derniers trades des comptes (challenge en cours + archive)', () => {
  const dir = tmp();
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, lucidEnabled: true };
  store.saveJson('ftmo.json', { attempt: 2, phase: 1, capital: 100000, balance: 107000, closed: [{ ...trade, market: 'nas100' }], open: {}, days: [], program: '1step' });
  store.saveJson('ftmo-archive.json', [{ ...trade, exitT: trade.exitT - 86400, sid: 'g_orb30', market: 'gold', pnl: -400, attempt: 1 }]);
  const list = require('../src/videoBot').recentTrades(cfg, store);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].sid, 'n_noise');
  assert.strictEqual(list[0].account, 'FTMO');
  assert.match(require('../src/videoBot').tradeLabel(list[0]), /Nasdaq vente · \+7.290 \$/);
});
