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
  assert.ok(a2.includes('/ma.mp4') && a2.includes('scale=1280:720') && a2.includes('0:a:0?')); // 720 px par défaut (mémoire)
  assert.deepStrictEqual(V.targetFor({ w: 720, h: 1280 }), { tw: 720, th: 1280 });
  assert.deepStrictEqual(V.targetFor({ w: 720, h: 1280 }, 1080), { tw: 1080, th: 1920 });
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
  V.resetFfmpeg();
  try {
    await assert.rejects(V.makeVideo(cfg, trade, 'uni', { fetcher }), (e) => e.code === 'NOFFMPEG');
  } finally {
    if (old === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = old;
    V.resetFfmpeg();
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

test('Telegram : « 📤 Ma vidéo » puis envoi d’une vidéo → la carte est posée sur cette vidéo', async () => {
  const dir = tmp();
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, lucidEnabled: false, telegramToken: '1:X' };
  store.saveJson('ftmo.json', { attempt: 2, phase: 1, capital: 100000, balance: 107000, closed: [{ ...trade }], open: {}, days: [], program: '1step' });
  // faux bot : on garde les gestionnaires
  const H = { cmd: {}, on: [], cb: [] };
  const bot = { command: (n, f) => { H.cmd[n] = f; }, on: (ev, f) => H.on.push(f), callbackQuery: (re, f) => H.cb.push(f), api: { getFile: async () => ({ file_path: 'v.mp4' }) } };
  const calls = [];
  const realMake = V.makeVideo; const realFetch = global.fetch; const realEnsure = V.ensureFfmpeg;
  V.makeVideo = async (c, t, bg, o) => { calls.push({ t, bg, src: o.sourceFile }); return Buffer.from('mp4'); };
  V.ensureFfmpeg = () => Promise.resolve('ffmpeg');
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  try {
    require('../src/videoBot').attachVideo(bot, { cfg, store, isAdmin: () => true });
    const sent = [];
    const edits = [];
    const ctx = (extra) => ({ chat: { id: 42, type: 'group' }, from: { id: 1 }, reply: async (t, o) => { sent.push({ t, o }); return { chat: { id: 42 }, message_id: 1 }; }, replyWithChatAction: async () => {}, replyWithVideo: async () => sent.push({ video: true }), answerCallbackQuery: async () => {}, api: { deleteMessage: async () => {}, editMessageText: async (c, m, t, o) => { edits.push({ t, o }); return true; } }, ...extra });
    // /video → choix du trade → clavier des fonds avec « Ma vidéo » en premier
    await H.cmd.video(ctx({ match: '' }));
    const key = `ftmo:${trade.exitT}:${trade.sid}`;
    await H.cb[0](ctx({ callbackQuery: { data: `v:t:${key}` } }));
    const kb = sent[sent.length - 1].o.reply_markup.inline_keyboard;
    assert.match(kb[0][0].text, /Ma vidéo/);
    // bouton « Ma vidéo » → le bot attend la vidéo ; vidéo envoyée dans le groupe (sans légende) → rendu sur elle
    await H.cb[0](ctx({ callbackQuery: { data: kb[0][0].callback_data } }));
    let passed = false;
    const before = sent.length;
    await H.on[0](ctx({ message: { video: { file_id: 'f', file_size: 3 * 1024 * 1024, duration: 12, width: 1080, height: 1920 } } }), async () => { passed = true; });
    assert.strictEqual(passed, false);
    // accusé de réception immédiat avec durée, taille, format ; puis modifié en « en préparation »
    assert.match(sent[before].t, /Vidéo reçue<\/b> \(12 s · 3,0 Mo · 1080×1920\)/);
    assert.ok(edits.some((e) => /Vidéo reçue/.test(e.t) && /Vidéo en préparation/.test(e.t)));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].t.sid, 'n_noise');
    assert.match(calls[0].src, /src-42\.mp4$/);
    assert.ok(sent.some((x) => x.video));
    // en privé, sans bouton : accusé puis choix du trade sur le même message
    edits.length = 0;
    await H.on[0](ctx({ chat: { id: 7, type: 'private' }, message: { video: { file_id: 'h', file_size: 1000, duration: 45 } } }), async () => {});
    const choice = edits.find((e) => /Quel trade/.test(e.t));
    assert.ok(choice && choice.o.reply_markup.inline_keyboard.length >= 1);
    assert.match(choice.t, /30 premières secondes/);
    // une autre vidéo dans le groupe, sans attente ni légende : ignorée
    await H.on[0](ctx({ message: { video: { file_id: 'g', file_size: 1000 } } }), async () => { passed = true; });
    assert.strictEqual(passed, true);
  } finally {
    V.makeVideo = realMake; global.fetch = realFetch; V.ensureFfmpeg = realEnsure;
  }
});
