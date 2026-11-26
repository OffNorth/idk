/**
 * Compte « Portefeuille perso » simulé (npm run portfolio, 26/11/2026) : l'argent de l'utilisateur, sans prop firm.
 * Répartition : 50 % monde (60 % S&P 500 + 40 % actions hors USA), 10 % or, 40 % gérés par 5 stratégies journalières
 * du bot (RSI 2 et Double 7 sur le S&P 500, croix dorée sur le Nasdaq 100, tendance et saison sur l'or), chacune
 * investie dans son ETF ou en liquidités (obligations 1–3 ans) sinon. ETF réels, dividendes inclus (Yahoo, cours
 * ajustés), rééquilibrage mensuel, frais 0,1 % du montant échangé, valeur en euros.
 * Historique 2005–2026 : 10,2 %/an, pire baisse −26 %, pire année −14 % (ETF monde seul : 9,8 %, −53 %, −36 %).
 *
 * La valeur est recalculée chaque jour depuis la date d'ouverture du compte (data/portfolio.json), avec les mêmes
 * règles que la recherche ; un message part dans le groupe quand une stratégie du bot achète ou vend, et au
 * rééquilibrage mensuel.
 */
const { fetchYahoo } = require('./yahoo');
const { selectStrategies } = require('./strategies');
const { backtest } = require('./gold');
const { computeAll } = require('./indicators');

const DAY = 86400;
const COST = 0.001;
const ETF = ['SPY', 'EFA', 'QQQ', 'GLD', 'SHY'];
// Poches gérées par le bot : [nom, ETF, stratégie]
const BOT = [['RSI 2 · S&P 500', 'SPY', 'rsi2'], ['Double 7 · S&P 500', 'SPY', 'double7'], ['Golden cross · Nasdaq 100', 'QQQ', 'golden'],
  ['Trend · gold', 'GLD', 'trendmix'], ['Season · gold', 'GLD', 'season']];
const WEIGHTS = { WORLD: 0.5, GLD: 0.1, BOT: 0.4 };
const FILE = 'portfolio.json';

/**
 * Simule le portefeuille depuis `start` (secondes) : valeur en € jour par jour, poches du bot (investies ou non),
 * dernier rééquilibrage. data : { SPY: [bougies ajustées], …, EURUSD: [bougies], VIX: [bougies] }.
 */
