/**
 * Compte FTMO simulé en direct (paper trading) : suit les trades de certaines stratégies du bot, avec une taille
 * calculée au risque, et applique les règles du challenge FTMO en 2 étapes (voir src/ftmo.js).
 *   Étape 1 : +10 % · Étape 2 : +5 % · puis compte « financé » (on suit les gains mensuels, partage 80 %).
 *   Échec si la perte du jour atteint 5 % du capital initial (sous le solde de la veille, positions comprises)
 *   ou si le compte perd 10 % du capital initial. Après un échec, un nouveau challenge démarre le jour de trading suivant.
 * Deux comptes indépendants : « gold » (data/ftmo.json, stratégies FTMO_STRATEGIES) et « nas100 »
 * (data/ftmo-nas.json, stratégies FTMO_NAS_STRATEGIES).
 */
const { ftmoDay } = require('./ftmo');

/** Réglages d'un compte FTMO simulé : 'gold' (or) ou 'nas100' (Nasdaq). */
function accountOf(cfg, id = 'gold') {
  if (id === 'nas100') {
    const risk = cfg.ftmoNasRisk;
    return { id, label: 'Nasdaq', emoji: '🇺🇸', file: 'ftmo-nas.json', enabled: cfg.ftmoEnabled && cfg.ftmoNasEnabled && !cfg.ftmoCombined, strategies: cfg.ftmoNasStrategies, risk, riskOf: () => risk };
  }
  if (cfg.ftmoCombined) {
    // Compte unique or + Nasdaq (npm run ftmo-combo) : chaque marché garde son propre risque par trade
    return {
      id: 'gold', label: 'Or + Nasdaq', emoji: '🌍', file: 'ftmo.json', enabled: cfg.ftmoEnabled,
      strategies: [...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies], risk: cfg.ftmoRisk,
      riskOf: (marketId) => (marketId === 'nas100' ? cfg.ftmoComboNasRisk : cfg.ftmoRisk),
    };
  }
  return { id: 'gold', label: 'Or', emoji: '🥇', file: 'ftmo.json', enabled: cfg.ftmoEnabled, strategies: cfg.ftmoStrategies, risk: cfg.ftmoRisk, riskOf: () => cfg.ftmoRisk };
}
/** Comptes FTMO actifs. */
const ftmoAccounts = (cfg) => ['nas100', 'gold'].map((id) => accountOf(cfg, id)).filter((a) => a.enabled);
const TARGET = { 1: 10, 2: 5 };

