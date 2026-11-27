/**
 * Boutons sous les messages du groupe (claviers « inline » Telegram) et images à la demande.
 *
 *  - Panneau (/menu, graphique quotidien) : une image dont le contenu change quand on appuie sur les boutons
 *    (portefeuille, classement, positions, cours, historique, fiches des stratégies). Tout le groupe peut l'utiliser.
 *  - Sous chaque ouverture / clôture : carte du trade, cours avec entrée / stop / objectif, fiche de la stratégie.
 *  - Sous le bilan : accès direct aux images.
 *
 * Données des boutons (≤ 64 octets) :
 *   m:<vue>:<marché>[:arg[:arg]]   vue du panneau (h portefeuille, r classement, o positions, c cours, y historique des trades,
 *                                  z trades du compte FTMO, f compte FTMO,
 *                                  l liste des stratégies, s fiche, t test d'une stratégie sur l'historique)
 *   x:<action>:<marché>:<id>:<t>   bouton sous un trade (k carte, c cours, s fiche)
 */
const { InputFile } = require('grammy');
const { MarketTrader, marketById, activeMarkets } = require('./markets');
const { selectStrategies } = require('./strategies');
const { liveChart, historyChart, colorize } = require('./portfolio');
const C = require('./cards');
const { esc } = require('./format');
const VERDICT_EN = require('./verdicts.en.json'); // notes du banc d'essai en anglais (stratégies actives)

const MK = { g: 'gold', n: 'nas100', e: 'eurusd', p: 'spx' };
const KM = { gold: 'g', nas100: 'n', eurusd: 'e', spx: 'p' };
const YEARS = { gold: [2001, 2010, 2016, 2021], nas100: [1990, 2000, 2010, 2020], eurusd: [2004, 2010, 2016, 2021], spx: [1990, 2000, 2010, 2020] };
const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
/** Cours : 4 décimales sous 10 (EUR/USD), entier au-delà de 1 000, 2 décimales sinon. */
const quote = (v) => (Math.abs(v) < 10 ? `$${v.toFixed(4)}` : Math.abs(v) >= 1000 ? money(v) : `$${v.toFixed(2)}`);
const pct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;
const signedMoney = (v) => `${v >= 0 ? '+' : '−'}${money(Math.abs(v || 0))}`;
const MARKET_EMOJI = { gold: '🥇', nas100: '🇺🇸', eurusd: '💶', spx: '🗽', silver: '🥈', dow: '🏭', russell: '🐎' };
/** Stratégies suivies : noms si la ligne reste courte, sinon nombre par marché. */
function strategiesLine(list) {
  const full = `Strategies followed: ${list.map((x) => `${MARKET_EMOJI[x.split(':')[0]] || ''}<code>${esc(x.split(':')[1])}</code>`).join(', ')}`;
  if (full.length <= 380) return full;
  const by = {};
  for (const x of list) by[x.split(':')[0]] = (by[x.split(':')[0]] || 0) + 1;
  return `Strategies followed: ${list.length} (${Object.entries(by).map(([m, n]) => `${MARKET_EMOJI[m] || m} ${n}`).join(' · ')}) — list in /strategies`;
}

/**
 * Légende Telegram (1 024 caractères au plus) construite ligne par ligne : une ligne n'est ajoutée que si elle tient
 * en entier (jamais de balise HTML ou d'emoji coupé, ce que Telegram refuse).
 */
/** Ligne « Time Machine » (chances du compte en cours) ; rien si la simulation échoue. */
function timeMachineLine(cfg, store, accountId) {
  if (!cfg.timeMachine) return [];
  try {
    return [require('./timeMachine').line(require('./timeMachine').cached(cfg, store, accountId))];
  } catch (err) {
    console.warn('[time machine]', err.message);
    return [];
  }
}

/** Retraits simulés du compte financé (et règle du prochain retrait). */
function payoutText(s, P, isLucid) {
  const f = s.funded || {};
  const n = f.payouts?.length || 0;
  const done = n ? `${n} simulated payout(s), ${money(f.traderPaid || 0)} for you` : 'no payout yet';
  const next = isLucid
    ? `next after ${Math.max(0, (P.payout?.cycleDays || 5) - (f.good || 0))} winning day(s) ≥ ${money(P.payout?.minDay || 150)} (50% of the gain, ${money(P.payout?.cap || 2000)} max)`
    : 'the whole gain every 14 days (80% for you)';
  return `💸 ${done} · ${next}`;
}

function fitCaption(lines, max = 1024) {
  const out = [];
  let len = 0;
  for (const l of lines.filter((x) => x !== undefined && x !== null && x !== '')) {
    const add = (out.length ? 1 : 0) + l.length;
    if (len + add > max) continue;
    out.push(l);
    len += add;
  }
  return out.join('\n');
}

