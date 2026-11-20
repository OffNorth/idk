/**
 * Compte FTMO simulé en direct (paper trading) : suit les trades de certaines stratégies du bot, avec une taille
 * calculée au risque, et applique les règles du challenge FTMO en 2 étapes (voir src/ftmo.js).
 *   Étape 1 : +10 % · Étape 2 : +5 % · puis compte « financé » (on suit les gains mensuels, partage 80 %).
 *   Échec si la perte du jour atteint 5 % du capital initial (sous le solde de la veille, positions comprises)
 *   ou si le compte perd 10 % du capital initial. Après un échec, un nouveau challenge démarre le jour de trading suivant.
 * Deux comptes indépendants : « gold » (data/ftmo.json, stratégies FTMO_STRATEGIES) et « nas100 »
 * (data/ftmo-nas.json, stratégies FTMO_NAS_STRATEGIES).
 */
const { ftmoDay, cmeDay } = require('./ftmo');
const { RULES } = require('./sizing');

/**
 * Micro-futures CME (compte Lucid) : valeur d'un contrat = prix × mult ; frais aller-retour par contrat
 * (commission ≈ 1,5 $ + 1 tick de glissement par côté). Cours en direct : or GC=F, Nasdaq ^NDX, S&P ^GSPC, EUR/USD.
 */
const MICRO = {
  gold: { mult: 10, fee: 3.5, name: 'MGC' }, // 10 onces
  nas100: { mult: 2, fee: 2.5, name: 'MNQ' }, // 2 $ par point
  spx: { mult: 5, fee: 4, name: 'MES' }, // 5 $ par point
  eurusd: { mult: 12_500, fee: 4, name: 'M6E' }, // 12 500 €
};

/**
 * Évaluation LucidFlex (sources secondaires 2026, à vérifier sur le site de Lucid) : +6 %, pas de perte du jour,
 * perte max 2 000 $ (50K) / 3 000 $ (100K) suiveuse en fin de journée (séance CME, 17 h New York), bloquée à
 * capital + 100 $, meilleur jour ≤ 50 % du gain, micro-futures en contrats entiers (40 / 60 au plus), 90 % des gains.
 */
const lucidProgram = (capital) => ({
  key: `lucid${Math.round(capital / 1000)}k`, label: 'Évaluation LucidFlex', firm: 'Lucid', steps: 1, target: 6, daily: Infinity,
  maxUsd: capital > 75_000 ? 3000 : 2000, lockAt: 100, eod: true, bestDay: 50, minDays: 2, contracts: true,
  maxContracts: capital > 75_000 ? 60 : 40, levCap: null, split: 90,
});

