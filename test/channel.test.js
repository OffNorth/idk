const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('groupe : supergroupe (nouvel ID) → nouvel essai et ID mémorisé ; erreur gardée et signalée', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chan-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const { createChannel } = require('../src/channel');
  const cfg = { channelId: '-111' };
  const sent = [];
  const api = {
    sendMessage: async (id, text) => {
      if (id === '-111') throw Object.assign(new Error('Bad Request: group chat was upgraded to a supergroup chat'), { description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100222 } });
      if (text === 'boom') throw Object.assign(new Error('Forbidden: bot was kicked'), { description: 'Forbidden: bot was kicked from the supergroup chat' });
      sent.push([id, text]);
      return { ok: true };
    },
  };
  const alerts = [];
  const ch = createChannel(api, cfg, store, { onError: (e) => alerts.push(e.description) });
  await ch.sendText('achat');
  assert.deepStrictEqual(sent, [['-100222', 'achat']]);
  assert.strictEqual(cfg.channelId, '-100222');
  assert.match(ch.status(), /dernier envoi réussi il y a 0 min/);
  // Au redémarrage avec l'ancien ID du .env : le nouvel ID est repris
  const cfg2 = { channelId: '-111' };
  createChannel(api, cfg2, store);
  assert.strictEqual(cfg2.channelId, '-100222');
  await assert.rejects(ch.sendText('boom'));
  assert.strictEqual(alerts.length, 1);
  const { setTimeout: wait } = require('timers/promises');
  await wait(5);
  store.setMeta('channelLastOk', Date.now() - 3_600_000);
  assert.match(ch.status(), /dernière erreur il y a 0 min : .*kicked.*ADMINISTRATEUR/);
});