function simulate(data, { start, capital = 10_000 } = {}) {
  const days = data.SPY.filter((k) => k.t >= start).map((k) => k.t);
  if (days.length < 2) return null;
  const series = (arr) => { const m = new Map(arr.map((k) => [k.t, k.c])); let last = null; const out = []; for (const k of arr) if (k.t < days[0]) last = k.c; for (const t of days) out.push(m.has(t) ? (last = m.get(t)) : last); return out; };
  const P = Object.fromEntries(ETF.map((s) => [s, series(data[s])]));
  const FX = series(data.EURUSD);
  const ret = (p) => p.map((v, i) => (i && p[i - 1] && v ? v / p[i - 1] - 1 : 0));
  const R = Object.fromEntries(ETF.map((s) => [s, ret(P[s])]));
  R.WORLD = R.SPY.map((r, i) => 0.6 * r + 0.4 * R.EFA[i]);
  // Poches du bot : positions des stratégies sur tout l'historique (indicateurs), puis jour par jour
  const sleeves = BOT.map(([name, sym, id]) => {
    const d = data[sym];
    const s = selectStrategies([id])[0];
    const ind = computeAll(d, d, 86400, null, data.VIX || null, {});
    const out = backtest(s, d, { size: 1000, feePct: COST * 50, barSec: 86400, ind, daily: d, vix: data.VIX || null });
    const spans = out.list.map((tr) => [tr.entryT, tr.exitT]);
    if (out.open) spans.push([out.open.entryT, Infinity]);
    const inAt = (t) => spans.some(([a, b]) => t >= a && t < b);
    const r = days.map((t, i) => (i === 0 ? 0 : inAt(days[i - 1]) ? R[sym][i] : R.SHY[i]));
    const last = out.open ? { since: out.open.entryT, entry: out.open.entry } : null;
    const trades = out.list.filter((tr) => tr.exitT >= days[0]).map((tr) => ({ entryT: tr.entryT, exitT: tr.exitT, pnlPct: tr.pnlPct }));
    return { name, sym, id, r, open: !!out.open, last, trades };
  });
  R.BOT = days.map((_, i) => sleeves.reduce((a, s) => a + s.r[i], 0) / sleeves.length);
  const monthEnd = days.map((t, i) => i === days.length - 1 || new Date(days[i + 1] * 1000).getUTCMonth() !== new Date(t * 1000).getUTCMonth());
  let v = capital; let w = { ...WEIGHTS }; let peak = capital; let dd = 0;
  const curve = [{ t: days[0], v }];
  let lastRebal = days[0];
  for (let i = 1; i < days.length; i++) {
    const fxr = FX[i - 1] && FX[i] ? FX[i - 1] / FX[i] - 1 : 0; // dollar → euro
    const r = Object.entries(w).reduce((a, [k, x]) => a + x * R[k][i], 0);
    // Les poids dérivent entre deux rééquilibrages
    const grow = Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x * (1 + R[k][i])]));
    const tot = Object.values(grow).reduce((a, x) => a + x, 0);
    w = Object.fromEntries(Object.entries(grow).map(([k, x]) => [k, x / tot]));
    v *= (1 + r) * (1 + fxr);
    if (monthEnd[i] && i < days.length - 1) {
      const turn = Object.keys(WEIGHTS).reduce((a, k) => a + Math.abs(WEIGHTS[k] - (w[k] || 0)), 0);
      v *= 1 - (COST * turn) / 2;
      w = { ...WEIGHTS };
      lastRebal = days[i];
    }
    peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1);
    curve.push({ t: days[i], v });
  }
  return {
    start: days[0], at: days[days.length - 1], capital, value: v, ret: v / capital - 1, drawdown: v / peak - 1, maxDrawdown: dd, lastRebal,
    weights: w, sleeves: sleeves.map(({ name, sym, id, open, last, trades }) => ({ name, sym, id, open, last, trades: trades.slice(-10) })), curve,
  };
}

/** Données (une fois par jour au plus) : ETF ajustés des dividendes, EUR/USD, VIX. */
let cache = { day: null, data: null };
async function loadData(fetcher = fetchYahoo) {
  const day = new Date().toISOString().slice(0, 10);
  if (cache.day === day && cache.data) return cache.data;
  const data = {};
  for (const s of ETF) data[s] = (await fetcher(s, '1d', { period1: 0, adjusted: true })).filter((k) => k.c > 0);
  data.EURUSD = (await fetcher('EURUSD=X', '1d', { period1: 0 })).filter((k) => k.c > 0);
  data.VIX = (await fetcher('^VIX', '1d', { range: '5y' }).catch(() => [])).filter((k) => k.c > 0);
  cache = { day, data };
  return data;
}

/**
 * Passage quotidien : recalcule le compte, enregistre l'état (data/portfolio.json) et retourne les événements à publier
 * (achats / ventes des poches du bot, rééquilibrage du mois). Ne lève pas d'erreur (retourne []).
 */
