/**
 * Jeu du groupe : « Pronostic du jour ».
 * Chaque jour de semaine à GAME_HOUR_UTC, le bot publie une image du cours de l'or et du Nasdaq 100 avec des boutons
 * « Hausse / Baisse ». Les membres votent pendant GAME_VOTE_HOURS heures ; au jour de bourse suivant, même heure,
 * le bot compare les cours, donne 1 point par bonne réponse, publie le résultat et le classement, puis relance un tour.
 * Données gardées dans data/game.json (prénom Telegram et points des joueurs, uniquement sur le serveur du bot).
 */
const { InputFile } = require('grammy');
const { activeMarkets, marketById } = require('./markets');
const C = require('./cards');
const { Canvas, THEME } = require('./draw');
const { esc } = require('./format');

const FILE = 'game.json';
const KM = { gold: 'g', nas100: 'n' };
const MK = { g: 'gold', n: 'nas100' };
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} %`;

/** Prochaine heure de jeu (jour de semaine, GAME_HOUR_UTC) strictement après `t` (ms). */
function nextSlot(t, hour) {
  const d = new Date(t);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  while (d.getTime() <= t || d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function createGame({ cfg, store, api }) {
  const load = () => store.loadJson(FILE, { round: null, scores: {}, rounds: 0 });
  const save = (s) => store.saveJson(FILE, s);
  const markets = () => activeMarkets(cfg);
  const lastPrice = (id) => store.loadJson(marketById(cfg, id).file, {}).lastPrice || null;

  function voteKeyboard(round) {
    if (!round || round.closed) return { inline_keyboard: [] };
    const count = (mk, dir) => Object.values(round.votes[mk] || {}).filter((v) => v === dir).length;
    return {
      inline_keyboard: markets().map((m) => [
        { text: `${m.emoji} ${m.id === 'nas100' ? 'Nasdaq' : m.name} ▲ Hausse (${count(m.id, 'u')})`, callback_data: `g:${round.id}:${KM[m.id]}:u` },
        { text: `▼ Baisse (${count(m.id, 'd')})`, callback_data: `g:${round.id}:${KM[m.id]}:d` },
      ]),
    };
  }

  /** Image d'ouverture : cours des 30 derniers jours de chaque marché. */
  async function openingImage(ms) {
    const cv = new Canvas(1000, 560, THEME.bg);
    cv.text('Pronostic du jour', 28, 20, { style: 'b', size: 28, color: THEME.text });
    cv.text('Hausse ou baisse d’ici le prochain jour de bourse, même heure ? 1 point par bonne réponse.', 28, 58, { size: 15, color: THEME.muted });
    const w = (1000 - 48 - 16 * (ms.length - 1)) / ms.length;
    for (const [i, { market, candles, price }] of ms.entries()) {
      const x = 24 + i * (w + 16);
      cv.roundRect(x, 92, w, 420, 16, THEME.surface);
      cv.text(market.name, x + 18, 106, { style: 'b', size: 22, color: market.id === 'gold' ? THEME.gold : THEME.accent });
      cv.text(price ? money(price) : 'n/d', x + w - 18, 106, { style: 'b', size: 22, color: THEME.text, align: 'right' });
      C.drawCandles(cv, candles.slice(-30), { x: x + 4, y: 146, w: w - 8, h: 356 }, {});
    }
    cv.text('Jeu entre membres · aucun argent en jeu', 976, 526, { size: 13, color: THEME.muted, align: 'right' });
    return cv.png();
  }

  async function open(now) {
    const ms = [];
    for (const market of markets()) {
      const price = lastPrice(market.id);
      if (!price) continue;
      let candles = [];
      try {
        candles = (await market.fetch(['1d'])).series['1d'] || [];
      } catch {
        /* image sans bougies */
      }
      ms.push({ market, candles, price });
    }
    if (!ms.length) return false;
    const s = load();
    const id = (s.rounds || 0) + 1;
    const round = {
      id,
      openedAt: now,
      closesAt: now + cfg.gameVoteHours * 3_600_000,
      resolveAt: nextSlot(now + 60_000, cfg.gameHourUtc),
      prices: Object.fromEntries(ms.map((m) => [m.market.id, m.price])),
      votes: Object.fromEntries(ms.map((m) => [m.market.id, {}])),
      closed: false,
      messageId: null,
    };
    const when = new Date(round.resolveAt).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    const caption = [
      `🎯 <b>Pronostic du jour n° ${id}</b>`,
      ...ms.map((m) => `${m.market.emoji} ${esc(m.market.name)} : ${money(m.price)}`),
      `Votez avec les boutons (${cfg.gameVoteHours} h pour voter, vote modifiable). Résultat ${when} UTC.`,
      '<i>/classement pour voir les points.</i>',
    ].join('\n');
    const msg = await api.sendPhoto(cfg.channelId, new InputFile(await openingImage(ms), 'pronostic.png'), { caption, parse_mode: 'HTML', reply_markup: voteKeyboard(round) });
    round.messageId = msg.message_id;
    s.round = round;
    s.rounds = id;
    s.lastOpenedAt = now;
    save(s);
    console.log(`[jeu] tour ${id} ouvert`);
    return true;
  }

  async function closeVotes(s) {
    s.round.closed = true;
    save(s);
    await api.editMessageReplyMarkup(cfg.channelId, s.round.messageId, { reply_markup: { inline_keyboard: [[{ text: '🔒 Votes clos — résultat au prochain jour de bourse', callback_data: 'g:0:x:x' }]] } }).catch(() => {});
  }

  async function resolve(s, now) {
    const r = s.round;
    const moves = {};
    for (const id of Object.keys(r.prices)) {
      const p = lastPrice(id);
      if (p && r.prices[id]) moves[id] = { from: r.prices[id], to: p, chg: (p / r.prices[id] - 1) * 100 };
    }
    const right = {}; // userId → nombre de bonnes réponses ce tour
    for (const [id, votes] of Object.entries(r.votes)) {
      const mv = moves[id];
      if (!mv) continue;
      const dir = mv.chg > 0 ? 'u' : mv.chg < 0 ? 'd' : null;
      for (const [uid, v] of Object.entries(votes)) {
        const sc = (s.scores[uid] ||= { name: '?', points: 0, played: 0, streak: 0, best: 0 });
        sc.played++;
        if (dir && v === dir) {
          sc.points++;
          right[uid] = (right[uid] || 0) + 1;
        }
      }
    }
    // Série : au moins une bonne réponse à chaque tour joué
    const players = new Set(Object.values(r.votes).flatMap((v) => Object.keys(v)));
    for (const uid of players) {
      const sc = s.scores[uid];
      sc.streak = right[uid] ? sc.streak + 1 : 0;
      sc.best = Math.max(sc.best, sc.streak);
    }
    s.round = null;
    s.last = { id: r.id, moves, players: players.size, winners: Object.keys(right).length, at: now };
    save(s);

    const verdict = Object.entries(moves).map(([id, mv]) => {
      const m = marketById(cfg, id);
      return `${m.emoji} ${esc(m.name)} : ${money(mv.from)} → ${money(mv.to)} <b>${mv.chg > 0 ? '▲' : mv.chg < 0 ? '▼' : '='} ${pct(mv.chg)}</b>`;
    });
    const winners = [...players].filter((u) => right[u]).map((u) => esc(s.scores[u].name));
    const caption = [
      `🏁 <b>Résultat du pronostic n° ${r.id}</b>`,
      ...verdict,
      players.size ? `${winners.length} joueur${winners.length > 1 ? 's' : ''} sur ${players.size} marque${winners.length > 1 ? 'nt' : ''} des points${winners.length ? ` : ${winners.slice(0, 12).join(', ')}` : ''}.` : 'Personne n’a voté.',
    ].join('\n');
    const png = scoreboardImage(s, `Tour n° ${r.id} : ${Object.entries(moves).map(([id, mv]) => `${marketById(cfg, id).name} ${mv.chg > 0 ? '▲' : '▼'} ${pct(mv.chg)}`).join(' · ')}`);
    await api.sendPhoto(cfg.channelId, new InputFile(png, 'resultat.png'), { caption: caption.slice(0, 1024), parse_mode: 'HTML', reply_parameters: { message_id: r.messageId, allow_sending_without_reply: true } });
    console.log(`[jeu] tour ${r.id} résolu : ${players.size} joueurs`);
  }

  /** Classement des joueurs en image. */
  function scoreboardImage(s = load(), subtitle = '') {
    const rows = Object.values(s.scores)
      .sort((a, b) => b.points - a.points || b.best - a.best)
      .slice(0, 15)
      .map((p) => ({ label: p.name, value: p.points, text: `${p.points} pt${p.points > 1 ? 's' : ''}`, badge: `${p.played} joué${p.played > 1 ? 's' : ''}${p.streak >= 2 ? ` · série ${p.streak}` : ''}` }));
    if (!rows.length) rows.push({ label: 'Personne n’a encore joué', value: 0, text: '0 pt' });
    return C.rankingImage({ title: 'Classement du pronostic', subtitle: subtitle || `${s.rounds || 0} tour${(s.rounds || 0) > 1 ? 's' : ''} joué${(s.rounds || 0) > 1 ? 's' : ''} · 1 point par bonne réponse`, rows });
  }

  /** Appelé à chaque passage du bot. */
  async function tick(now = Date.now()) {
    if (!cfg.gameEnabled || !cfg.channelId) return;
    const s = load();
    try {
      if (s.round && !s.round.closed && now >= s.round.closesAt) await closeVotes(s);
      if (s.round && now >= s.round.resolveAt) await resolve(s, now);
      const cur = load();
      // Ouvre le tour du jour à l'heure prévue (au plus 2 h de retard, pour ne pas ouvrir au milieu de la nuit)
      const due = nextSlot(now - 2 * 3_600_000, cfg.gameHourUtc);
      if (!cur.round && due <= now && (cur.lastOpenedAt || 0) < due) await open(now);
    } catch (err) {
      console.warn('[jeu]', err.description || err.message);
    }
  }

  /** Bouton de vote. */
  async function onVote(ctx, parts) {
    const [, rid, mk, dir] = parts;
    const s = load();
    const r = s.round;
    if (mk === 'x' || !r || String(r.id) !== rid) return ctx.answerCallbackQuery({ text: 'Ce tour est terminé.' }).catch(() => {});
    if (r.closed || Date.now() >= r.closesAt) return ctx.answerCallbackQuery({ text: '🔒 Les votes sont clos pour ce tour.' }).catch(() => {});
    const marketId = MK[mk];
    if (!r.votes[marketId] || !['u', 'd'].includes(dir)) return ctx.answerCallbackQuery().catch(() => {});
    const uid = String(ctx.from.id);
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').slice(0, 40) || ctx.from.username || 'Joueur';
    const sc = (s.scores[uid] ||= { name, points: 0, played: 0, streak: 0, best: 0 });
    sc.name = name;
    const before = r.votes[marketId][uid];
    r.votes[marketId][uid] = dir;
    save(s);
    const m = marketById(cfg, marketId);
    await ctx.answerCallbackQuery({ text: `${before && before !== dir ? 'Vote modifié' : 'Vote enregistré'} : ${m.name} en ${dir === 'u' ? 'hausse ▲' : 'baisse ▼'}` }).catch(() => {});
    if (before !== dir) await ctx.editMessageReplyMarkup({ reply_markup: voteKeyboard(r) }).catch(() => {});
  }

  /** Message texte du jeu (commande /jeu). */
  function status() {
    const s = load();
    const r = s.round;
    if (!cfg.gameEnabled) return 'Le jeu est désactivé (GAME=0 dans le .env).';
    const lines = ['🎯 <b>Pronostic du jour</b>', `Chaque jour de semaine à ${cfg.gameHourUtc} h UTC : hausse ou baisse de l’or et du Nasdaq d’ici le jour de bourse suivant. 1 point par bonne réponse.`];
    if (r) {
      const n = new Set(Object.values(r.votes).flatMap((v) => Object.keys(v))).size;
      lines.push('', `Tour n° ${r.id} ${r.closed ? '(votes clos)' : 'en cours'} · ${n} joueur${n > 1 ? 's' : ''} · résultat le ${new Date(r.resolveAt).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`);
    } else lines.push('', `Prochain tour : ${new Date(nextSlot(Date.now(), cfg.gameHourUtc)).toLocaleString('fr-FR', { weekday: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC.`);
    return lines.join('\n');
  }

  return { tick, onVote, scoreboardImage, status, open, resolve: () => resolve(load(), Date.now()), voteKeyboard, load };
}

module.exports = { createGame, nextSlot };
