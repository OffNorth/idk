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
const { RULES } = require('./sizing');

/** Réglages d'un compte FTMO simulé : 'gold' (or) ou 'nas100' (Nasdaq). */
function accountOf(cfg, id = 'gold') {
  if (id === 'nas100') {
    const risk = cfg.ftmoNasRisk;
    return { id, label: 'Nasdaq', emoji: '🇺🇸', file: 'ftmo-nas.json', enabled: cfg.ftmoEnabled && cfg.ftmoNasEnabled && !cfg.ftmoCombined, strategies: cfg.ftmoNasStrategies, risk, riskOf: () => risk };
  }
  if (cfg.ftmoCombined) {
    // Compte unique or + Nasdaq (npm run ftmo-combo) : chaque marché garde son propre risque par trade
    return {
      id: 'gold', label: 'Or + Nasdaq + EUR/USD', emoji: '🌍', file: 'ftmo.json', enabled: cfg.ftmoEnabled,
      strategies: [...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies], risk: cfg.ftmoRisk,
      riskOf: (marketId) => (marketId === 'nas100' ? cfg.ftmoComboNasRisk : marketId === 'eurusd' ? cfg.ftmoEurRisk ?? cfg.ftmoRisk : cfg.ftmoRisk),
    };
  }
  return { id: 'gold', label: 'Or', emoji: '🥇', file: 'ftmo.json', enabled: cfg.ftmoEnabled, strategies: cfg.ftmoStrategies, risk: cfg.ftmoRisk, riskOf: () => cfg.ftmoRisk };
}
/** Comptes FTMO actifs. */
const ftmoAccounts = (cfg) => ['nas100', 'gold'].map((id) => accountOf(cfg, id)).filter((a) => a.enabled);
const TARGET = { 1: 10, 2: 5 };

/**
 * Formules FTMO (FTMO_PROGRAM) — règles 2026 d'après des sources secondaires, à vérifier sur le site de FTMO :
 *   2step : +10 % puis +5 %, perte du jour 5 %, perte max 10 % fixe
 *   swing : idem, levier max 1:10 sur l'or et les indices (1:30 sur le forex)
 *   1step : +10 % en une étape, perte du jour 3 %, perte max 10 % suiveuse (depuis le plus haut solde),
 *           meilleur jour ≤ 50 % du gain total
 */
const PROGRAMS = {
  '2step': { label: 'Challenge 2 étapes', steps: 2, daily: 5, max: 10, trailing: false, bestDay: 0, levCap: null },
  swing: { label: 'Challenge 2 étapes Swing', steps: 2, daily: 5, max: 10, trailing: false, bestDay: 0, levCap: { gold: 10, nas100: 10, eurusd: 30 } },
  '1step': { label: 'Challenge 1 étape', steps: 1, daily: 3, max: 10, trailing: true, bestDay: 50, levCap: null },
};
const programOf = (cfg) => PROGRAMS[cfg.ftmoProgram] || PROGRAMS['2step'];