/** Bilan de l'IA validatrice sur les trades clôturés du compte FTMO (validés / qu'elle aurait refusés). */
function aiText(cfg, s) {
  if (!cfg.ftmoAi || cfg.ftmoAi === 'off') return [];
  const judged = (s.closed || []).filter((t) => t.ai);
  const mode = cfg.ftmoAi === 'block' ? 'blocks signals below the threshold' : 'observe only, blocks nothing';
  if (!judged.length) return [`🤖 Validator AI (${mode}): no judged trade closed yet${s.aiRefused ? ` · ${s.aiRefused} signal(s) refused` : ''}`];
  const part = (l) => `${l.length} trade(s), ${signedMoney(l.reduce((a, t) => a + t.pnl, 0))}, ${l.length ? Math.round((l.filter((t) => t.pnl > 0).length / l.length) * 100) : 0}% winners`;
  const ok = judged.filter((t) => t.ai.ok);
  const no = judged.filter((t) => !t.ai.ok);
  return [`🤖 Validator AI (${mode}): approved ${part(ok)} · ${cfg.ftmoAi === 'block' ? 'below threshold' : 'would have refused'} ${part(no)}${s.aiRefused ? ` · ${s.aiRefused} signal(s) refused` : ''}`];
}

/** Une ligne : ce qu'auraient fait les signaux refusés par l'IA (rep = refusedReport()). */
function refusedLine(rep) {
  if (!rep.n) return '';
  const verdict = rep.closed ? (rep.closedPnl <= 0 ? '✅ the AI was right' : '⚠️ they would have won') : '';
  return `🤖 Refused by the AI: ${rep.n} signal(s)${rep.closed ? ` · closed ${rep.closed}: would have made <b>${signedMoney(rep.closedPnl)}</b> (${rep.wins} winner(s)) ${verdict}` : ''}${rep.open ? ` · still open ${rep.open}: ${signedMoney(rep.openPnl)} unrealized` : ''}`;
}

/** Réduction du risque à l'approche de l'objectif (FTMO_SIZING « objectif : … »), pour la légende du compte FTMO. */
function protectText(cfg, s, targetPct = null) {
  if (!String(cfg.ftmoSizing).startsWith('objectif')) return '';
  const { RULES } = require('./sizing');
  const { TARGET } = require('./ftmoAccount');
  const mul = (RULES[cfg.ftmoSizing] || (() => 1))({}, { balance: s.balance, capital: s.capital, dayStart: s.dayStart, target: targetPct ?? TARGET[s.phase] ?? Infinity, open: 0 });
  return mul < 0.999 ? ` · <b>reduced × ${mul.toFixed(2)}</b> (gain close to the target)` : ' · lowered when nearing the target';
}

/** Risque par trade du compte FTMO : journalières / intraday (stratégies factices pour interroger riskOf). */
function riskText(cfg, acct, phase) {
  if (!acct.riskOf) return `${acct.risk}%`;
  const daily = [...new Set(['gold', 'nas100', 'spx', 'eurusd', 'silver', 'dow', 'russell', ...require('./stocks').STOCK_IDS].filter((m) => acct.strategies.some((x) => x.startsWith(`${m}:`))).map((m) => acct.riskOf(m, { tf: '1d' })))];
  // Risque intraday : celui d'une stratégie intraday que le compte prend vraiment
  const intraSid = acct.strategies.find((x) => { const s = selectStrategies([x.split(':')[1]])[0]; return s && s.tf && s.tf !== '1d' && acct.riskOf(x.split(':')[0], s, phase) > 0; });
  const r = (x) => Math.round(x * 1000) / 1000;
  const intra = intraSid ? r(acct.riskOf(intraSid.split(':')[0], selectStrategies([intraSid.split(':')[1]])[0], phase)) : 0;
  const boost = acct.id === 'lucid' && phase !== 'funded' && (cfg.lucidEvalIntradayMul ?? 1) !== 1 ? ` during the evaluation, ${r(cfg.lucidIntradayRisk)}% once funded` : '';
  const fundedTxt = acct.firm === 'Lucid' && phase === 'funded' && (cfg.lucidFundedRiskMulAfter ?? cfg.lucidFundedRiskMul) !== cfg.lucidFundedRiskMul
    ? ` · funded: × ${cfg.lucidFundedRiskMul} until the 1st payout, then × ${cfg.lucidFundedRiskMulAfter} (capped by the contract limit)` : '';
  return `${daily.join(' / ')}% (daily)${intra > 0 ? ` · ${intra}% (intraday${boost})` : ''}${fundedTxt}`;
}
const PAGE = 6;

/* ------------------------------------------------------------------ */
/* Claviers                                                            */
/* ------------------------------------------------------------------ */

const btn = (text, data) => ({ text, callback_data: data.slice(0, 64) });

/** Clavier du panneau : choix du marché, vues principales, puis rangées propres à la vue. */
function panelKeyboard(cfg, view, marketId, extra = []) {
  const k = KM[marketId];
  const markets = activeMarkets(cfg);
  const rows = [];
  if (markets.length > 1) {
    rows.push(markets.map((m) => btn(`${m.id === marketId ? '• ' : ''}${m.emoji} ${m.id === 'nas100' ? 'Nasdaq' : m.name}`, `m:${view === 's' || view === 't' ? 'h' : view}:${KM[m.id]}`)));
  }
  rows.push([btn('📈 Portfolio', `m:h:${k}`), btn('🏆 Ranking', `m:r:${k}`), btn('📍 Positions', `m:o:${k}`)]);
  rows.push([btn('🕯 Chart', `m:c:${k}:1d`), btn('🕰 History', `m:y:${k}`), btn('📚 Strategies', `m:l:${k}:0`)]);
  if (cfg.ftmoEnabled) {
    rows.push(cfg.ftmoCombined ? [btn('🏦 FTMO account', 'm:f:g'), btn('🧾 FTMO trades', 'm:z:g:0')]
      : [btn('🏦 FTMO 🇺🇸 Nasdaq', 'm:f:n'), btn('🏦 FTMO 🥇 Gold', 'm:f:g')].filter((b) => b.callback_data !== 'm:f:n' || cfg.ftmoNasEnabled));
  }
  return { inline_keyboard: [...extra, ...rows] };
}

