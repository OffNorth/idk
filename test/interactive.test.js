const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isPng = (b) => Buffer.isBuffer(b) && b.subarray(1, 4).toString() === 'PNG';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-'));
  const cfg = { ...require('../src/config'), dataDir: dir, channelId: '-100', gameEnabled: true, gameHourUtc: 13, gameVoteHours: 3 };
  const { Store } = require('../src/store');
  const store = new Store(dir);
  store.saveJson('gold.json', {
    lastPrice: 2100,
    lastUpdate: Date.now(),
    curve: [{ t: 1_700_000_000, eq: { season: 1000 } }, { t: 1_700_086_400, eq: { season: 1030 } }],
    accounts: {
      season: {
        capital: 1050, lastEvalT: 0,
        position: { side: 'long', entry: 2000, sl: 1900, initSl: 1900, tp: null, size: 1050, best: 2000, entryT: 1_700_000_000, checkedFrom: 0 },
        closed: [{ side: 'long', entry: 1900, exit: 1995, entryT: 1_690_000_000, exitT: 1_695_000_000, pnlUsd: 50, pnlPct: 5, reason: 'signal de sortie', size: 1000, sl: 1800 }],
      },
    },
  });
  store.saveJson('nas100.json', { lastPrice: 20000, accounts: {} });
  return { cfg, store };
}

test('panneau : chaque vue donne une image, une légende et des boutons valides', async () => {
  const { cfg, store } = setup();
  const { render, tradeKeyboard } = require('../src/interactive');
  for (const [view, args] of [['h', []], ['r', []], ['o', []], ['l', ['0']], ['l', ['1']], ['s', ['x_rsi2']]]) {
    const out = await render(cfg, store, view, 'gold', args);
    assert.ok(isPng(out.png), `image ${view}`);
    assert.ok(out.caption.length <= 1024, `légende ${view}`);
    for (const b of out.keyboard.inline_keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
  const kb = tradeKeyboard({ type: 'open', market: { id: 'nas100' }, strategy: { id: 'macd_long' }, pos: { entryT: 1_794_957_311 } });
  for (const b of kb.inline_keyboard.flat()) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
});

test('cartes : trade ouvert / clôturé, positions, classement', () => {
  const C = require('../src/cards');
  const market = { id: 'gold', name: 'Or' };
  const candles = Array.from({ length: 60 }, (_, i) => ({ t: 1_690_000_000 + i * 86400, o: 1900 + i, h: 1910 + i, l: 1890 + i, c: 1905 + i }));
  const strategy = { id: 'season', name: 'Saison de l’or', desc: 'test' };
  const trade = { side: 'long', entry: 1900, exit: 1995, entryT: candles[5].t, exitT: candles[40].t, pnlUsd: 50, pnlPct: 5, reason: 'signal', size: 1000, sl: 1800 };
  assert.ok(isPng(C.tradeCardImage({ market, strategy, trade, candles })));
  assert.ok(isPng(C.tradeCardImage({ market, strategy, pos: { ...trade, exit: undefined }, price: 1960, candles })));
  assert.ok(isPng(C.rankingImage({ title: 'x', rows: [{ label: 'a', value: -1, text: '-1' }, { label: 'b', value: 2, text: '2' }], minScale: 5 })));
  assert.ok(isPng(C.priceChartImage({ market, candles, title: 't', levels: C.positionLevels(trade) })));
});

test('jeu : votes, vote modifié, résolution et points', async () => {
  const { cfg, store } = setup();
  const { createGame, nextSlot } = require('../src/game');
  // nextSlot saute le week-end : vendredi 13 h → lundi 13 h
  const fri = Date.UTC(2026, 10, 20, 13, 0, 0);
  assert.strictEqual(new Date(nextSlot(fri, 13)).getUTCDay(), 1);

  const sent = [];
  const api = {
    sendPhoto: async (chat, file, extra) => { sent.push(extra.caption); return { message_id: sent.length }; },
    editMessageReplyMarkup: async () => true,
  };
  const game = createGame({ cfg, store, api });
  cfg.nasEnabled = false; // un seul marché : pas d'appel réseau pour les bougies du Nasdaq
  const market = require('../src/markets').marketById(cfg, 'gold');
  market.fetch = async () => ({ series: { '1d': [] } });
  assert.ok(await game.open(fri));
  const answers = [];
  const ctx = (uid, name) => ({ from: { id: uid, first_name: name }, answerCallbackQuery: async (o) => answers.push(o?.text), editMessageReplyMarkup: async () => true });
  await game.onVote(ctx(1, 'Alice'), ['g', '1', 'g', 'u']);
  await game.onVote(ctx(2, 'Bob'), ['g', '1', 'g', 'u']);
  await game.onVote(ctx(2, 'Bob'), ['g', '1', 'g', 'd']); // change d'avis
  assert.match(answers[2], /modifié/);
  // L'or monte : Alice gagne, Bob perd
  const s = store.loadJson('gold.json', {});
  s.lastPrice = 2200;
  store.saveJson('gold.json', s);
  await game.resolve();
  const scores = game.load().scores;
  assert.strictEqual(scores[1].points, 1);
  assert.strictEqual(scores[2].points, 0);
  assert.strictEqual(scores[2].played, 1);
  assert.match(sent[1], /Résultat du pronostic n° 1/);
  assert.ok(isPng(game.scoreboardImage()));
});