/** Réglages d'un compte simulé : 'gold' (FTMO, or ou compte combiné), 'nas100' (FTMO Nasdaq) ou 'lucid' (LucidFlex). */
function accountOf(cfg, id = 'gold') {
  if (id === 'lucid') {
    // Mêmes stratégies et mêmes risques que le compte FTMO combiné (× LUCID_RISK_MUL), règles et contrats Lucid
    const base = accountOf({ ...cfg, ftmoCombined: true }, 'gold');
    const capital = cfg.lucidCapital || 50_000;
    const mul = cfg.lucidRiskMul ?? 1;
    return {
      ...base, id: 'lucid', firm: 'Lucid', label: `LucidFlex ${Math.round(capital / 1000)}K`, emoji: '🟣', file: 'lucid.json',
      enabled: !!(cfg.ftmoEnabled && cfg.lucidEnabled), capital, program: lucidProgram(capital), riskOf: (m, st) => base.riskOf(m, st) * mul,
    };
  }
  if (id === 'nas100') {
    const risk = cfg.ftmoNasRisk;
    return { id, label: 'Nasdaq', emoji: '🇺🇸', file: 'ftmo-nas.json', enabled: cfg.ftmoEnabled && cfg.ftmoNasEnabled && !cfg.ftmoCombined, strategies: cfg.ftmoNasStrategies, risk, riskOf: () => risk };
  }
  if (cfg.ftmoCombined) {
    // Compte unique or + Nasdaq (npm run ftmo-combo) : chaque marché garde son propre risque par trade
    return {
      id: 'gold', firm: 'FTMO', label: 'Or + Nasdaq + EUR/USD', emoji: '🌍', file: 'ftmo.json', enabled: cfg.ftmoEnabled,
      strategies: [...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies], risk: cfg.ftmoRisk,
      // Stratégies intraday (tf ≠ 1d) : risque propre (FTMO_INTRADAY_RISK_PCT), plus petit que celui des journalières
      riskOf: (marketId, strat) => (strat && strat.tf && strat.tf !== '1d' && cfg.ftmoIntradayRisk ? cfg.ftmoIntradayRisk
        : marketId === 'nas100' ? cfg.ftmoComboNasRisk : marketId === 'eurusd' ? cfg.ftmoEurRisk ?? cfg.ftmoRisk : marketId === 'spx' ? cfg.ftmoSpxRisk ?? cfg.ftmoRisk : cfg.ftmoRisk),
    };
  }
  return { id: 'gold', label: 'Or', emoji: '🥇', file: 'ftmo.json', enabled: cfg.ftmoEnabled, strategies: cfg.ftmoStrategies, risk: cfg.ftmoRisk, riskOf: () => cfg.ftmoRisk };
}
/** Comptes FTMO actifs. */
const ftmoAccounts = (cfg) => ['nas100', 'gold', 'lucid'].map((id) => accountOf(cfg, id)).filter((a) => a.enabled);
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
  swing: { label: 'Challenge 2 étapes Swing', steps: 2, daily: 5, max: 10, trailing: false, bestDay: 0, levCap: { gold: 10, nas100: 10, spx: 10, eurusd: 30 } },
  '1step': { label: 'Challenge 1 étape', steps: 1, daily: 3, max: 10, trailing: true, bestDay: 50, levCap: null },
};
const programOf = (cfg) => PROGRAMS[cfg.ftmoProgram] || PROGRAMS['2step'];