/** Boutons sous une ouverture / clôture publiée sur le canal. */
function tradeKeyboard(ev) {
  const k = KM[ev.market.id];
  const t = ev.type === 'open' ? ev.pos.entryT : ev.trade.entryT;
  const id = ev.strategy.id;
  return {
    inline_keyboard: [
      [btn(ev.type === 'open' ? '🧾 Trade card' : '🧾 Result card', `x:k:${k}:${id}:${t}`), btn('🕯 Chart + levels', `x:c:${k}:${id}:${t}`)],
      [btn('ℹ️ The strategy', `x:s:${k}:${id}:${t}`), btn('🎛 Menu', `m:h:${k}`)],
    ],
  };
}

/** Boutons sous le bilan d'un marché. */
function summaryKeyboard(marketId) {
  const k = KM[marketId];
  return {
    inline_keyboard: [
      [btn('📈 Graphique', `m:h:${k}`), btn('🏆 Classement', `m:r:${k}`), btn('📍 Positions', `m:o:${k}`)],
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Données                                                             */
/* ------------------------------------------------------------------ */

const candleCache = new Map();
/** Bougies d'un marché (1d ou 1h), en cache 2 min. */
async function candles(market, tf) {
  const key = `${market.id}:${tf}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.data;
  const data = await market.fetch([tf]);
  const out = { list: data.series[tf] || [], price: data.price };
  if (out.list.length) candleCache.set(key, { at: Date.now(), data: out });
  return out;
}

function trader(cfg, store, marketId) {
  return new MarketTrader(marketById(cfg, marketId), store, cfg);
}

/** Retrouve un trade (position ouverte ou clôturée) d'une stratégie par sa date d'entrée. */
function findTrade(tr, id, entryT) {
  const acc = tr.state.accounts[id];
  if (!acc) return null;
  if (acc.position && Math.abs(acc.position.entryT - entryT) < 2) return { pos: acc.position };
  const trade = [...acc.closed].reverse().find((t) => Math.abs(t.entryT - entryT) < 2);
  return trade ? { trade } : null;
}

const TRADES_PAGE = 10;
/** Page d'une liste de trades clôturés (plus récents d'abord) : lignes, pagination, résumé. */
function tradePage(all, askedPage, cb, unit = '') {
  const pages = Math.max(1, Math.ceil(all.length / TRADES_PAGE));
  const page = Math.min(Math.max(askedPage, 0), pages - 1);
  const rows = all.slice(page * TRADES_PAGE, page * TRADES_PAGE + TRADES_PAGE);
  const extra = [];
  if (pages > 1) extra.push([btn('◀️ Newer', cb(Math.max(0, page - 1))), btn(`${page + 1} / ${pages}`, cb(page)), btn('Older ▶️', cb(Math.min(pages - 1, page + 1)))]);
  const wins = all.filter((t) => t.pnlUsd > 0).length;
  const total = all.reduce((s, t) => s + (t.pnlUsd || 0), 0);
  const best = all.reduce((b, t) => (!b || t.pnlPct > b.pnlPct ? t : b), null);
  const worst = all.reduce((w, t) => (!w || t.pnlPct < w.pnlPct ? t : w), null);
  const caption = all.length
    ? [`${all.length} trades · ${Math.round((wins / all.length) * 100)}% winners · total <b>${total >= 0 ? '+' : '−'}${money(Math.abs(total))}</b>`,
      `Best: ${esc(best.name)} ${pct(best.pnlPct)}${unit ? ` ${unit}` : ''} · worst: ${esc(worst.name)} ${pct(worst.pnlPct)}${unit ? ` ${unit}` : ''}`].join('\n')
    : 'No closed trade yet.';
  return { rows, page, pages, extra, caption };
}

/* ------------------------------------------------------------------ */
/* Vues (image + légende + clavier)                                     */
/* ------------------------------------------------------------------ */

let heavy = Promise.resolve();
/** Calculs lourds (simulation sur l'historique) : un à la fois. */
function queued(fn) {
  const p = heavy.catch(() => {}).then(fn);
  heavy = p;
  return p;
}

async function render(cfg, store, view, marketId, args = []) {
  const market = marketById(cfg, marketId);
  if (!market || !market.enabled) throw new Error('inactive market');
  const tr = trader(cfg, store, marketId);
  const st = tr.stats();
  const head = `${market.emoji} <b>${esc(market.name)}</b>`;

  if (view === 'f') {
    const { createFtmo } = require('./ftmoAccount');
    const prices = Object.fromEntries(activeMarkets(cfg).map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
    const isLucid = ['l', 'l2', 'l3', 'lf'].includes(args[0]);
    const lucidId = { l2: 'lucid2', l3: 'lucid3', lf: 'lucidf' }[args[0]] || 'lucid';
    const acct = require('./ftmoAccount').accountOf(cfg, isLucid ? lucidId : marketId);
    const fobj = createFtmo({ cfg, store, account: isLucid ? lucidId : acct.enabled ? marketId : 'gold' });
    const fst = fobj.status(prices);
    const s = fst.s;
    const rep = cfg.ftmoAi === 'block' ? fobj.refusedReport(prices) : { n: 0 };
    const sfx = isLucid ? `:${args[0]}` : '';
    const lucid2On = require('./ftmoAccount').accountOf(cfg, 'lucid2').enabled;
    const lucidOn = require('./ftmoAccount').accountOf(cfg, 'lucid').enabled;
    const lucid3On = require('./ftmoAccount').accountOf(cfg, 'lucid3').enabled;
    const P = fst.program || {};
    const lines = [
      isLucid
        ? `🟣 <b>Simulated Lucid account · ${fst.account.label}</b> · ${s.phase === 'funded' ? 'funded account' : 'evaluation'} #${s.attempt}`
        : `🏦 <b>Simulated FTMO account ${fst.account.emoji} ${fst.account.label}</b> · ${s.phase === 'funded' ? 'funded account' : fst.program?.steps === 1 ? '1-step challenge' : `step ${s.phase} of 2`} · challenge #${s.attempt}`,
      ...(isLucid && s.phase === 'funded' ? [`Funded rules: no consistency rule, no daily loss limit, max loss ${money(P.maxUsd)} trailing at end of day, locked at ${money(s.capital + (P.lockAt || 0))} once the balance passes ${money(s.capital + P.maxUsd + (P.lockAt || 0))} or from the 1st payout (current floor ${money(fst.floor)}); contracts by profit (scaling plan): ${(P.scaling || []).map(([f, n]) => `${n} micros from ${money(f)}`).join(', ')} — now ${fst.maxContracts}; payouts: ${P.payout?.cycleDays || 5} winning days ≥ ${money(P.payout?.minDay || 150)}, ≤ 50% of the profit up to ${money(P.payout?.cap || 2000)}, ${money(P.payout?.min || 500)} min, ${P.payout?.max || 5} max`]
        : isLucid ? [`Rules: +${P.target}%, best day ≤ ${P.bestDay}% of the gain (evaluation), no daily loss limit, max loss ${money(P.maxUsd)} below the highest closing balance (current floor ${money(fst.floor)}), micro futures in whole contracts (${P.maxContracts} max), never long and short at the same time`] : []),
      ...(s.phase === 'funded' ? [payoutText(s, P, isLucid)] : []),
      ...(cfg.fillDelaySec > 0 ? [`⏱ Execution ${cfg.fillDelaySec} s after the signal (price at that moment); stops at their level${s.missed ? ` · ${s.missed} signal(s) missed (stop crossed during the delay)` : ''}`] : []),
      ...(isLucid && s.tooBig ? [`⚠️ ${s.tooBig} signal(s) skipped, too big for this account (a single micro contract would risk over 40% of the max loss): ${Object.entries(s.tooBigBy || {}).slice(0, 6).map(([k, v]) => `<code>${esc(k)}</code> ${money(v)}`).join(', ')} — these strategies stay on the FTMO account`] : []),
      `Value <b>${money(fst.equity)}</b> (${pct((fst.equity / s.capital - 1) * 100)})${fst.target ? ` · target ${money(fst.target)}` : ''}`,
      `incl. ${signedMoney(fst.unrealized)} unrealized on ${Object.keys(s.open).length} open position(s) · realized ${signedMoney(fst.realized)} on ${s.closed.length} closed trade(s)${s.skipped ? ` · ${s.skipped} opposite signal(s) ignored` : ''}${s.skippedCross ? ` · ${s.skippedCross} signal(s) skipped (opposite position on another Lucid account)` : ''}`,
      strategiesLine(fst.account.strategies),
      `Risk per trade: ${riskText(cfg, fst.account, s.phase)}${protectText(cfg, s, fst.needed ? ((fst.needed / s.capital) * 100) : fst.targetPct)}`,
      ...(fst.target && fst.needed > fst.target - s.capital + 1 ? [`📏 Best-day rule (≤ ${P.bestDay}% of the gain): your best day is ${money(fst.bestDay)} → you need <b>${money(fst.needed)}</b> of total gain (${money(Math.max(0, fst.needed - (fst.equity - s.capital)))} to go)${String(cfg.ftmoSizing).startsWith('objectif') ? '; trade size follows this real target' : ''}`] : []),
      ...aiText(cfg, s),
      ...timeMachineLine(cfg, store, isLucid ? lucidId : fst.account.id),
      ...(rep.n ? [refusedLine(rep)] : []),
      ...(cfg.autoAdapt ? [require('./adapt').summary(cfg, store)] : []),
      ...(s.history || []).slice(-3).map((h) => `• ${isLucid ? 'evaluation' : 'challenge'} #${h.attempt}${isLucid ? '' : `, step ${h.phase}`}: ${esc(h.outcome)}${h.why ? ` (${esc(h.why)})` : ''}`),
    ];
    const rows = [[btn(`🧾 Trades ${isLucid ? 'Lucid' : 'FTMO'}`, `m:z:${KM[marketId]}:0${sfx}`), ...(rep.n ? [btn('🤖 Refused by the AI', `m:i:${KM[marketId]}:0${sfx}`)] : [])]];
    if (lucidOn) rows.push([...(isLucid ? [btn('🏦 FTMO account', `m:f:${KM[marketId]}`)] : []), ...(!isLucid || lucidId !== 'lucid' ? [btn(lucid2On ? '🟣 Lucid intraday' : '🟣 Lucid account', `m:f:${KM[marketId]}:l`)] : []),
      ...(lucid2On && lucidId !== 'lucid2' ? [btn('🟣 Lucid daily', `m:f:${KM[marketId]}:l2`)] : []),
      ...(lucid3On && lucidId !== 'lucid3' ? [btn('🟣 Lucid combined', `m:f:${KM[marketId]}:l3`)] : []),
      ...(isLucid && lucidId !== 'lucidf' && !require('./ftmoAccount').createFtmo({ cfg, store, account: 'lucidf' }).asleep() ? [btn('🟣 Lucid funded', `m:f:${KM[marketId]}:lf`)] : [])]);
    if (cfg.siteUrl) rows.push([{ text: '🖥 Live interface', url: `${cfg.siteUrl}/#bot` }]);
    return { png: C.ftmoImage(fst), caption: fitCaption(lines), keyboard: panelKeyboard(cfg, 'f', marketId, rows) };
  }

  if (view === 'h') {
    const { png } = liveChart(store, cfg, marketId);
    const strat = st.rows.filter((r) => r.strategy.id !== 'hold');
    const total = strat.reduce((s, r) => s + r.equity, 0);
    const best = [...strat].sort((a, b) => b.returnPct - a.returnPct)[0];
    const caption = [
      `${head} · portfolio <b>${money(total)}</b> (${pct((total / (market.startCapital * strat.length) - 1) * 100)})`,
      best ? `Leading: ${esc(best.strategy.name)} (${pct(best.returnPct)})` : '',
      '<i>Paper trading, fake money. Tap the buttons to switch views.</i>',
    ].filter(Boolean).join('\n');
    return { png, caption, keyboard: panelKeyboard(cfg, 'h', marketId) };
  }

  if (view === 'r') {
    const colors = colorize(st.rows.map((r) => r.strategy));
    const rows = st.rows.map((r, k) => ({ r, color: colors[k] })).sort((a, b) => b.r.returnPct - a.r.returnPct)
      .map(({ r, color }) => ({ label: r.strategy.name, value: r.returnPct, text: pct(r.returnPct), rgb: color.rgb, badge: r.position ? (r.position.side === 'long' ? '▲' : '▼') : '' }));
    const png = C.rankingImage({ market, title: 'Strategy ranking', subtitle: `Value of each account since launch · gains reinvested · ▲ = in a position`, rows, minScale: 5 });
    const top = rows.slice(0, 3).map((r, i) => `${['🥇', '🥈', '🥉'][i]} ${esc(r.label)} ${r.text}`).join('\n');
    return { png, caption: `${head} · 🏆 ranking\n${top}`, keyboard: panelKeyboard(cfg, 'r', marketId) };
  }

  if (view === 'o') {
    const open = st.rows.filter((r) => r.position);
    const png = C.positionsImage({ market, rows: open, price: st.price });
    return { png, caption: `${head} · 📍 ${open.length} open position${open.length > 1 ? 's' : ''} · price ${st.price ? quote(st.price) : 'n/a'}`, keyboard: panelKeyboard(cfg, 'o', marketId) };
  }

  if (view === 'c') {
    const tf = args[0] === '1h' ? '1h' : '1d';
    const { list, price } = await candles(market, tf);
    const shown = list.slice(tf === '1d' ? -120 : -96);
    const last = shown[shown.length - 1];
    const first = shown[0];
    const chg = last && first ? (last.c / first.c - 1) * 100 : 0;
    const png = C.priceChartImage({
      market,
      candles: shown,
      title: `${market.name} · ${price ? quote(price) : ''}`,
      subtitle: `${tf === '1d' ? '1-day candles · last 120 days' : '1-hour candles · last 4 days'} · ${pct(chg)} over the period`,
      levels: price ? [{ price, label: 'Price', rgb: [124, 196, 255] }] : [],
    });
    const extra = [[btn(`${tf === '1d' ? '• ' : ''}1-day candles`, `m:c:${KM[marketId]}:1d`), btn(`${tf === '1h' ? '• ' : ''}1-hour candles`, `m:c:${KM[marketId]}:1h`)]];
    return { png, caption: `${head} · 🕯 price ${price ? `<b>${quote(price)}</b>` : 'n/a'} (${pct(chg)} over the period)`, keyboard: panelKeyboard(cfg, 'c', marketId, extra) };
  }

  if (view === 'y') {
    // Historique des trades RÉELLEMENT pris par le bot sur ce marché (paper trading en direct), du plus récent au plus ancien
    const names = Object.fromEntries(st.rows.map((r) => [r.strategy.id, r.strategy.name]));
    const all = Object.entries(tr.state.accounts || {})
      .filter(([id]) => id !== 'hold')
      .flatMap(([id, acc]) => (acc.closed || []).map((t) => ({ ...t, sid: id, name: names[id] || id })))
      .sort((a, b) => b.exitT - a.exitT);
    const { rows, page, pages, extra, caption } = tradePage(all, Number(args[0]) || 0, (p) => `m:y:${KM[marketId]}:${p}`);
    // Un bouton par trade de la page : carte du trade (même carte que sous les messages de trade)
    const btns = rows.map((t) => btn(`🧾 ${t.sid} ${pct(t.pnlPct)}`, `x:k:${KM[marketId]}:${t.sid}:${t.entryT}`));
    const tradeRows = [];
    for (let i = 0; i < btns.length; i += 2) tradeRows.push(btns.slice(i, i + 2));
    const png = C.tradesImage({ market, title: 'Trade history', subtitle: `${all.length} closed trades · page ${page + 1} / ${pages} · live paper trading, fees included`, rows });
    return { png, caption: `${head} · 🕰 trade history\n${caption}`, keyboard: panelKeyboard(cfg, 'y', marketId, [...tradeRows, ...extra]) };
  }

  if (view === 'z') {
    // Trades du compte FTMO simulé
    const { createFtmo } = require('./ftmoAccount');
    const isLucid = ['l', 'l2', 'l3', 'lf'].includes(args[1]);
    const lucidId = { l2: 'lucid2', l3: 'lucid3', lf: 'lucidf' }[args[1]] || 'lucid';
    const sfx = isLucid ? `:${args[1]}` : '';
    const acct = require('./ftmoAccount').accountOf(cfg, marketId);
    const s = createFtmo({ cfg, store, account: isLucid ? lucidId : acct.enabled ? marketId : 'gold' }).load();
    const all = [...(s.closed || [])].map((t) => ({ ...t, name: `${MARKET_EMOJI[t.market] || ''} ${t.sid}`, pnlUsd: t.pnl, pnlPct: (t.pnl / s.capital) * 100 })).sort((a, b) => b.exitT - a.exitT);
    const { rows, page, pages, extra, caption } = tradePage(all, Number(args[0]) || 0, (p) => `m:z:${KM[marketId]}:${p}${sfx}`, 'of account');
    const hist = (s.history || []).slice(-3).map((h) => `• challenge n° ${h.attempt} : ${esc(h.outcome)}${h.why ? ` (${esc(h.why)})` : ''}`);
    const firm = isLucid ? 'Lucid' : 'FTMO';
    const png = C.tradesImage({ market: null, title: `${firm} account trades · ${isLucid ? 'evaluation' : 'challenge'} #${s.attempt}`, subtitle: `${all.length} trades closed since the start · page ${page + 1} / ${pages} · result in % of the account`, rows, footerText: `Simulation · ${firm} account · fake money · not financial advice` });
    extra.push([btn(`⬅️ ${firm} account`, `m:f:${KM[marketId]}${sfx}`)]);
    return { png, caption: fitCaption([`${isLucid ? '🟣' : '🏦'} <b>Simulated ${firm} account</b> · 🧾 trades`, caption, ...hist]), keyboard: panelKeyboard(cfg, 'z', marketId, extra) };
  }

  if (view === 'i') {
    // Signaux refusés par l'IA validatrice : ce qu'ils auraient fait sur le compte FTMO
    const { createFtmo } = require('./ftmoAccount');
    const isLucid = ['l', 'l2', 'l3', 'lf'].includes(args[1]);
    const lucidId = { l2: 'lucid2', l3: 'lucid3', lf: 'lucidf' }[args[1]] || 'lucid';
    const sfx = isLucid ? `:${args[1]}` : '';
    const acct = require('./ftmoAccount').accountOf(cfg, marketId);
    const f = createFtmo({ cfg, store, account: isLucid ? lucidId : acct.enabled ? marketId : 'gold' });
    const s = f.load();
    const prices = Object.fromEntries(activeMarkets(cfg).map((m) => [m.id, store.loadJson(m.file, {}).lastPrice || null]));
    const rep = f.refusedReport(prices);
    const now = Math.floor(Date.now() / 1000);
    const all = rep.rows.filter((r) => r.state !== 'unknown').map((r) => ({
      ...r, name: `${MARKET_EMOJI[r.market] || ''} ${r.sid}`, pnlUsd: r.pnl, pnlPct: (r.pnl / s.capital) * 100,
      exitT: r.exitT ?? now, exit: r.exit ?? prices[r.market] ?? r.entry, reason: `${r.state === 'open' ? 'still open · ' : ''}AI ${Math.round(r.ai.p * 100)}% (threshold ${Math.round(r.ai.min * 100)}%)`,
    })).sort((a, b) => b.entryT - a.entryT);
    const { rows, page, pages, extra } = tradePage(all, Number(args[0]) || 0, (p) => `m:i:${KM[marketId]}:${p}${sfx}`, 'of account');
    const png = C.tradesImage({ market: null, title: 'Signals refused by the AI', subtitle: `What they would have made on the FTMO account · ${all.length} signals · page ${page + 1} / ${pages}`, rows, footerText: 'Simulation · fake money · not financial advice' });
    extra.push([btn(`⬅️ ${isLucid ? 'Lucid' : 'FTMO'} account`, `m:f:${KM[marketId]}${sfx}`)]);
    return { png, caption: fitCaption([`${isLucid ? '🟣' : '🏦'} <b>Simulated ${isLucid ? 'Lucid' : 'FTMO'} account</b> · 🤖 signals refused by the AI`, refusedLine(rep) || 'No refused signal yet.']), keyboard: panelKeyboard(cfg, 'i', marketId, extra) };
  }

  if (view === 't') {
    const id = args[0];
    const year = Number(args[1]) || (marketId === 'nas100' ? 2010 : 2021);
    const out = await queued(() => historyChart(cfg, { marketId, fromYear: year, ids: [id, 'hold'] }));
    const lines = out.results.slice(0, 6).map(({ s, stats }) => `${esc(s.name)}: <b>${pct(stats.perYear)}/yr</b>`);
    const yearsRow = YEARS[marketId].map((y) => btn(`${y === year ? '• ' : ''}${y}`, `m:t:${KM[marketId]}:${id}:${y}`));
    const extra = [yearsRow, [btn('⬅️ Back to the card', `m:s:${KM[marketId]}:${id}`)]];
    return {
      png: out.png,
      caption: `${head} · 🧪 backtest since ${year} (simulation, gains reinvested, fees included)\n${lines.join('\n')}\n<i>Past results ≠ future results.</i>`.slice(0, 1024),
      keyboard: panelKeyboard(cfg, view, marketId, extra),
    };
  }

  if (view === 'l') {
    const list = selectStrategies(market.strategies);
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const page = Math.min(Math.max(Number(args[0]) || 0, 0), pages - 1);
    const colors = colorize(st.rows.map((r) => r.strategy));
    const rows = st.rows.map((r, k) => ({ label: r.strategy.name, value: r.returnPct, text: pct(r.returnPct), rgb: colors[k].rgb }));
    const png = C.rankingImage({ market, title: `${list.length} active strategies`, subtitle: 'Tap a strategy to see its card', rows, minScale: 5 });
    const items = list.slice(page * PAGE, page * PAGE + PAGE).map((s) => btn(s.name.length > 30 ? `${s.name.slice(0, 29)}…` : s.name, `m:s:${KM[marketId]}:${s.id}`));
    const extra = [];
    for (let i = 0; i < items.length; i += 2) extra.push(items.slice(i, i + 2));
    if (pages > 1) extra.push([btn('◀️', `m:l:${KM[marketId]}:${(page - 1 + pages) % pages}`), btn(`Page ${page + 1} / ${pages}`, `m:l:${KM[marketId]}:${page}`), btn('▶️', `m:l:${KM[marketId]}:${(page + 1) % pages}`)]);
    return { png, caption: `${head} · 📚 active strategies (page ${page + 1} / ${pages})`, keyboard: panelKeyboard(cfg, 'l', marketId, extra) };
  }

  if (view === 's') {
    const id = args[0];
    const row = st.rows.find((r) => r.strategy.id === id);
    if (!row) throw new Error('unknown strategy on this market');
    const colors = colorize(st.rows.map((r) => r.strategy));
    const color = colors[st.rows.indexOf(row)];
    const curve = (tr.curves().find((c) => c.strategy.id === id) || { points: [] }).points;
    const note = VERDICT_EN[id.split('@')[0]] || '';
    const png = C.strategyCardImage({ market, row, curve, note, color: color.rgb });
    const testable = (row.strategy.tf || '1h') === '1d';
    const extra = [[
      ...(testable ? [btn('🕰 Test on history', `m:t:${KM[marketId]}:${id}:${YEARS[marketId][0]}`)] : []),
      btn('⬅️ List', `m:l:${KM[marketId]}:0`),
    ]];
    return {
      png,
      caption: `${head} · ℹ️ <b>${esc(row.strategy.name)}</b>\n${money(row.equity)} (${pct(row.returnPct)}) · ${row.trades} trades${row.position ? ` · in a position (${row.position.side === 'long' ? 'buy' : 'sell'})` : ' · flat'}`,
      keyboard: panelKeyboard(cfg, 's', marketId, extra),
    };
  }
  throw new Error('vue inconnue');
}

/** Images sous un trade : carte, cours + niveaux, fiche. */
async function renderTrade(cfg, store, action, marketId, id, entryT) {
  const market = marketById(cfg, marketId);
  const tr = trader(cfg, store, marketId);
  const strat = selectStrategies(market.strategies).find((s) => s.id === id) || { id, name: id, desc: '' };
  if (action === 's') return render(cfg, store, 's', marketId, [id]);
  const found = findTrade(tr, id, entryT);
  if (!found) throw new Error('trade introuvable (trop ancien ?)');
  const t = found.trade || found.pos;
  const tf = (found.trade ? found.trade.exitT : Date.now() / 1000) - t.entryT > 10 * 86400 ? '1d' : '1h';
  const { list, price } = await candles(market, tf);
  const acc = tr.account(id);
  const head = `${market.emoji} <b>${esc(market.name)} · ${esc(strat.name)}</b>`;
  const keyboard = {
    inline_keyboard: [
      [btn(action === 'k' ? '• 🧾 Card' : '🧾 Card', `x:k:${KM[marketId]}:${id}:${t.entryT}`), btn(action === 'c' ? '• 🕯 Chart' : '🕯 Chart', `x:c:${KM[marketId]}:${id}:${t.entryT}`), btn('ℹ️ Strategy', `m:s:${KM[marketId]}:${id}`)],
      [btn('🎛 Menu', `m:h:${KM[marketId]}`)],
    ],
  };
  if (action === 'k') {
    const png = C.tradeCardImage({ market, strategy: strat, trade: found.trade, pos: found.pos, price, candles: list, capital: found.trade ? found.trade.capital ?? null : acc.capital, start: market.startCapital });
    const res = found.trade ? `result <b>${pct(found.trade.pnlPct)}</b>` : `running (${price ? pct((t.side === 'long' ? 1 : -1) * (price / t.entry - 1) * 100) : 'n/a'})`;
    return { png, caption: `${head}\n🧾 ${t.side === 'long' ? 'buy' : 'sell'} at ${quote(t.entry)} · ${res}`, keyboard };
  }
  const shown = list.filter((c) => c.t >= t.entryT - (tf === '1d' ? 40 : 30) * (tf === '1d' ? 86400 : 3600)).slice(-120);
  const markers = [{ t: t.entryT, price: t.entry, rgb: [124, 196, 255], label: t.side === 'long' ? 'achat' : 'vente' }];
  if (found.trade) markers.push({ t: found.trade.exitT, price: found.trade.exit, rgb: found.trade.pnlUsd >= 0 ? [34, 197, 94] : [240, 82, 82], label: 'sortie', below: true });
  const png = C.priceChartImage({
    market,
    candles: shown,
    title: `${market.name} · ${strat.name}`,
    subtitle: `${tf === '1d' ? '1-day' : '1-hour'} candles · entry${t.sl ? ', stop' : ''}${t.tp ? ', target' : ''}${found.trade ? ', exit' : ''}${price ? ` · price ${quote(price)}` : ''}`,
    levels: C.positionLevels(found.trade ? { ...t, sl: t.initSl || t.sl } : t),
    markers,
  });
  return { png, caption: `${head}\n🕯 price and trade levels`, keyboard };
}

/* ------------------------------------------------------------------ */
/* Réponse aux boutons                                                  */
/* ------------------------------------------------------------------ */

const busy = new Set(); // messages en cours de mise à jour
const lastClick = new Map(); // anti-rafale par personne

/** Envoie la vue : remplace l'image du message (panneau) ou répond avec une nouvelle image. */
async function show(ctx, out, { replace }) {
  const media = { type: 'photo', media: new InputFile(out.png, 'image.png'), caption: out.caption, parse_mode: 'HTML' };
  if (replace) {
    try {
      await ctx.editMessageMedia(media, { reply_markup: out.keyboard });
      return;
    } catch (err) {
      if (/not modified/i.test(err.description || err.message)) return;
      if (!/no media|can't be edited|there is no|message to edit not found/i.test(err.description || err.message)) throw err;
    }
  }
  const msg = ctx.callbackQuery?.message;
  await ctx.api.sendPhoto(ctx.chat.id, new InputFile(out.png, 'image.png'), {
    caption: out.caption,
    parse_mode: 'HTML',
    reply_markup: out.keyboard,
    ...(msg ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}),
    ...(msg?.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
  });
}

/**
 * Branche les boutons sur le bot. `gameHandler(ctx, parts)` traite les boutons du jeu (préfixe g:).
 */
function attachInteractive(bot, { cfg, store, gameHandler = null }) {
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    if (parts[0] === 'g' && gameHandler) return gameHandler(ctx, parts);
    if (parts[0] !== 'm' && parts[0] !== 'x') return ctx.answerCallbackQuery().catch(() => {});

    const who = ctx.from?.id;
    const now = Date.now();
    if (who && now - (lastClick.get(who) || 0) < 1200) return ctx.answerCallbackQuery({ text: 'Doucement 🙂' }).catch(() => {});
    lastClick.set(who, now);
    const msg = ctx.callbackQuery.message;
    const key = msg ? `${msg.chat.id}:${msg.message_id}` : data;
    if (busy.has(key)) return ctx.answerCallbackQuery({ text: '⏳ Building the image…' }).catch(() => {});
    busy.add(key);

    const marketId = MK[parts[2]];
    const slow = parts[1] === 't';
    await ctx.answerCallbackQuery(slow ? { text: '⏳ Simulation running (up to 1 min the first time)…' } : {}).catch(() => {});
    try {
      if (!marketId) throw new Error('unknown market');
      if (parts[0] === 'm') {
        const out = await render(cfg, store, parts[1], marketId, parts.slice(3));
        // Le panneau change d'image sur place ; un message texte (bilan, trade) reçoit une nouvelle image en réponse
        await show(ctx, out, { replace: Boolean(msg?.photo) });
      } else {
        const out = await renderTrade(cfg, store, parts[1], marketId, parts[3], Number(parts[4]));
        await show(ctx, out, { replace: Boolean(msg?.photo) });
      }
    } catch (err) {
      console.warn(`[boutons] ${data} : ${err.description || err.message}`);
      await ctx.answerCallbackQuery({ text: `❌ ${String(err.message).slice(0, 180)}`, show_alert: true }).catch(() => {});
    } finally {
      busy.delete(key);
    }
  });
}

/** Envoie un panneau (commande /menu, graphique quotidien). */
async function sendPanel(api, chatId, cfg, store, { view = 'h', marketId = 'nas100', args = [], extra = {} } = {}) {
  const out = await render(cfg, store, view, marketId, args);
  return api.sendPhoto(chatId, new InputFile(out.png, 'image.png'), { caption: out.caption, parse_mode: 'HTML', reply_markup: out.keyboard, ...extra });
}

module.exports = { fitCaption, attachInteractive, sendPanel, render, renderTrade, panelKeyboard, tradeKeyboard, summaryKeyboard, riskText, MK, KM };