async function update(cfg, store, { fetcher, now = Date.now() } = {}) {
  if (!cfg.portfolioEnabled) return [];
  const prev = store.loadJson(FILE, null);
  const startSec = prev?.startT || Math.floor(now / 1000 / DAY) * DAY;
  // Une fois par jour, après la clôture de New York (21 h 30 UTC) ou au premier passage
  const today = new Date(now).toISOString().slice(0, 10);
  if (prev && prev.day === today) return [];
  if (prev && new Date(now).getUTCHours() < 22) return [];
  let data;
  try { data = await loadData(fetcher); } catch (err) { console.warn('[portefeuille] données indisponibles :', err.message); return []; }
  const sim = simulate(data, { start: startSec, capital: cfg.portfolioCapital || 10_000 });
  if (!sim) { store.saveJson(FILE, { ...(prev || {}), startT: startSec, day: today }); return []; }
  const events = [];
  const before = Object.fromEntries((prev?.sleeves || []).map((s) => [s.id + s.sym, s.open]));
  if (prev) {
    for (const s of sim.sleeves) {
      const was = before[s.id + s.sym];
      if (was !== undefined && was !== s.open) events.push({ type: s.open ? 'buy' : 'sell', sleeve: s });
    }
    if (prev.lastRebal && sim.lastRebal > prev.lastRebal) events.push({ type: 'rebalance' });
  }
  store.saveJson(FILE, { startT: startSec, day: today, ...sim, curve: sim.curve.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 400)) === 0 || i === a.length - 1) });
  return events;
}

const eur = (v) => `€${Math.round(v).toLocaleString('en-US')}`;
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;

/** Message du groupe pour un événement. */
function eventMessage(ev, st) {
  const head = `💼 <b>Personal portfolio</b> · ${st ? `${eur(st.value)} (${pct(st.ret)})` : ''}`;
  if (ev.type === 'rebalance') return `${head}\n🔁 Monthly rebalance: 50% world · 10% gold · 40% bot strategies.\n<i>Simulated account, fake money.</i>`;
  const s = ev.sleeve;
  return `${head}\n${ev.type === 'buy' ? '🟢 Buy' : '🔴 Sell'} <b>${s.sym}</b> — ${s.name}${ev.type === 'buy' ? ' (8% of the portfolio)' : ' → cash'}\n<i>Simulated account, fake money.</i>`;
}

/** Texte de /portefeuille. */
function report(cfg, store) {
  const st = store.loadJson(FILE, null);
  if (!cfg.portfolioEnabled) return 'Personal portfolio is off (PORTFOLIO=0).';
  if (!st || !st.value) return '💼 Personal portfolio: opens on the bot’s next pass (computed once a day, after the New York close).';
  const w = st.weights || {};
  const lines = [
    `💼 <b>Personal portfolio (simulated)</b> · opened on ${new Date(st.startT * 1000).toLocaleDateString('en-US')}`,
    `Value <b>${eur(st.value)}</b> (${pct(st.ret)} on ${eur(st.capital)}) · drawdown from the high ${pct(st.drawdown)} · worst drawdown ${pct(st.maxDrawdown)}`,
    `Current allocation: world ${Math.round((w.WORLD || 0) * 100)}% · gold ${Math.round((w.GLD || 0) * 100)}% · bot ${Math.round((w.BOT || 0) * 100)}% (target 50 / 10 / 40, rebalanced monthly)`,
    '', '<b>Bot sleeves</b> (8% each):',
    ...st.sleeves.map((s) => `• ${s.name}: ${s.open ? `🟢 invested in ${s.sym} since ${new Date(s.last.since * 1000).toLocaleDateString('en-US')}` : '⚪ in cash'}`),
    '', '<i>2005–2026 history of this allocation: 10.2%/yr, worst drawdown −26% (world ETF alone: 9.8%/yr, −53%). Simulation: no real money, not financial advice.</i>',
  ];
  return lines.join('\n');
}

/** Résumé envoyé au site. */
function view(store) {
  const st = store.loadJson(FILE, null);
  if (!st || !st.value) return null;
  return { startT: st.startT, at: st.at, capital: st.capital, value: Math.round(st.value * 100) / 100, ret: st.ret, drawdown: st.drawdown, maxDrawdown: st.maxDrawdown,
    weights: st.weights, target: WEIGHTS, sleeves: st.sleeves.map((s) => ({ name: s.name, sym: s.sym, open: s.open, since: s.last?.since || null, trades: s.trades })),
    curve: (st.curve || []).map((p) => [p.t, Math.round(p.v * 100) / 100]) };
}

module.exports = { simulate, update, report, view, eventMessage, loadData, BOT, WEIGHTS, FILE };