function createFtmo({ cfg, store, account = 'gold' }) {
  const A = accountOf(cfg, account);
  const P = A.program || programOf(cfg);
  const PKEY = A.program ? A.program.key : cfg.ftmoProgram;
  const CAP = A.capital ?? cfg.ftmoCapital;
  const dayOf = P.eod ? cmeDay : ftmoDay; // Lucid : séance des futures CME
  const FILE = A.file;
  const fresh = (attempt = 1) => ({
    attempt, phase: 1, capital: CAP, balance: CAP, startedAt: Math.floor(Date.now() / 1000),
    day: null, dayStart: CAP, days: [], open: {}, closed: [], log: [], waitDay: null, funded: null,
    peak: CAP, eodPeak: CAP, dayPnl: {}, program: PKEY,
  });
  /** Objectif de la phase en % (null en compte financé). */
  const targetPct = (s) => (s.phase === 'funded' ? null : P.target ?? TARGET[s.phase]);
  /** Seuil de perte max : Lucid = plus haut solde de clôture − perte max ($), bloqué à capital + 100 $ ; FTMO = 10 %. */
  const maxFloor = (s) => (P.maxUsd
    ? Math.min((s.eodPeak ?? s.capital) - P.maxUsd, s.capital + (P.lockAt ?? Infinity))
    : (P.trailing ? s.peak ?? s.capital : s.capital) - (s.capital * P.max) / 100);
  const dailyFloor = (s) => (Number.isFinite(P.daily) ? s.dayStart - (s.capital * P.daily) / 100 : -Infinity);
  const load = () => {
    const s = store.loadJson(FILE, null);
    if (!s || !s.capital) return fresh();
    // Changement de formule (FTMO_PROGRAM) : nouveau challenge, l'ancien reste dans l'historique
    if ((s.program || '2step') !== PKEY) {
      const next = fresh((s.attempt || 0) + 1);
      next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: `arrêté (passage au ${P.label.toLowerCase()})`, at: Math.floor(Date.now() / 1000), balance: s.balance }].slice(-20);
      return next;
    }
    return s;
  };
  const save = (s) => store.saveJson(FILE, s);
  const adapt = require('./adapt');
  // Stratégies suivies + candidates promues par l'adaptation automatique (AUTO_ADAPT)
  const follows = (ev) => A.strategies.includes(`${ev.market.id}:${ev.strategy.id}`) || adapt.promotedOf(cfg, store).includes(`${ev.market.id}:${ev.strategy.id}`);
  const key = (marketId, sid, entryT) => `${marketId}:${sid}:${entryT}`;
  const fee = (marketId) => (marketId === 'nas100' ? cfg.ftmoFeeNas : cfg.ftmoFeeGold);
  /** Frais d'une position : par contrat (futures, Lucid) ou en % du montant (CFD, FTMO) ; sides = 1 (sortie) ou 2. */
  const costOf = (p, sides) => (p.n ? (p.n * p.cfee * sides) / 2 : (p.notional * sides * fee(p.market)) / 100);
  const pnlAt = (p, px, sides) => p.notional * (p.side === 'long' ? 1 : -1) * (px / p.entry - 1) - costOf(p, sides);

  function rollDay(s, t) {
    const d = dayOf(t);
    if (s.day !== d) {
      if (s.day) s.eodPeak = Math.max(s.eodPeak ?? s.capital, s.balance); // solde de clôture de la journée précédente
      s.day = d;
      s.dayStart = s.balance;
    }
  }

  /** Valeur du compte avec les positions ouvertes au cours actuel. */
  function equity(s, prices) {
    let eq = s.balance;
    for (const p of Object.values(s.open)) {
      const px = prices[p.market];
      if (px) eq += pnlAt(p, px, 1);
    }
    return eq;
  }

  function closeAll(s, prices, t, reason) {
    for (const [k, p] of Object.entries(s.open)) {
      const px = prices[p.market] || p.entry;
      const pnl = pnlAt(p, px, 2);
      s.balance += pnl;
      s.closed.push({ ...p, exit: px, exitT: t, pnl, reason });
      delete s.open[k];
    }
  }

  const refusedFile = A.file.replace(/\.json$/, '-ia-refuses.json');

  /**
   * Bilan des signaux refusés par l'IA : ce qu'ils auraient fait sur le compte FTMO (taille qu'ils auraient eue ×
   * résultat du trade paper correspondant ; gain latent au cours actuel s'ils sont encore ouverts).
   */
  function refusedReport(prices = {}) {
    const list = store.loadJson(refusedFile, []);
    const papers = {};
    const rows = list.map((r) => {
      papers[r.market] ??= store.loadJson(`${r.market}.json`, null);
      const acc = papers[r.market]?.accounts?.[r.sid];
      const done = (acc?.closed || []).find((c) => Math.abs(c.entryT - r.entryT) < 2);
      if (done) return { ...r, state: 'closed', pnl: (r.notional * done.pnlPct) / 100, exit: done.exit, exitT: done.exitT };
      const px = prices[r.market] ?? papers[r.market]?.lastPrice;
      if (acc?.position && Math.abs(acc.position.entryT - r.entryT) < 2 && px) return { ...r, state: 'open', pnl: r.notional * ((r.side === 'long' ? 1 : -1) * (px / r.entry - 1) - fee(r.market) / 100) };
      return { ...r, state: 'unknown', pnl: 0 };
    });
    const closed = rows.filter((x) => x.state === 'closed');
    const open = rows.filter((x) => x.state === 'open');
    const sum = (l) => l.reduce((a, x) => a + x.pnl, 0);
    return { rows, n: rows.length, closed: closed.length, closedPnl: sum(closed), wins: closed.filter((x) => x.pnl > 0).length, open: open.length, openPnl: sum(open) };
  }

  /** Avis de l'IA validatrice sur un signal (historique et contexte du paper trading du marché), ou null. */
  function aiOpinion(ev, p) {
    try {
      const paper = store.loadJson(`${ev.market.id}.json`, null);
      if (!paper?.accounts) return null;
      const marketClosed = Object.values(paper.accounts).flatMap((a) => a.closed || []);
      const tf = require('./strategies').tfOf(ev.strategy);
      const sig = { entryT: p.entryT, entry: p.entry, sl: p.initSl ?? p.sl, side: p.side, market: ev.market.id, intraday: tf !== '1d' };
      return require('./aiFilter').judge(cfg, sig, paper.accounts[ev.strategy.id], marketClosed, paper.ctx);
    } catch (err) {
      console.warn('[ftmo] IA validatrice indisponible :', err.message);
      return null;
    }
  }

  /** Clôture d'une position FTMO (gain, solde, plus haut, gain du jour, historique, message). */
  function closeOne(s, k, exit, exitT, reason, out) {
    const p = s.open[k];
    const pnl = pnlAt(p, exit, 2);
    s.balance += pnl;
    s.peak = Math.max(s.peak ?? s.capital, s.balance);
    s.dayPnl = s.dayPnl || {};
    s.dayPnl[s.day] = (s.dayPnl[s.day] || 0) + pnl;
    s.closed.push({ ...p, exit, exitT, pnl, reason });
    delete s.open[k];
    out.push({ type: 'trade', s, p: { ...p, exit, pnl, reason } });
  }

  /**
   * Garde-fous à chaque passage (une clôture manquée ne doit jamais laisser une position FTMO ouverte) :
   *  - stop propre au compte FTMO : cours actuel au-delà du stop → clôture au cours actuel ;
   *  - réconciliation avec le paper trading : la position de la stratégie n'est plus ouverte (même date d'entrée) →
   *    clôture au prix de sortie du trade paper, sinon au cours actuel.
   */
  function reconcile(s, prices, t, out) {
    const papers = {};
    for (const [k, p] of Object.entries(s.open)) {
      const px = prices[p.market];
      if (px && p.sl && (p.side === 'long' ? px <= p.sl : px >= p.sl)) {
        // Au cours actuel (déjà au-delà du stop) : prudent en cas de trou de cotation entre deux passages
        closeOne(s, k, px, t, 'stop loss (compte FTMO)', out);
        continue;
      }
      papers[p.market] ??= store.loadJson(`${p.market}.json`, null);
      const acc = papers[p.market]?.accounts?.[p.sid];
      if (!acc) continue; // stratégie inconnue du paper trading : rien à comparer
      if (acc.position && Math.abs(acc.position.entryT - p.entryT) < 2) continue;
      const tr = [...(acc.closed || [])].reverse().find((c) => Math.abs(c.entryT - p.entryT) < 2);
      if (tr) closeOne(s, k, tr.exit, tr.exitT, `${tr.reason} (réconciliation)`, out);
      else if (px) closeOne(s, k, px, t, 'réconciliation (position paper introuvable)', out);
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
    const aiMode = adapt.aiModeOf(cfg, store); // l'adaptation peut repasser l'IA en observation
    rollDay(s, t);
    if (s.waitDay && s.day !== s.waitDay) s.waitDay = null; // nouveau challenge : reprise le jour suivant

    for (const ev of events) {
      if (!follows(ev)) continue;
      if (ev.type === 'open' && !s.waitDay) {
        const p = ev.pos;
        const stopPct = (Math.abs(p.entry - (p.initSl ?? p.sl)) / p.entry) * 100;
        if (!(stopPct > 0)) continue;
        if (cfg.ftmoDayStop > 0 && s.balance <= s.dayStart - (s.capital * cfg.ftmoDayStop) / 100) continue; // stop du jour maison
        // Pas d'achat et de vente en même temps sur le même marché (FTMO_NO_HEDGE) : le signal opposé est ignoré
        if (cfg.ftmoNoHedge !== false && Object.values(s.open).some((o) => o.market === ev.market.id && o.side !== p.side)) {
          s.skipped = (s.skipped || 0) + 1;
          continue;
        }
        // IA validatrice (src/aiFilter.js, FTMO_AI) : avis sur le signal ; en mode « block », refus sous le seuil
        const ai = aiMode && aiMode !== 'off' ? aiOpinion(ev, p) : null;
        const skey = `${ev.market.id}:${ev.strategy.id}`;
        // Signal jugé mémorisé pour l'apprentissage de l'IA (compte FTMO seulement : Lucid voit les mêmes signaux)
        if (ai && cfg.autoAdapt && A.id !== 'lucid') {
          adapt.recordSignal(store, { market: ev.market.id, sid: ev.strategy.id, entryT: p.entryT, x: ai.x, p: ai.p, ok: ai.ok, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, v: ai.version });
        }
        // Poids appris par l'adaptation (× 0 = stratégie suspendue, × 0,5 réduite, × 1,25 renforcée)
        const wAdapt = adapt.weightOf(cfg, store, skey);
        if (!(wAdapt > 0)) {
          s.suspendedSkip = (s.suspendedSkip || 0) + 1;
          continue;
        }
        // Levier dynamique (src/sizing.js, FTMO_SIZING) : le risque du trade est ajusté selon l'état du compte
        const rule = RULES[cfg.ftmoSizing] || RULES.fixe;
        const mul = rule({ ...p, sid: `${ev.market.id}:${ev.strategy.id}` }, { balance: s.balance, capital: s.capital, dayStart: s.dayStart, target: targetPct(s) ?? Infinity, open: Object.keys(s.open).length });
        if (!(mul > 0)) continue;
        const cap = (P.levCap && P.levCap[ev.market.id]) || cfg.ftmoLeverage; // levier max (par marché sur le compte Swing)
        let notional = Math.min((s.balance * A.riskOf(ev.market.id, ev.strategy) * mul * wAdapt) / stopPct, s.balance * cap);
        let lots = null;
        if (P.contracts) {
          // Futures (Lucid) : contrats entiers de micro-futures, arrondis vers le bas, plafond de contrats ouverts
          const mc = MICRO[ev.market.id];
          if (!mc) continue;
          const used = Object.values(s.open).reduce((a, o) => a + (o.n || 0), 0);
          lots = Math.min(Math.floor(notional / (p.entry * mc.mult)), P.maxContracts - used);
          if (!(lots >= 1)) {
            s.tooSmall = (s.tooSmall || 0) + 1; // risque trop petit pour 1 contrat (ou plafond atteint)
            continue;
          }
          notional = lots * p.entry * mc.mult;
        }
        if (ai && !ai.ok && aiMode === 'block') {
          // Refusé : gardé (avec la taille qu'il aurait eue) pour le bilan des trades refusés
          s.aiRefused = (s.aiRefused || 0) + 1;
          const r = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, entryT: p.entryT, notional, risk: (notional * stopPct) / 100, ai: { p: ai.p, ok: ai.ok, min: ai.min } };
          const list = store.loadJson(refusedFile, []);
          list.push(r);
          store.saveJson(refusedFile, list.slice(-1000));
          out.push({ type: 'refused', s, p: r });
          continue;
        }
        const pos = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, notional, entryT: p.entryT, lev: notional / s.balance, mul, risk: (notional * stopPct) / 100, ...(wAdapt !== 1 ? { wAdapt } : {}), ...(lots ? { n: lots, cfee: MICRO[ev.market.id].fee, contract: MICRO[ev.market.id].name } : {}), ...(ai ? { ai: { p: ai.p, ok: ai.ok, min: ai.min } } : {}) };
        s.open[key(ev.market.id, ev.strategy.id, p.entryT)] = pos;
        if (!s.days.includes(s.day)) s.days.push(s.day);
        out.push({ type: 'open', s, p: pos });
      } else if (ev.type === 'close') {
        const k = key(ev.market.id, ev.strategy.id, ev.trade.entryT);
        if (!s.open[k]) continue;
        closeOne(s, k, ev.trade.exit, ev.trade.exitT, ev.trade.reason, out);
      }
    }
    reconcile(s, prices, t, out);

    // Règles du challenge (positions ouvertes comprises)
    if (s.phase !== 'funded') {
      const eq = equity(s, prices);
      const dFloor = dailyFloor(s);
      const mFloor = maxFloor(s);
      if (eq <= dFloor || eq <= mFloor) {
        closeAll(s, prices, t, `règle ${A.firm || 'FTMO'}`);
        const why = eq <= mFloor
          ? (P.maxUsd ? `perte maximale (${P.maxUsd.toLocaleString('fr-FR')} $ sous le plus haut solde de clôture) atteinte` : `perte maximale (−${P.max} %${P.trailing ? ' depuis le plus haut' : ''}) atteinte`)
          : `perte du jour (−${P.daily} %) atteinte`;
        out.push({ type: 'fail', s: { ...s }, why });
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'échec', why, at: t, balance: s.balance }].slice(-20);
        next.waitDay = dayOf(t);
        save(next);
        return out;
      }
      const goal = s.capital * (1 + targetPct(s) / 100);
      // Règle du meilleur jour (1 étape) : le meilleur jour ne doit pas dépasser P.bestDay % du gain total
      const bestOk = !(P.bestDay > 0) || Math.max(0, ...Object.values(s.dayPnl || {})) <= ((s.balance - s.capital) * P.bestDay) / 100;
      if (s.balance >= goal && !Object.keys(s.open).length && s.days.length >= (P.minDays ?? 4) && bestOk) {
        const done = s.phase;
        s.history = [...(s.history || []), { attempt: s.attempt, phase: done, outcome: 'réussie', at: t, balance: s.balance, days: s.days.length }].slice(-20);
        out.push({ type: 'pass', s: { ...s }, phase: done });
        if (done === 1 && P.steps === 2) {
          Object.assign(s, { phase: 2, balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, peak: s.capital, dayPnl: {} });
        } else {
          Object.assign(s, { phase: 'funded', balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, funded: { since: t }, peak: s.capital, eodPeak: s.capital, dayPnl: {} });
        }
      }
    } else {
      // Compte financé : mêmes limites de perte ; on suit le gain (partage 80 %)
      const eq = equity(s, prices);
      if (eq <= dailyFloor(s) || eq <= maxFloor(s)) {
        closeAll(s, prices, t, `règle ${A.firm || 'FTMO'}`);
        out.push({ type: 'fail', s: { ...s }, why: 'compte financé perdu (limite de perte)' });
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: 'financé', outcome: 'perdu', at: t, balance: s.balance }].slice(-20);
        next.waitDay = dayOf(t);
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
    const tp = targetPct(s);
    const target = tp === null ? null : s.capital * (1 + tp / 100);
    const floor = maxFloor(s);
    return {
      s,
      account: A,
      program: P,
      equity: eq,
      unrealized: eq - s.balance, // gains / pertes des positions encore ouvertes (frais de sortie inclus)
      realized: s.balance - s.capital, // gains / pertes des trades clôturés
      openPnl: (p) => (prices[p.market] ? pnlAt(p, prices[p.market], 1) : null),
      target,
      targetPct: tp,
      floor,
      progress: target ? Math.max(0, (eq - s.capital) / (target - s.capital)) : null,
      dailyUsed: Number.isFinite(P.daily) ? Math.max(0, (s.dayStart - eq) / ((s.capital * P.daily) / 100)) : 0,
      maxUsed: P.maxUsd ? Math.max(0, 1 - (eq - floor) / P.maxUsd) : Math.max(0, ((P.trailing ? s.peak ?? s.capital : s.capital) - eq) / ((s.capital * P.max) / 100)),
      wins: s.closed.filter((c) => c.pnl > 0).length,
      trades: s.closed.length,
    };
  }

  return { onCycle, status, load, refusedReport, account: A, reset: () => save(fresh()) };
}

module.exports = { createFtmo, accountOf, ftmoAccounts, TARGET, PROGRAMS, programOf, MICRO, lucidProgram };