function createFtmo({ cfg, store, account = 'gold' }) {
  const A = accountOf(cfg, account);
  const P = programOf(cfg);
  const FILE = A.file;
  const fresh = (attempt = 1) => ({
    attempt, phase: 1, capital: cfg.ftmoCapital, balance: cfg.ftmoCapital, startedAt: Math.floor(Date.now() / 1000),
    day: null, dayStart: cfg.ftmoCapital, days: [], open: {}, closed: [], log: [], waitDay: null, funded: null,
    peak: cfg.ftmoCapital, dayPnl: {}, program: cfg.ftmoProgram,
  });
  const load = () => {
    const s = store.loadJson(FILE, null);
    if (!s || !s.capital) return fresh();
    // Changement de formule (FTMO_PROGRAM) : nouveau challenge, l'ancien reste dans l'historique
    if ((s.program || '2step') !== cfg.ftmoProgram) {
      const next = fresh((s.attempt || 0) + 1);
      next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: `arrêté (passage au ${P.label.toLowerCase()})`, at: Math.floor(Date.now() / 1000), balance: s.balance }].slice(-20);
      return next;
    }
    return s;
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
        // Levier dynamique (src/sizing.js, FTMO_SIZING) : le risque du trade est ajusté selon l'état du compte
        const rule = RULES[cfg.ftmoSizing] || RULES.fixe;
        const mul = rule({ ...p, sid: `${ev.market.id}:${ev.strategy.id}` }, { balance: s.balance, capital: s.capital, dayStart: s.dayStart, target: TARGET[s.phase] || 5, open: Object.keys(s.open).length });
        if (!(mul > 0)) continue;
        const cap = (P.levCap && P.levCap[ev.market.id]) || cfg.ftmoLeverage; // levier max (par marché sur le compte Swing)
        const notional = Math.min((s.balance * A.riskOf(ev.market.id) * mul) / stopPct, s.balance * cap);
        s.open[key(ev.market.id, ev.strategy.id, p.entryT)] = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, notional, entryT: p.entryT, lev: notional / s.balance, mul };
        if (!s.days.includes(s.day)) s.days.push(s.day);
      } else if (ev.type === 'close') {
        const k = key(ev.market.id, ev.strategy.id, ev.trade.entryT);
        const p = s.open[k];
        if (!p) continue;
        const tr = ev.trade;
        const pnl = p.notional * ((p.side === 'long' ? 1 : -1) * (tr.exit / p.entry - 1) - (2 * fee(p.market)) / 100);
        s.balance += pnl;
        s.peak = Math.max(s.peak ?? s.capital, s.balance);
        s.dayPnl = s.dayPnl || {};
        s.dayPnl[s.day] = (s.dayPnl[s.day] || 0) + pnl;
        s.closed.push({ ...p, exit: tr.exit, exitT: tr.exitT, pnl, reason: tr.reason });
        delete s.open[k];
        out.push({ type: 'trade', s, p: { ...p, exit: tr.exit, pnl } });
      }
    }

    // Règles du challenge (positions ouvertes comprises)
    if (s.phase !== 'funded') {
      const eq = equity(s, prices);
      const dailyFloor = s.dayStart - (s.capital * P.daily) / 100;
      const maxFloor = (P.trailing ? s.peak ?? s.capital : s.capital) - (s.capital * P.max) / 100;
      if (eq <= dailyFloor || eq <= maxFloor) {
        closeAll(s, prices, t, 'règle FTMO');
        const why = eq <= maxFloor ? `perte maximale (−${P.max} %${P.trailing ? ' depuis le plus haut' : ''}) atteinte` : `perte du jour (−${P.daily} %) atteinte`;
        out.push({ type: 'fail', s: { ...s }, why });
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'échec', why, at: t, balance: s.balance }].slice(-20);
        next.waitDay = ftmoDay(t);
        save(next);
        return out;
      }
      const goal = s.capital * (1 + TARGET[s.phase] / 100);
      // Règle du meilleur jour (1 étape) : le meilleur jour ne doit pas dépasser P.bestDay % du gain total
      const bestOk = !(P.bestDay > 0) || Math.max(0, ...Object.values(s.dayPnl || {})) <= ((s.balance - s.capital) * P.bestDay) / 100;
      if (s.balance >= goal && !Object.keys(s.open).length && s.days.length >= 4 && bestOk) {
        const done = s.phase;
        s.history = [...(s.history || []), { attempt: s.attempt, phase: done, outcome: 'réussie', at: t, balance: s.balance, days: s.days.length }].slice(-20);
        out.push({ type: 'pass', s: { ...s }, phase: done });
        if (done === 1 && P.steps === 2) {
          Object.assign(s, { phase: 2, balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, peak: s.capital, dayPnl: {} });
        } else {
          Object.assign(s, { phase: 'funded', balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, funded: { since: t }, peak: s.capital, dayPnl: {} });
        }
      }
    } else {
      // Compte financé : mêmes limites de perte ; on suit le gain (partage 80 %)
      const eq = equity(s, prices);
      if (eq <= s.dayStart - (s.capital * P.daily) / 100 || eq <= (P.trailing ? s.peak ?? s.capital : s.capital) - (s.capital * P.max) / 100) {
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
      program: P,
      equity: eq,
      target,
      progress: target ? Math.max(0, (eq - s.capital) / (target - s.capital)) : null,
      dailyUsed: Math.max(0, (s.dayStart - eq) / ((s.capital * P.daily) / 100)),
      maxUsed: Math.max(0, ((P.trailing ? s.peak ?? s.capital : s.capital) - eq) / ((s.capital * P.max) / 100)),
      wins: s.closed.filter((c) => c.pnl > 0).length,
      trades: s.closed.length,
    };
  }

  return { onCycle, status, load, account: A, reset: () => save(fresh()) };
}

module.exports = { createFtmo, accountOf, ftmoAccounts, TARGET, PROGRAMS, programOf };