function createFtmo({ cfg, store, account = 'gold' }) {
  const A = accountOf(cfg, account);
  const FILE = A.file;
  const fresh = (attempt = 1) => ({
    attempt, phase: 1, capital: cfg.ftmoCapital, balance: cfg.ftmoCapital, startedAt: Math.floor(Date.now() / 1000),
    day: null, dayStart: cfg.ftmoCapital, days: [], open: {}, closed: [], log: [], waitDay: null, funded: null,
  });
  const load = () => {
    const s = store.loadJson(FILE, null);
    return s && s.capital ? s : fresh();
  };
  const save = (s) => store.saveJson(FILE, s);
  const follows = (ev) => A.strategies.includes(`${ev.market.id}:${ev.strategy.id}`);
  const key = (marketId, sid, entryT) => `${marketId}:${sid}:${entryT}`;
  const fee = (marketId) => (marketId === 'nas100' ? cfg.ftmoFeeNas : cfg.ftmoFeeGold);

  function rollDay(s, t) {
    const d = ftmoDay(t);
    if (s.day !== d) {
      s.day = d;
      s.dayStart = s.balance;
    }
  }

  /** Valeur du compte avec les positions ouvertes au cours actuel. */
  function equity(s, prices) {
    let eq = s.balance;
    for (const p of Object.values(s.open)) {
      const px = prices[p.market];
      if (px) eq += p.notional * ((p.side === 'long' ? 1 : -1) * (px / p.entry - 1) - fee(p.market) / 100);
    }
    return eq;
  }

  function closeAll(s, prices, t, reason) {
    for (const [k, p] of Object.entries(s.open)) {
      const px = prices[p.market] || p.entry;
      const pnl = p.notional * ((p.side === 'long' ? 1 : -1) * (px / p.entry - 1) - (2 * fee(p.market)) / 100);
      s.balance += pnl;
      s.closed.push({ ...p, exit: px, exitT: t, pnl, reason });
      delete s.open[k];
    }
  }

  /**
   * Traite les événements du passage et vérifie les règles. Retourne les messages à publier.
   * prices : { gold: cours, nas100: cours }
   */
  function onCycle(events, prices, t = Math.floor(Date.now() / 1000)) {
    if (!A.enabled) return [];
    const s = load();
    const out = [];
    rollDay(s, t);
    if (s.waitDay && s.day !== s.waitDay) s.waitDay = null; // nouveau challenge : reprise le jour suivant

    for (const ev of events) {
      if (!follows(ev)) continue;
      if (ev.type === 'open' && !s.waitDay) {
        const p = ev.pos;
        const stopPct = (Math.abs(p.entry - (p.initSl ?? p.sl)) / p.entry) * 100;
        if (!(stopPct > 0)) continue;
        if (cfg.ftmoDayStop > 0 && s.balance <= s.dayStart - (s.capital * cfg.ftmoDayStop) / 100) continue; // stop du jour maison
        const notional = Math.min((s.balance * A.riskOf(ev.market.id)) / stopPct, s.balance * cfg.ftmoLeverage);
        s.open[key(ev.market.id, ev.strategy.id, p.entryT)] = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, notional, entryT: p.entryT };
        if (!s.days.includes(s.day)) s.days.push(s.day);
      } else if (ev.type === 'close') {
        const k = key(ev.market.id, ev.strategy.id, ev.trade.entryT);
        const p = s.open[k];
        if (!p) continue;
        const tr = ev.trade;
        const pnl = p.notional * ((p.side === 'long' ? 1 : -1) * (tr.exit / p.entry - 1) - (2 * fee(p.market)) / 100);
        s.balance += pnl;
        s.closed.push({ ...p, exit: tr.exit, exitT: tr.exitT, pnl, reason: tr.reason });
        delete s.open[k];
        out.push({ type: 'trade', s, p: { ...p, exit: tr.exit, pnl } });
      }
    }

    // Règles du challenge (positions ouvertes comprises)
    if (s.phase !== 'funded') {
      const eq = equity(s, prices);
      const dailyFloor = s.dayStart - (s.capital * 5) / 100;
      const maxFloor = s.capital * 0.9;
      if (eq <= dailyFloor || eq <= maxFloor) {
        closeAll(s, prices, t, 'règle FTMO');
        const why = eq <= maxFloor ? 'perte maximale (−10 %) atteinte' : 'perte du jour (−5 %) atteinte';
        out.push({ type: 'fail', s: { ...s }, why });
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'échec', why, at: t, balance: s.balance }].slice(-20);
        next.waitDay = ftmoDay(t);
        save(next);
        return out;
      }
      const goal = s.capital * (1 + TARGET[s.phase] / 100);
      if (s.balance >= goal && !Object.keys(s.open).length && s.days.length >= 4) {
        const done = s.phase;
        s.history = [...(s.history || []), { attempt: s.attempt, phase: done, outcome: 'réussie', at: t, balance: s.balance, days: s.days.length }].slice(-20);
        out.push({ type: 'pass', s: { ...s }, phase: done });
        if (done === 1) {
          Object.assign(s, { phase: 2, balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t });
        } else {
          Object.assign(s, { phase: 'funded', balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, funded: { since: t } });
        }
      }
    } else {
      // Compte financé : mêmes limites de perte ; on suit le gain (partage 80 %)
      const eq = equity(s, prices);
      if (eq <= s.dayStart - (s.capital * 5) / 100 || eq <= s.capital * 0.9) {
        closeAll(s, prices, t, 'règle FTMO');
        out.push({ type: 'fail', s: { ...s }, why: 'compte financé perdu (limite de perte)' });
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: 'financé', outcome: 'perdu', at: t, balance: s.balance }].slice(-20);
        next.waitDay = ftmoDay(t);
        save(next);
        return out;
      }
    }
    s.closed = s.closed.slice(-200);
    save(s);
    return out;
  }

  /** Résumé chiffré (pour l'image et les messages). */
  function status(prices = {}) {
    const s = load();
    const eq = equity(s, prices);
    const target = s.phase === 'funded' ? null : s.capital * (1 + TARGET[s.phase] / 100);
    return {
      s,
      account: A,
      equity: eq,
      target,
      progress: target ? Math.max(0, (eq - s.capital) / (target - s.capital)) : null,
      dailyUsed: Math.max(0, (s.dayStart - eq) / ((s.capital * 5) / 100)),
      maxUsed: Math.max(0, (s.capital - eq) / (s.capital * 0.1)),
      wins: s.closed.filter((c) => c.pnl > 0).length,
      trades: s.closed.length,
    };
  }

  return { onCycle, status, load, account: A, reset: () => save(fresh()) };
}

module.exports = { createFtmo, accountOf, ftmoAccounts, TARGET };
