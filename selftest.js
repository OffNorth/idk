#!/usr/bin/env node
/**
 * Boucle de test de TOUT le bot, hors ligne : vrai bot.js (commandes, boutons, passages, groupe, comptes FTMO /
 * Lucid), mais Telegram intercepté (réponses factices), marchés simulés (scénario de ~40 jours), horloge simulée,
 * réseau coupé et dossier de données temporaire. Rien n'est envoyé nulle part.
 *
 *   npm run selftest            (hors ligne)
 *   npm run selftest -- --live  (+ un vrai passage sur les données Yahoo actuelles, sans publication)
 *
 * Étapes : 1. scénario de marché (achats / ventes → un message dans le groupe à chaque fois, réussite, compte
 * financé, retrait, perte, nouveau challenge) · 2. toutes les commandes (admin et membre) · 3. tous les boutons
 * atteignables · 4. pannes (groupe refusé, supergroupe, données indisponibles) · 5. (--live) vrai passage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ADMIN_ID = 42;
const MEMBER_ID = 7;
const GROUP_ID = '-100500';

async function run({ live = false, log = console.log } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'));
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '123456:selftest', DATA_DIR: dir, TELEGRAM_CHANNEL_ID: GROUP_ID, ALLOWED_TELEGRAM_USER_IDS: String(ADMIN_ID),
    LIVE_PUSH: '0', BACKUP: '0', BACKUP_RESTORE: '0', FILL_DELAY_SEC: '0', INTRADAY_FEED: 'yahoo', PORTFOLIO: '0',
  });
  delete process.env.OANDA_TOKEN;
  for (const k of Object.keys(require.cache)) if (k.startsWith(__dirname + path.sep) && !k.includes(`${path.sep}node_modules${path.sep}`)) delete require.cache[k];

  const report = [];
  const errors = [];
  const step = (name, ok, detail = '') => {
    report.push({ name, ok, detail });
    log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Horloge simulée (Date.now) et réseau coupé (aucun appel sortant pendant la boucle hors ligne)
  const realNow = Date.now;
  const realFetch = global.fetch;
  let simNow = Date.UTC(2026, 11, 7, 6) / 1000; // lundi 7 décembre 2026, 6 h UTC
  Date.now = () => simNow * 1000;
  global.fetch = async (url) => { throw new Error(`réseau coupé pendant le selftest (${String(url).slice(0, 60)})`); };

  // Telegram intercepté
  const calls = [];
  let msgId = 1000;
  let failGroup = null; // panne simulée de l'envoi au groupe
  const B = require('./bot.js');
  const { bot, cfg, store } = B;
  bot.botInfo = { id: 1, is_bot: true, first_name: 'Selftest', username: 'selftest_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    const chat = { id: payload.chat_id ?? ADMIN_ID, type: String(payload.chat_id).startsWith('-') ? 'supergroup' : 'private', title: 'Groupe test' };
    if (failGroup && String(payload.chat_id) === GROUP_ID && /^send/.test(method)) {
      const e = failGroup;
      if (e.once) failGroup = null;
      return { ok: false, error_code: e.code, description: e.description, parameters: e.parameters };
    }
    const msg = { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat, text: payload.text, caption: payload.caption };
    const R = {
      getMe: bot.botInfo, getChat: chat, getChatMember: { status: 'administrator', user: bot.botInfo, can_post_messages: true },
      answerCallbackQuery: true, setMyCommands: true, setChatMenuButton: true, sendChatAction: true, deleteMessage: true,
      getFile: { file_id: 'f', file_unique_id: 'u', file_size: 10, file_path: 'x.mp4' },
    };
    return { ok: true, result: R[method] ?? msg };
  });
  bot.catch((err) => errors.push(`${err.ctx?.update?.message?.text || err.ctx?.update?.callback_query?.data || '?'} : ${err.error?.stack || err.error || err}`));
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));

  // Marchés simulés : MarketTrader.run remplacé par un scénario (le vrai état paper est tenu à jour)
  const { MarketTrader } = require('./src/markets');
  const { closePos } = require('./src/gold');
  const { selectStrategies } = require('./src/strategies');
  const origRun = MarketTrader.prototype.run;
  const script = new Map(); // `${marché}:${t}` → événements à produire au passage
  let marketDown = false;
  MarketTrader.prototype.run = async function () {
    if (marketDown) throw new Error('données indisponibles (simulé)');
    const out = [];
    const t = Math.floor(Date.now() / 1000);
    for (const [k, list] of script) {
      const [m, at] = [k.split('@')[0], Number(k.split('@')[1])];
      if (m !== this.market.id || at > t) continue;
      for (const e of list) {
        const strat = selectStrategies([e.sid])[0] || { id: e.sid, name: e.sid, tf: e.tf || '1d' };
        const acc = this.account(e.sid);
        if (e.type === 'open') {
          const dir = e.side === 'long' ? 1 : -1;
          acc.position = { side: e.side, entry: e.price, sl: e.price - dir * e.stop, initSl: e.price - dir * e.stop, tp: null, size: 1000, best: e.price, entryT: t, checkedFrom: t };
          out.push({ type: 'open', market: this.market, strategy: strat, pos: acc.position });
        } else if (acc.position) {
          const trade = closePos(acc.position, e.price, e.reason || 'signal de sortie', t, 0.01, 0);
          acc.capital += trade.pnlUsd;
          acc.closed.push(trade);
          acc.position = null;
          out.push({ type: 'close', market: this.market, strategy: strat, trade, capital: acc.capital, start: this.market.startCapital });
        }
        this.state.lastPrice = e.price;
      }
      script.delete(k);
    }
    this.state.lastPrice ??= { gold: 4000, nas100: 26000, spx: 7000, eurusd: 1.09 }[this.market.id];
    this.state.lastUpdate = Date.now();
    this.save();
    return out;
  };
  const at = (market, t, ev) => {
    const k = `${market}@${t}`;
    if (!script.has(k)) script.set(k, []);
    script.get(k).push(ev);
  };

  try {
    // ---------------------------------------------------------------- 1. scénario de marché
    const { runCycle } = require('./src/cycle');
    const groupMsgs = () => calls.filter((c) => /^send(Message|Photo)$/.test(c.method) && String(c.payload.chat_id) === GROUP_ID);
    const textOf = (c) => c.payload.text || c.payload.caption || '';
    const cycle = async () => {
      try {
        await runCycle({ cfg, store, channel: B.channel, publish: true, buttons: true });
      } catch (err) {
        errors.push(`passage : ${err.stack || err}`);
      }
    };
    const DAY = 86400;
    const start = simNow;
    const dayT = (k, h, m = 0) => start + k * DAY + (h - 6) * 3600 + m * 60;
    // Jours ouvrés uniquement ; or journalière (2 % de risque) gagnante puis pertes ; Nasdaq intraday ; S&P / EUR
    const plan = [];
    let k = 0;
    for (let n = 0; n < 40; n++, k++) {
      while ([0, 6].includes(new Date((start + k * DAY) * 1000).getUTCDay())) k++;
      const g = 4000 + n * 3;
      const win = n < 22 || n % 3 !== 0; // gagnant presque toujours, puis une série de pertes en fin de scénario
      const lose = n >= 34; // grosses pertes : compte financé perdu
      plan.push([k, n]);
      at('gold', dayT(k, 9), { type: 'open', sid: 'down3', side: 'long', price: g, stop: 40 });
      at('gold', dayT(k, 16), { type: 'close', sid: 'down3', price: lose ? g - 160 : win ? g + 50 : g - 40 });
      at('nas100', dayT(k, 15, 30), { type: 'open', sid: 'n_noise', tf: '5m', side: n % 2 ? 'short' : 'long', price: 26000, stop: 60 });
      at('nas100', dayT(k, 20, 55), { type: 'close', sid: 'n_noise', price: n % 2 ? (win ? 25900 : 26060) : (win ? 26100 : 25940) });
      if (n % 5 === 0) {
        at('spx', dayT(k, 15), { type: 'open', sid: 'down3', side: 'long', price: 7000, stop: 70 });
        at('spx', dayT(k + 1, 15), { type: 'close', sid: 'down3', price: 7050 });
        at('eurusd', dayT(k, 8), { type: 'open', sid: 'ibs', side: 'short', price: 1.09, stop: 0.005 });
        at('eurusd', dayT(k, 18), { type: 'close', sid: 'ibs', price: 1.087 });
      }
    }
    const times = [...new Set([...script.keys()].map((x) => Number(x.split('@')[1])))].sort((a, b) => a - b);
    // IA validatrice en mode « block » la 1re semaine (signaux refusés annoncés), puis en observation : tous les
    // trades du scénario passent, pour aller jusqu'au bout du cycle (réussite, financé, retrait, perte)
    const quiet = console.log;
    console.log = () => {};
    for (const t of times) {
      simNow = t;
      cfg.ftmoAi = t < start + 7 * DAY ? 'block' : 'observe';
      await cycle();
    }
    console.log = quiet;
    simNow += 3 * DAY;
    await cycle();
    const { createFtmo, ftmoAccounts } = require('./src/ftmoAccount');
    const books = ftmoAccounts(cfg).map((a) => ({ a, f: createFtmo({ cfg, store, account: a.id }) }));
    const sent = groupMsgs().map(textOf);
    const lines = [];
    let okMsgs = true;
    for (const { a, f } of books) {
      const s = f.load();
      const arch = f.archived();
      const tag = a.firm === 'Lucid' ? `🟣 <b>Lucid${a.tag ? ` ${a.tag}` : ''}</b>` : '🏦 <b>FTMO</b>';
      const opens = sent.filter((x) => x.startsWith(`${tag} · 📈`) || x.startsWith(`${tag} · 📉`)).length;
      const closes = sent.filter((x) => x.startsWith(`${tag} · 🟢`) || x.startsWith(`${tag} · 🔴`)).length;
      const taken = arch.length + s.closed.length + Object.keys(s.open).length;
      const closedN = arch.length + s.closed.length;
      const hist = (s.history || []).map((h) => h.outcome).join(', ');
      lines.push(`${a.firm} : ${opens} achats/ventes annoncés pour ${taken} trades pris, ${closes} clôtures annoncées pour ${closedN} · challenge n° ${s.attempt} (${s.phase}) · historique : ${hist || '—'}`);
      if (opens !== taken || closes !== closedN) okMsgs = false;
    }
    step('scénario : un message dans le groupe pour chaque achat et chaque vente (FTMO et Lucid)', okMsgs && books.length > 0, lines.join(' | '));
    const ev = (re) => sent.filter((x) => re.test(x)).length;
    const pass = ev(/^🏦(🏆|✅)/);
    const fail = ev(/^🏦❌/);
    const pay = ev(/simulated payout #/);
    const refused = ev(/refused by the AI/);
    step('scénario : réussite → compte financé → retrait → perte → nouveau challenge', pass > 0 && fail > 0 && pay > 0, `${pass} réussite(s), ${pay} retrait(s), ${fail} échec(s)/perte(s), ${refused} signal(s) refusé(s) par l'IA annoncé(s), ${sent.length} messages dans le groupe`);
    const bad = sent.filter((x) => /undefined|NaN|\[object Object\]/.test(x));
    step('messages du groupe sans « undefined » / « NaN »', !bad.length, bad.slice(0, 3).join(' ‖ ').slice(0, 400));

    // ---------------------------------------------------------------- 2. toutes les commandes
    let upd = 1;
    const message = (text, from = ADMIN_ID) => ({ update_id: ++upd, message: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: from === ADMIN_ID ? 'Admin' : 'Membre' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [] } });
    const send = async (update) => {
      const before = calls.length;
      const e0 = errors.length;
      try {
        await bot.handleUpdate(update);
      } catch (err) {
        errors.push(`${update.message?.text || update.callback_query?.data} : ${err.stack || err}`);
      }
      return { out: calls.slice(before), err: errors.slice(e0) };
    };
    const CMDS = ['/start', '/aide', '/menu', '/menu or', '/graphique', '/graphique or', '/nasdaq', '/gold', '/sp500', '/eurusd', '/portfolio', '/historique', '/historique ftmo',
      '/strategies', '/ftmo', '/ftmo or', '/lucid', '/timemachine', '/interface', '/version', '/verif', '/jeu', '/classement', '/settings', '/testcanal', '/bilan', '/export',
      '/adapt', '/video', '/fonds', '/signature', '/signature @test', '/pause', '/resume', '/financer lucid', '/financer'];
    const NETWORK = new Set(['/backtest', '/simulation']); // téléchargent l'historique : seulement avec --live
    const noReply = [];
    const cmdErr = [];
    const seenKb = [];
    const collectKb = (out) => {
      for (const c of out) {
        const kb = c.payload?.reply_markup?.inline_keyboard;
        if (kb) seenKb.push(...kb.flat().filter((b) => b.callback_data).map((b) => ({ data: b.callback_data, chat: c.payload.chat_id })));
        const cap = c.payload?.caption ?? c.payload?.media?.caption;
        if (cap && cap.length > 1024) cmdErr.push(`légende trop longue (${cap.length}) après ${c.method}`);
      }
    };
    for (const cmd of CMDS) {
      const { out, err } = await send(message(cmd));
      collectKb(out);
      if (err.length) cmdErr.push(`${cmd} : ${err[0].split('\n')[0]}`);
      if (!out.some((c) => /^(send|edit)/.test(c.method))) noReply.push(cmd);
    }
    step(`commandes (${CMDS.length}) : réponse sans erreur`, !cmdErr.length && !noReply.length, [...cmdErr, ...noReply.map((c) => `${c} : pas de réponse`)].join(' | ').slice(0, 900));
    const ADMIN_CMDS = ['/settings', '/testcanal', '/verif', '/financer', '/pause', '/video'];
    const leaked = [];
    for (const cmd of ADMIN_CMDS) {
      const { out } = await send(message(cmd, MEMBER_ID));
      if (!out.some((c) => /reserved for the bot admin/i.test(c.payload?.text || ''))) leaked.push(cmd);
    }
    step('commandes admin refusées à un simple membre', !leaked.length, leaked.join(', '));

    // ---------------------------------------------------------------- 3. tous les boutons
    const clicked = new Set();
    const btnErr = [];
    let clicks = 0;
    let skipped = 0;
    while (seenKb.length && clicks < 400) {
      const b = seenKb.shift();
      if (clicked.has(b.data)) continue;
      clicked.add(b.data);
      if (/^v:(t|b|w|g):/.test(b.data)) { skipped++; continue; } // rendu vidéo (ffmpeg) : trop long pour la boucle
      clicks++;
      const chat = { id: b.chat ?? ADMIN_ID, type: String(b.chat).startsWith('-') ? 'supergroup' : 'private' };
      const { out, err } = await send({ update_id: ++upd, callback_query: { id: `cb${upd}`, chat_instance: 'x', from: { id: ADMIN_ID, is_bot: false, first_name: 'Admin' }, message: { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat, photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }], caption: 'x' }, data: b.data } });
      collectKb(out);
      if (err.length) btnErr.push(`${b.data} : ${err[0].split('\n')[0]}`);
      for (const c of out) {
        const media = c.payload?.media?.media ?? c.payload?.photo;
        const buf = media?.file ?? media?.fileData ?? null;
        if (Buffer.isBuffer(buf) && buf.subarray(1, 4).toString() !== 'PNG') btnErr.push(`${b.data} : image invalide`);
      }
    }
    step(`boutons : ${clicks} cliqués (${skipped} rendus vidéo sautés)`, !btnErr.length && clicks > 20, btnErr.slice(0, 8).join(' | ').slice(0, 900));

    // ---------------------------------------------------------------- 4. pannes
    const { channel } = B;
    store.setMeta('channelLastError', null);
    failGroup = { code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' };
    const dm0 = calls.filter((c) => c.method === 'sendMessage' && c.payload.chat_id === String(ADMIN_ID)).length;
    await channel.sendText('test panne').catch(() => {});
    const dm1 = calls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(ADMIN_ID)).length;
    failGroup = null;
    await new Promise((r) => setImmediate(r));
    const lastErr = store.getMeta('channelLastError');
    step('panne : envoi au groupe refusé → erreur gardée + alerte en privé à l’admin', !!lastErr && /ADMIN/.test(lastErr.text) && dm1 > dm0, lastErr?.text || 'aucune erreur gardée');
    failGroup = { code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100777 }, once: true };
    await channel.sendText('test supergroupe').catch((e) => errors.push(`supergroupe : ${e.message}`));
    const moved = calls.filter((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === '-100777').length;
    step('panne : groupe devenu supergroupe → renvoi automatique au nouvel ID', moved === 1 && cfg.channelId === '-100777', `ID actuel ${cfg.channelId}`);
    cfg.channelId = GROUP_ID;
    store.setMeta('channelMoved', null);
    marketDown = true;
    const e0 = errors.length;
    simNow += 3600;
    await cycle();
    marketDown = false;
    step('panne : données de marché indisponibles → passage sans plantage', errors.length === e0);

    // ---------------------------------------------------------------- copies en privé, diagnostic, Lucid
    const dmCount = () => calls.filter((c) => /^send(Message|Photo)$/.test(c.method) && String(c.payload.chat_id) === String(ADMIN_ID)).length;
    const tradeAt = (sid, price) => {
      simNow += 3600;
      at('nas100', simNow, { type: 'open', sid, tf: '5m', side: 'short', price, stop: price * 0.0045 });
      return cycle();
    };
    cfg.ftmoAi = 'observe';
    const lucidOpen = () => createFtmo({ cfg, store, account: 'lucid' }).load();
    // Pas de groupe configuré → achat copié en privé
    cfg.channelId = '';
    let d0 = dmCount();
    await tradeAt('n_orb5s', 26200); // suivie par le compte FTMO
    const noGroupDm = dmCount() - d0;
    // Groupe en erreur → copie en privé aussi
    cfg.channelId = GROUP_ID;
    failGroup = { code: 400, description: 'Bad Request: chat not found' };
    d0 = dmCount();
    await tradeAt('n_mom10_t05', 26100);
    const errGroupDm = dmCount() - d0;
    failGroup = null;
    step('notifications : sans groupe ou si le groupe refuse, chaque trade est copié en privé à l’admin', noGroupDm > 0 && errGroupDm > 0, `${noGroupDm} copie(s) sans groupe, ${errGroupDm} copie(s) avec groupe en erreur`);
    // Lucid à 0,45 % : signal n_orb5s dont 1 MNQ risque ≈ 237 $ → pris
    const lu = lucidOpen();
    const lucidTook = Object.values(lu.open || {}).some((p) => /_t05$/.test(p.sid)) || [...(lu.closed || [])].some((p) => /_t05$/.test(p.sid));
    step(`Lucid à ${cfg.lucidIntradayRisk} % prend ses signaux Nasdaq intraday « objectif 0,5 R »`, lucidTook, `positions Lucid : ${Object.values(lu.open || {}).map((p) => `${p.sid} ${p.n} ${p.contract}`).join(', ') || 'aucune'} · sautés trop gros : ${lu.tooBig || 0}`);
    const live = require('./src/livePush').buildLive(cfg, store);
    step('diagnostic envoyé au site (version, groupe, erreurs, compteurs Lucid)', !!live.diag?.group && live.diag.group.set && 'lastError' in live.diag.group && !!live.version && !!live.diag.lucid, JSON.stringify({ version: live.version, group: live.diag?.group?.id, lucid: live.diag?.lucid && { tooBig: live.diag.lucid.tooBig } }));

    // ---------------------------------------------------------------- erreurs restantes
    const loggedErr = logged.filter((l) => !/réseau coupé|données indisponibles \(simulé\)|échec du passage : données|chat not found/.test(l)); // pannes provoquées par la boucle
    step('aucune erreur interne pendant la boucle', !errors.length && !loggedErr.length, [...errors, ...loggedErr].slice(0, 6).map((x) => x.split('\n')[0]).join(' | ').slice(0, 900));
  } finally {
    MarketTrader.prototype.run = origRun;
    Date.now = realNow;
    global.fetch = realFetch;
    console.error = origError;
  }

  // ---------------------------------------------------------------- 5. vrai passage (--live)
  if (live) {
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-live-'));
    const lcfg = { ...B.cfg, dataDir: liveDir };
    const { Store } = require('./src/store');
    const lstore = new Store(liveDir);
    const warn = [];
    const ow = console.warn;
    const oe = console.error;
    console.warn = (...a) => warn.push(a.join(' '));
    console.error = (...a) => warn.push(a.join(' '));
    try {
      const out = await require('./src/cycle').runCycle({ cfg: lcfg, store: lstore, channel: { sendText: async () => {}, sendPhoto: async () => {}, summaryDue: () => false, chartDue: () => false, markSummary() {}, markChart() {} }, publish: false });
      const prices = require('./src/markets').activeMarkets(lcfg).map((m) => `${m.id} ${lstore.loadJson(m.file, {}).lastPrice ?? '—'}`);
      const problems = warn.filter((w) => /échec|impossible|indisponible|Error/i.test(w));
      step('passage réel (données Yahoo actuelles, sans publication)', !problems.length, `${out.events} événements · cours : ${prices.join(', ')}${problems.length ? ` · ${problems.slice(0, 4).join(' | ')}` : ''}`);
    } catch (err) {
      step('passage réel (données Yahoo actuelles, sans publication)', false, err.message);
    } finally {
      console.warn = ow;
      console.error = oe;
    }
  }

  const failed = report.filter((r) => !r.ok);
  log(`\n${failed.length ? `❌ ${failed.length} étape(s) en échec sur ${report.length}` : `✅ Tout le bot fonctionne (${report.length} étapes)`} · données de test : ${dir}`);
  return { report, failed, errors, dir };
}

module.exports = { run };

if (require.main === module) {
  run({ live: process.argv.includes('--live') }).then((r) => process.exit(r.failed.length ? 1 : 0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
