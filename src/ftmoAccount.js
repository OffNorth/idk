/**
 * Compte FTMO simulé en direct (paper trading) : suit les trades de certaines stratégies du bot, avec une taille
 * calculée au risque, et applique les règles du challenge FTMO en 2 étapes (voir src/ftmo.js).
 *   Étape 1 : +10 % · Étape 2 : +5 % · puis compte « financé » (on suit les gains mensuels, partage 80 %).
 *   Échec si la perte du jour atteint 5 % du capital initial (sous le solde de la veille, positions comprises)
 *   ou si le compte perd 10 % du capital initial. Après un échec, un nouveau challenge démarre le jour de trading suivant.
 * Deux comptes indépendants : « gold » (data/ftmo.json, stratégies FTMO_STRATEGIES) et « nas100 »
 * (data/ftmo-nas.json, stratégies FTMO_NAS_STRATEGIES).
 */
const { ftmoDay, cmeDay, effectiveTarget } = require('./ftmo');
const { RULES } = require('./sizing');

/**
 * Micro-futures CME (compte Lucid) : valeur d'un contrat = prix × mult ; frais aller-retour par contrat
 * (commission ≈ 1,5 $ + 1 tick de glissement par côté). Cours en direct : or GC=F, Nasdaq ^NDX, S&P ^GSPC, EUR/USD.
 */
const MICRO = {
  gold: { mult: 10, fee: 3.5, name: 'MGC' }, // 10 onces
  nas100: { mult: 2, fee: 2.5, name: 'MNQ' }, // 2 $ par point
  spx: { mult: 5, fee: 4, name: 'MES' }, // 5 $ par point
  eurusd: { mult: 125_000, fee: 17, name: '6E' }, // 125 000 € : Lucid n'a pas le micro M6E (produits autorisés, nov. 2026)
  silver: { mult: 1000, fee: 3.5, name: 'SIL' }, // 1 000 onces (cours SI=F en $ / once)
  dow: { mult: 0.5, fee: 2.5, name: 'MYM' }, // 0,5 $ par point
  russell: { mult: 5, fee: 2.5, name: 'M2K' }, // 5 $ par point
};

/**
 * Évaluation LucidFlex (sources secondaires nov. 2026, à vérifier sur le site de Lucid) : +6 %, pas de perte du jour
 * (option payante, « souple »), perte max 2 000 $ (50K) / 3 000 $ (100K) suiveuse en fin de journée (séance CME, 17 h
 * New York), bloquée à capital + 100 $, meilleur jour ≤ 40 % du gain (évaluation seulement), micro-futures en contrats
 * entiers (40 / 60 au plus), pas d'achat et de vente en même temps (couverture interdite).
 * Compte financé : pas de règle de régularité ; retrait après 5 jours gagnants ≥ 150 $, ≤ 50 % du gain et ≤ 2 000 /
 * 3 000 $, 500 $ au moins, 90 % pour le trader.
 */
const lucidProgram = (capital, cfg = {}) => ({
  key: `lucid${Math.round(capital / 1000)}k`, label: 'LucidFlex evaluation', firm: 'Lucid', steps: 1, target: 6, daily: Infinity,
  maxUsd: capital > 75_000 ? 3000 : 2000, lockAt: 100, eod: true, bestDay: cfg.lucidConsistency ?? 40, minDays: 2, contracts: true,
  maxContracts: capital > 75_000 ? 60 : 40, levCap: null, split: 90,
  payout: { rule: 'lucid', cycleDays: 5, minDay: cfg.lucidPayoutMinDay ?? 150, share: 0.5, cap: capital > 75_000 ? 3000 : 2000, min: 500 },
});
/** Retraits FTMO (compte financé) : tout le gain tous les 14 jours, 80 % pour le trader, le compte repart du capital. */
const FTMO_PAYOUT = { rule: 'ftmo', every: 14 };

const LUCID_FUNDED_FILE = 'lucid-funded.json';
/**
 * Réglages d'un compte simulé : 'gold' (FTMO, or ou compte combiné), 'nas100' (FTMO Nasdaq), 'lucid' (LucidFlex,
 * évaluation) ou 'lucidf' (compte Lucid financé qui tourne à part, LUCID_PARALLEL).
 */
function accountOf(cfg, id = 'gold') {
  if (id === 'lucidf') {
    const L = accountOf(cfg, 'lucid');
    return { ...L, id: 'lucidf', label: `${L.label} funded`, file: LUCID_FUNDED_FILE, fundedOnly: true, enabled: L.enabled && !!cfg.lucidParallel };
  }
  if (id === 'lucid') {
    // Mêmes stratégies et mêmes risques que le compte FTMO combiné (× LUCID_RISK_MUL), règles et contrats Lucid
    // (FTMO_RISK_MUL ne s'applique pas à Lucid : il a son propre multiplicateur LUCID_RISK_MUL)
    const base = accountOf({ ...cfg, ftmoCombined: true, ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1 }, 'gold');
    const excluded = new Set(cfg.lucidExclude || []);
    const capital = cfg.lucidCapital || 50_000;
    const mul = cfg.lucidRiskMul ?? 1;
    return {
      ...base, id: 'lucid', firm: 'Lucid', label: `LucidFlex ${Math.round(capital / 1000)}K`, emoji: '🟣', file: 'lucid.json',
      // + ses stratégies intraday propres (variantes « objectif 0,5 R »), que le compte FTMO ne suit pas
      // − LUCID_EXCLUDE (stratégies du compte FTMO que Lucid ne prend pas)
      strategies: [...new Set([...base.strategies, ...(cfg.lucidIntradayStrategies || []), ...(cfg.lucidDailyStrategies || [])])].filter((k) => !excluded.has(k)),
      enabled: !!(cfg.ftmoEnabled && cfg.lucidEnabled), capital, program: lucidProgram(capital, cfg),
      // Intraday : seulement LUCID_INTRADAY_STRATEGIES, à LUCID_INTRADAY_RISK_PCT (× LUCID_EVAL_INTRADAY_MUL pendant
      // l'évaluation : phase ≠ 'funded') ; journalières : risque FTMO × LUCID_RISK_MUL
      riskOf: (m, st, phase) => (st && excluded.has(`${m}:${st.id}`) ? 0
        : st && st.tf && st.tf !== '1d'
          ? ((cfg.lucidIntradayStrategies || []).includes(`${m}:${st.id}`) ? (cfg.lucidIntradayRisk ?? 0) * (phase === 'funded' ? 1 : cfg.lucidEvalIntradayMul ?? 1) : 0)
          : base.riskOf(m, st) * mul),
    };
  }
  if (id === 'nas100') {
    const risk = cfg.ftmoNasRisk * (cfg.ftmoRiskMul ?? 1);
    return { id, label: 'Nasdaq', emoji: '🇺🇸', file: 'ftmo-nas.json', enabled: cfg.ftmoEnabled && cfg.ftmoNasEnabled && !cfg.ftmoCombined, strategies: cfg.ftmoNasStrategies, risk, riskOf: () => risk };
  }
  if (cfg.ftmoCombined) {
    // Compte unique or + Nasdaq (npm run ftmo-combo) : chaque marché garde son propre risque par trade
    return {
      id: 'gold', firm: 'FTMO', label: 'Gold + Nasdaq + EUR/USD', emoji: '🌍', file: 'ftmo.json', enabled: cfg.ftmoEnabled,
      strategies: [...cfg.ftmoStrategies, ...cfg.ftmoNasStrategies], risk: cfg.ftmoRisk,
      // Stratégies intraday (tf ≠ 1d) : risque propre (FTMO_INTRADAY_RISK_PCT), plus petit que celui des journalières
      // × FTMO_RISK_MUL (1,25 : challenge ≈ 2–3 semaines plus rapide, npm run speed)
      // Réglage « comme Lucid » (npm run ftmo-lucidlike) : intraday × FTMO_EVAL_INTRADAY_MUL pendant l'évaluation ;
      // compte financé : tout × FTMO_FUNDED_RISK_MUL (le compte dure et décroche les hausses de capital)
      riskOf: (marketId, strat, phase) => {
        const intra = !!(strat && strat.tf && strat.tf !== '1d');
        const r = (cfg.ftmoRiskMul ?? 1) * (intra && cfg.ftmoIntradayRisk ? cfg.ftmoIntradayRisk
          : marketId === 'nas100' ? cfg.ftmoComboNasRisk : marketId === 'eurusd' ? cfg.ftmoEurRisk ?? cfg.ftmoRisk : marketId === 'spx' ? cfg.ftmoSpxRisk ?? cfg.ftmoRisk : cfg.ftmoRisk);
        if (phase === 'funded') return r * (cfg.ftmoFundedRiskMul ?? 1);
        return r * (intra && phase !== undefined ? cfg.ftmoEvalIntradayMul ?? 1 : 1);
      },
    };
  }
  return { id: 'gold', label: 'Gold', emoji: '🥇', file: 'ftmo.json', enabled: cfg.ftmoEnabled, strategies: cfg.ftmoStrategies, risk: cfg.ftmoRisk, riskOf: () => cfg.ftmoRisk * (cfg.ftmoRiskMul ?? 1) };
}
/** Comptes FTMO actifs. */
const ftmoAccounts = (cfg) => ['nas100', 'gold', 'lucidf', 'lucid'].map((id) => accountOf(cfg, id)).filter((a) => a.enabled);
const TARGET = { 1: 10, 2: 5 };

/**
 * Formules FTMO (FTMO_PROGRAM) — règles 2026 d'après des sources secondaires, à vérifier sur le site de FTMO :
 *   2step : +10 % puis +5 %, perte du jour 5 %, perte max 10 % fixe
 *   swing : idem, levier max 1:10 sur l'or et les indices (1:30 sur le forex)
 *   1step : +10 % en une étape, perte du jour 3 %, perte max 10 % suiveuse (depuis le plus haut solde),
 *           meilleur jour ≤ 50 % du gain total
 */
const PROGRAMS = {
  '2step': { label: '2-step challenge', steps: 2, daily: 5, max: 10, trailing: false, bestDay: 0, levCap: null },
  swing: { label: '2-step Swing challenge', steps: 2, daily: 5, max: 10, trailing: false, bestDay: 0, levCap: { gold: 10, nas100: 10, spx: 10, eurusd: 30 } },
  '1step': { label: '1-step challenge', steps: 1, daily: 3, max: 10, trailing: true, bestDay: 50, levCap: null },
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
  /** Meilleur jour du challenge en cours ($). */
  const bestDayOf = (s) => Math.max(0, ...Object.values(s.dayPnl || {}));
  /** Objectif à vraiment atteindre (%) : relevé par la règle du meilleur jour après un gros jour. */
  const effTarget = (s) => (targetPct(s) === null ? null : effectiveTarget(targetPct(s), P.bestDay, s.capital, bestDayOf(s)));
  /** Seuil de perte max : Lucid = plus haut solde de clôture − perte max ($), bloqué à capital + 100 $ ; FTMO = 10 %. */
  const maxFloor = (s) => (P.maxUsd
    ? Math.min((s.eodPeak ?? s.capital) - P.maxUsd, s.capital + (P.lockAt ?? Infinity))
    : (P.trailing ? s.peak ?? s.capital : s.capital) - (s.capital * P.max) / 100);
  const dailyFloor = (s) => (Number.isFinite(P.daily) ? s.dayStart - (s.capital * P.daily) / 100 : -Infinity);
  const load = () => {
    const s = store.loadJson(FILE, null);
    if (!s || !s.capital) return fresh();
    if (s.dormant) return { ...fresh(s.attempt || 1), ...s }; // compte financé à part en sommeil : rien à réinterpréter
    // Changement de formule (FTMO_PROGRAM) : nouveau challenge, l'ancien reste dans l'historique
    if ((s.program || '2step') !== PKEY) {
      archive(s);
      const next = fresh((s.attempt || 0) + 1);
      next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: `stopped (switch to ${P.label.toLowerCase()})`, at: Math.floor(Date.now() / 1000), balance: s.balance }].slice(-20);
      return next;
    }
    return s;
  };
  const save = (s) => store.saveJson(FILE, s);
  const ARCHIVE = FILE.replace(/\.json$/, '-archive.json');
  /** Garde les trades clôturés d'un challenge (ou d'une étape) qui se termine : <compte>-archive.json, 3 000 au plus. */
  const archive = (s) => {
    if (!s?.closed?.length) return;
    const list = store.loadJson(ARCHIVE, []);
    const k = (t) => `${t.attempt}:${t.market}:${t.sid}:${t.entryT}:${t.exitT}`;
    const seen = new Set(list.map(k));
    const add = s.closed.map((t) => ({ ...t, attempt: s.attempt, phase: s.phase })).filter((t) => !seen.has(k(t)));
    if (!add.length) return;
    list.push(...add);
    store.saveJson(ARCHIVE, list.slice(-3000));
  };
  const adapt = require('./adapt');
  // Stratégies suivies + candidates promues par l'adaptation automatique (AUTO_ADAPT)
  const follows = (ev) => A.strategies.includes(`${ev.market.id}:${ev.strategy.id}`) || adapt.promotedOf(cfg, store).includes(`${ev.market.id}:${ev.strategy.id}`);
  const key = (marketId, sid, entryT) => `${marketId}:${sid}:${entryT}`;
  const fee = (marketId) => (marketId === 'nas100' ? cfg.ftmoFeeNas : cfg.ftmoFeeGold);
  /** Frais d'une position : par contrat (futures, Lucid) ou en % du montant (CFD, FTMO) ; sides = 1 (sortie) ou 2. */
  const costOf = (p, sides) => (p.n ? (p.n * p.cfee * sides) / 2 : (p.notional * sides * fee(p.market)) / 100);
  const pnlAt = (p, px, sides) => p.notional * (p.side === 'long' ? 1 : -1) * (px / p.entry - 1) - costOf(p, sides);

  /** Nouveau jour de trading : solde de clôture de la veille ; retourne le jour qui se termine (ou null). */
  function rollDay(s, t) {
    const d = dayOf(t);
    if (s.day !== d) {
      const prev = s.day;
      if (s.day) s.eodPeak = Math.max(s.eodPeak ?? s.capital, s.balance); // solde de clôture de la journée précédente
      s.day = d;
      s.dayStart = s.balance;
      s.dayLosses = 0;
      return prev;
    }
    return null;
  }

  const PAY = P.payout || FTMO_PAYOUT;
  /**
   * Retrait simulé du compte financé, décidé à la clôture d'une journée (positions toutes fermées) :
   *  - Lucid : après PAY.cycleDays jours gagnants ≥ PAY.minDay $, retrait ≤ PAY.share du gain et ≤ PAY.cap $ (≥ PAY.min $) ;
   *  - FTMO : tout le gain tous les 14 jours, le compte repart du capital.
   */
  function payoutCheck(s, prevDay, t, out) {
    s.funded = s.funded || { since: t };
    const f = s.funded;
    f.payouts = f.payouts || [];
    const gain = s.balance - s.capital;
    let amount = 0;
    if (PAY.rule === 'lucid') {
      if ((s.dayPnl?.[prevDay] || 0) >= PAY.minDay) f.good = (f.good || 0) + 1;
      if ((f.good || 0) < PAY.cycleDays || gain <= 0 || Object.keys(s.open).length) return;
      amount = Math.min(gain * PAY.share, PAY.cap);
      if (amount < (PAY.min || 0)) return;
      f.good = 0;
    } else {
      const last = f.payouts.length ? f.payouts[f.payouts.length - 1].t : f.since;
      if (t - last < PAY.every * 86400 || gain <= 0 || Object.keys(s.open).length) return;
      amount = gain;
    }
    amount = Math.round(amount * 100) / 100;
    const trader = Math.round(amount * (P.split || 80)) / 100;
    s.balance -= amount;
    s.dayStart = s.balance;
    if (PAY.rule !== 'lucid') s.peak = s.balance; // FTMO : le compte repart du capital
    f.payouts.push({ t, amount, trader });
    f.paid = (f.paid || 0) + amount;
    f.traderPaid = (f.traderPaid || 0) + trader;
    out.push({ type: 'payout', s, amount, trader, total: f.traderPaid, n: f.payouts.length });
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

  /** Clôture de toutes les positions (limite de perte atteinte) : chaque clôture est annoncée comme une autre. */
  function closeAll(s, prices, t, reason, out = null) {
    for (const [k, p] of Object.entries(s.open)) {
      const px = prices[p.market] || p.entry;
      const pnl = pnlAt(p, px, 2);
      s.balance += pnl;
      s.dayPnl = s.dayPnl || {};
      s.dayPnl[s.day] = (s.dayPnl[s.day] || 0) + pnl;
      const done = { ...p, exit: px, exitT: t, pnl, reason };
      s.closed.push(done);
      delete s.open[k];
      if (out) out.push({ type: 'trade', s, p: done });
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

  /**
   * Signaux refusés par l'IA dont le trade fictif (paper) vient de se terminer : bilan à annoncer, une seule fois
   * (« l'IA a eu raison / tort »). Seulement les refus enregistrés avec `watch` (pas d'annonce en rafale des anciens) ;
   * abandon après 30 jours.
   */
  function refusedVerdicts(t) {
    const list = store.loadJson(refusedFile, []);
    if (!list.some((r) => r.watch && !r.told)) return [];
    const papers = {};
    const res = [];
    for (const r of list) {
      if (!r.watch || r.told) continue;
      papers[r.market] ??= store.loadJson(`${r.market}.json`, null);
      const done = (papers[r.market]?.accounts?.[r.sid]?.closed || []).find((c) => Math.abs(c.entryT - r.entryT) < 2);
      if (done) { r.told = true; res.push({ ...r, pnl: (r.notional * done.pnlPct) / 100, exit: done.exit, exitT: done.exitT, reason: done.reason }); }
      else if (t - r.entryT > 30 * 86400) r.told = true;
    }
    store.saveJson(refusedFile, list);
    return res;
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
  function closeOne(s, k, exit, exitT, reason, out, signalExit = null) {
    const p = s.open[k];
    const pnl = pnlAt(p, exit, 2);
    s.balance += pnl;
    s.peak = Math.max(s.peak ?? s.capital, s.balance);
    s.dayPnl = s.dayPnl || {};
    s.dayPnl[s.day] = (s.dayPnl[s.day] || 0) + pnl;
    if (pnl < 0) s.dayLosses = (s.dayLosses || 0) + 1;
    const done = { ...p, exit, exitT, pnl, reason, ...(signalExit && signalExit !== exit ? { signalExit } : {}) };
    s.closed.push(done);
    delete s.open[k];
    out.push({ type: 'trade', s, p: done });
  }

  /**
   * Garde-fous à chaque passage (une clôture manquée ne doit jamais laisser une position FTMO ouverte) :
   *  - stop propre au compte FTMO : cours actuel au-delà du stop → clôture au cours actuel ;
   *  - réconciliation avec le paper trading : la position de la stratégie n'est plus ouverte (même date d'entrée) →
   *    clôture au prix de sortie du trade paper, sinon au cours actuel.
   */
  function reconcile(s, prices, t, out) {
    const papers = {};
    // Stop suiveur du compte FTMO (npm run ftmo-tsl) : dès que le meilleur cours de clôture des bougies de la stratégie
    // (suivi par le paper trading) a fait +FTMO_TRAIL_ACT_R × le risque initial, le stop suit à FTMO_TRAIL_DIST_R × le
    // risque de ce meilleur cours ; il ne recule jamais. Lucid n'est pas concerné.
    const trailAct = A.firm !== 'Lucid' ? cfg.ftmoTrailActR || 0 : 0;
    for (const [k, p] of Object.entries(s.open)) {
      const px = prices[p.market];
      papers[p.market] ??= store.loadJson(`${p.market}.json`, null);
      const acc = papers[p.market]?.accounts?.[p.sid];
      const paperPos = acc?.position && Math.abs(acc.position.entryT - p.entryT) < 2 ? acc.position : null;
      // Compte financé FTMO : sorties partielles (FTMO_FUNDED_PARTIALS, en R) — à chaque niveau atteint, une part égale de
      // la position d'origine est fermée au niveau (ordre limite) ; le reste suit le stop suiveur (npm run ftmo-partial)
      if (A.firm !== 'Lucid' && s.phase === 'funded' && (cfg.ftmoFundedPartials || []).length && p.sl) {
        p.sl0 ??= p.sl;
        p.notional0 ??= p.notional;
        const r0 = Math.abs(p.entry - p.sl0);
        const long = p.side === 'long';
        const levels = cfg.ftmoFundedPartials.map(Number).filter((x) => x > 0);
        const share = 1 / (levels.length + 1);
        p.partsDone = p.partsDone || [];
        const reach = long ? Math.max(px || -Infinity, paperPos?.best ?? -Infinity) : Math.min(px || Infinity, paperPos?.best ?? Infinity);
        for (const lv of levels) {
          if (p.partsDone.includes(lv) || !(r0 > 0)) continue;
          const target = long ? p.entry + lv * r0 : p.entry - lv * r0;
          if (long ? reach < target : reach > target) continue;
          const part = Math.min(p.notional, p.notional0 * share);
          const piece = { ...p, notional: part, risk: (p.risk || 0) * (part / p.notional) };
          const pnl = pnlAt(piece, target, 2);
          s.balance += pnl;
          s.peak = Math.max(s.peak ?? s.capital, s.balance);
          s.dayPnl = s.dayPnl || {};
          s.dayPnl[s.day] = (s.dayPnl[s.day] || 0) + pnl;
          const done = { ...piece, exit: target, exitT: t, pnl, reason: `partial target +${lv} R` };
          s.closed.push(done);
          out.push({ type: 'trade', s, p: done });
          p.risk = (p.risk || 0) * (1 - part / p.notional);
          p.notional -= part;
          p.partsDone.push(lv);
        }
      }
      if (trailAct > 0 && p.sl && paperPos && Number.isFinite(paperPos.best)) {
        p.sl0 ??= p.sl;
        const r0 = Math.abs(p.entry - p.sl0);
        const long = p.side === 'long';
        p.best = long ? Math.max(p.best ?? p.entry, paperPos.best) : Math.min(p.best ?? p.entry, paperPos.best);
        const fav = long ? p.best - p.entry : p.entry - p.best;
        if (r0 > 0 && fav >= trailAct * r0) {
          const next = long ? p.best - (cfg.ftmoTrailDistR ?? 1) * r0 : p.best + (cfg.ftmoTrailDistR ?? 1) * r0;
          if (long ? next > p.sl : next < p.sl) { p.sl = next; p.trailing = true; }
        }
      }
      if (px && p.sl && (p.side === 'long' ? px <= p.sl : px >= p.sl)) {
        // Stop suiveur : ordre stop posé au niveau ; stop initial : au cours actuel (déjà au-delà, prudent en cas de trou)
        if (p.trailing) closeOne(s, k, p.sl, t, 'trailing stop (FTMO account)', out);
        else closeOne(s, k, px, t, 'stop loss (FTMO account)', out);
        continue;
      }
      if (!acc) continue; // stratégie inconnue du paper trading : rien à comparer
      if (acc.position && Math.abs(acc.position.entryT - p.entryT) < 2) continue;
      const tr = [...(acc.closed || [])].reverse().find((c) => Math.abs(c.entryT - p.entryT) < 2);
      if (tr) closeOne(s, k, tr.exit, tr.exitT, `${tr.reason} (reconciliation)`, out);
      else if (px) closeOne(s, k, px, t, 'reconciliation (paper position not found)', out);
    }
  }

  /**
   * Traite les événements du passage et vérifie les règles. Retourne les messages à publier.
   * prices : { gold: cours, nas100: cours }
   */
  /** Compte financé à part (lucidf) : actif seulement entre la réussite d'une évaluation et sa perte. */
  const asleep = () => { if (!A.fundedOnly) return false; const x = store.loadJson(FILE, null); return !x || x.dormant || x.phase !== 'funded'; };

  /** Compte Lucid financé à part : démarré directement en compte financé (sans évaluation). */
  const startFunded = (t, extra = {}) => {
    const prev = store.loadJson(FILE, null);
    if (prev && !prev.dormant && prev.phase === 'funded') archive(prev);
    const s = { ...fresh(prev?.attempt ? prev.attempt + 1 : 1), phase: 'funded', startedAt: t, funded: { since: t, direct: true }, history: (prev?.history || []).slice(-20), ...extra };
    save(s);
    return s;
  };

  function onCycle(events, prices, t = Math.floor(Date.now() / 1000), { fills = null } = {}) {
    // LUCID_FUNDED_DIRECT : le compte financé à part démarre tout de suite s'il n'a jamais existé
    const direct = A.enabled && A.fundedOnly && cfg.lucidFundedDirect && !store.loadJson(FILE, null);
    if (direct) startFunded(t);
    if (!A.enabled || asleep()) return [];
    const s = load();
    const out = [];
    if (direct) out.push({ type: 'fundedStart', s: { ...s } });
    for (const v of refusedVerdicts(t)) out.push({ type: 'refusedResult', s, p: v });
    let aiMode = adapt.aiModeOf(cfg, store); // l'adaptation peut repasser l'IA en observation
    // Lucid : l'IA ne refuse rien par défaut (LUCID_AI=observe, voir config.js) ; avis toujours affiché
    if (A.firm === 'Lucid' && aiMode && aiMode !== 'off') aiMode = cfg.lucidAi === 'block' ? aiMode : cfg.lucidAi === 'off' ? 'off' : 'observe';
    const prevDay = rollDay(s, t);
    if (prevDay && s.phase === 'funded') payoutCheck(s, prevDay, t, out);
    if (s.waitDay && s.day !== s.waitDay) s.waitDay = null; // nouveau challenge : reprise le jour suivant

    for (const ev of events) {
      if (!follows(ev)) continue;
      if (ev.type === 'open' && !s.waitDay) {
        const p = ev.pos;
        // Exécution FILL_DELAY_SEC secondes après le signal (cours de ce moment-là) ; le stop reste au même niveau
        const fill = fills?.[ev.market.id];
        const entry = fill?.price || p.entry;
        const sl = p.initSl ?? p.sl;
        if (fill && (p.side === 'long' ? entry <= sl : entry >= sl)) {
          s.missed = (s.missed || 0) + 1; // le cours a déjà dépassé le stop pendant le délai : pas de trade
          continue;
        }
        const stopPct = (Math.abs(entry - sl) / entry) * 100;
        if (!(stopPct > 0)) continue;
        if (cfg.ftmoDayStop > 0 && s.balance <= s.dayStart - (s.capital * cfg.ftmoDayStop) / 100) continue; // stop du jour maison
        // Lucid, pendant l'évaluation (npm run lucid-research5) : journée finie dès que le gain du jour atteint
        // LUCID_DAY_PROFIT_CAP_PCT % de l'objectif ou après LUCID_MAX_LOSSES_DAY trade(s) perdant(s)
        // FTMO pendant l'évaluation, même gestion (FTMO_DAY_PROFIT_CAP_PCT, FTMO_MAX_LOSSES_DAY ; npm run ftmo-lucidlike)
        if (s.phase !== 'funded') {
          const lucid = A.firm === 'Lucid';
          const capPct = lucid ? cfg.lucidDayProfitCapPct : cfg.ftmoDayProfitCapPct;
          const maxL = lucid ? cfg.lucidMaxLossesDay : cfg.ftmoMaxLossesDay;
          const cap = ((capPct ?? 0) / 100) * s.capital * ((P.target ?? TARGET[s.phase] ?? 10) / 100);
          if (cap > 0 && s.balance - s.dayStart >= cap) { s.dayCapped = (s.dayCapped || 0) + 1; continue; }
          if ((maxL ?? 0) > 0 && (s.dayLosses || 0) >= maxL) { s.dayCapped = (s.dayCapped || 0) + 1; continue; }
        }
        // Pas d'achat et de vente en même temps sur le même marché (FTMO_NO_HEDGE) : le signal opposé est ignoré
        if (cfg.ftmoNoHedge !== false && Object.values(s.open).some((o) => o.market === ev.market.id && o.side !== p.side)) {
          s.skipped = (s.skipped || 0) + 1;
          continue;
        }
        // IA validatrice (src/aiFilter.js, FTMO_AI) : avis sur le signal ; en mode « block », refus sous le seuil
        const ai = aiMode && aiMode !== 'off' ? aiOpinion(ev, p) : null;
        const skey = `${ev.market.id}:${ev.strategy.id}`;
        // Signal jugé mémorisé pour l'apprentissage de l'IA (compte FTMO seulement : Lucid voit les mêmes signaux)
        if (ai && cfg.autoAdapt && A.firm !== 'Lucid') {
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
        const mul = rule({ ...p, sid: `${ev.market.id}:${ev.strategy.id}` }, { balance: s.balance, capital: s.capital, dayStart: s.dayStart, target: effTarget(s) ?? Infinity, open: Object.keys(s.open).length });
        if (!(mul > 0)) continue;
        // levier max (par marché sur le compte Swing ; actions / ETF : 1:5 chez FTMO)
        const cap = Math.min((P.levCap && P.levCap[ev.market.id]) || cfg.ftmoLeverage, require('./stocks').STOCKS[ev.market.id] ? require('./stocks').STOCK_LEVERAGE : Infinity);
        const riskPct = A.riskOf(ev.market.id, ev.strategy, s.phase);
        if (!(riskPct > 0)) continue; // stratégie non prise par ce compte (ex. intraday sur Lucid)
        let notional = Math.min((s.balance * riskPct * mul * wAdapt) / stopPct, s.balance * cap);
        let lots = null;
        if (P.contracts) {
          // Futures (Lucid) : contrats entiers de micro-futures, arrondis vers le bas, plafond de contrats ouverts
          const mc = MICRO[ev.market.id];
          if (!mc) continue;
          const used = Object.values(s.open).reduce((a, o) => a + (o.n || 0), 0);
          const room = P.maxContracts - used;
          lots = Math.min(Math.floor(notional / (entry * mc.mult)), room);
          if (!(lots >= 1) && room >= 1) {
            // Risque prévu trop petit pour 1 contrat : 1 micro quand même si son risque reste raisonnable
            // (≤ 1,5 × le risque prévu et ≤ 40 % de la perte max) ; sinon le signal est trop gros pour ce compte
            const oneRisk = (entry * mc.mult * stopPct) / 100;
            const want = (notional * stopPct) / 100;
            if (oneRisk <= Math.min(1.5 * want, 0.4 * (P.maxUsd || Infinity))) lots = 1;
            else {
              s.tooBig = (s.tooBig || 0) + 1;
              s.tooBigBy = s.tooBigBy || {};
              s.tooBigBy[skey] = Math.round(oneRisk);
              continue;
            }
          }
          if (!(lots >= 1)) {
            s.tooSmall = (s.tooSmall || 0) + 1; // plafond de contrats atteint
            continue;
          }
          notional = lots * entry * mc.mult;
        }
        if (ai && !ai.ok && aiMode === 'block') {
          // Refusé : gardé (avec la taille qu'il aurait eue) pour le bilan des trades refusés
          s.aiRefused = (s.aiRefused || 0) + 1;
          const r = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry: p.entry, sl: p.initSl ?? p.sl, entryT: p.entryT, notional, risk: (notional * stopPct) / 100, ai: { p: ai.p, ok: ai.ok, min: ai.min }, watch: true };
          const list = store.loadJson(refusedFile, []);
          list.push(r);
          store.saveJson(refusedFile, list.slice(-1000));
          out.push({ type: 'refused', s, p: r });
          continue;
        }
        const pos = { market: ev.market.id, sid: ev.strategy.id, name: ev.strategy.name, side: p.side, entry, sl, notional, entryT: p.entryT, ...(Number.isFinite(p.tp) ? { tp0: p.tp } : {}), ...(fill ? { signal: p.entry, fillT: fill.t } : {}), lev: notional / s.balance, mul, risk: (notional * stopPct) / 100, ...(wAdapt !== 1 ? { wAdapt } : {}), ...(lots ? { n: lots, cfee: MICRO[ev.market.id].fee, contract: MICRO[ev.market.id].name } : {}), ...(ai ? { ai: { p: ai.p, ok: ai.ok, min: ai.min } } : {}) };
        s.open[key(ev.market.id, ev.strategy.id, p.entryT)] = pos;
        if (!s.days.includes(s.day)) s.days.push(s.day);
        out.push({ type: 'open', s, p: pos });
      } else if (ev.type === 'close') {
        const k = key(ev.market.id, ev.strategy.id, ev.trade.entryT);
        if (!s.open[k]) continue;
        // Stop / objectif : ordre posé à l'avance, exécuté au niveau ; autre sortie (signal, fin de séance…) : ordre au
        // marché, exécuté FILL_DELAY_SEC secondes plus tard au cours de ce moment-là
        const fill = fills?.[ev.market.id];
        const resting = /^(stop loss|take profit)$/.test(ev.trade.reason || '');
        if (fill && !resting) closeOne(s, k, fill.price, fill.t, ev.trade.reason, out, ev.trade.exit);
        else closeOne(s, k, ev.trade.exit, ev.trade.exitT, ev.trade.reason, out);
      }
    }
    reconcile(s, prices, t, out);

    // Règles du challenge (positions ouvertes comprises)
    if (s.phase !== 'funded') {
      const eq = equity(s, prices);
      const dFloor = dailyFloor(s);
      const mFloor = maxFloor(s);
      if (eq <= dFloor || eq <= mFloor) {
        closeAll(s, prices, t, `${A.firm || 'FTMO'} rule`, out);
        const why = eq <= mFloor
          ? (P.maxUsd ? `max loss ($${P.maxUsd.toLocaleString('en-US')} below the highest closing balance) hit` : `max loss (−${P.max}%${P.trailing ? ' from the high' : ''}) hit`)
          : `daily loss (−${P.daily}%) hit`;
        out.push({ type: 'fail', s: { ...s }, why });
        archive(s);
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'failed', why, at: t, balance: s.balance }].slice(-20);
        next.waitDay = dayOf(t);
        save(next);
        return out;
      }
      const goal = s.capital * (1 + targetPct(s) / 100);
      // Règle du meilleur jour (1 étape) : le meilleur jour ne doit pas dépasser P.bestDay % du gain total
      const bestOk = !(P.bestDay > 0) || Math.max(0, ...Object.values(s.dayPnl || {})) <= ((s.balance - s.capital) * P.bestDay) / 100;
      if (s.balance >= goal && !Object.keys(s.open).length && s.days.length >= (P.minDays ?? 4) && bestOk) {
        const done = s.phase;
        s.history = [...(s.history || []), { attempt: s.attempt, phase: done, outcome: 'passed', at: t, balance: s.balance, days: s.days.length }].slice(-20);
        if (!(A.id === 'lucid' && cfg.lucidParallel && !(done === 1 && P.steps === 2))) out.push({ type: 'pass', s: { ...s }, phase: done });
        if (done === 1 && P.steps === 2) {
          archive(s);
          Object.assign(s, { phase: 2, balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, peak: s.capital, dayPnl: {} });
        } else if (A.id === 'lucid' && cfg.lucidParallel) {
          // Lucid : le compte financé tourne à part (lucid-funded.json, 1 seul à la fois) ; nouvelle évaluation dès demain
          archive(s);
          const prev = store.loadJson(LUCID_FUNDED_FILE, null);
          const busy = !!(prev && !prev.dormant && prev.phase === 'funded');
          if (!busy) {
            store.saveJson(LUCID_FUNDED_FILE, { ...fresh(s.attempt), phase: 'funded', startedAt: t, funded: { since: t }, fromAttempt: s.attempt,
              history: [...(prev?.history || [])].slice(-20) });
          }
          out.push({ type: 'parallel', s: { ...s }, kept: !busy, next: s.attempt + 1 });
          const next = fresh(s.attempt + 1);
          next.history = (s.history || []).slice(-20);
          next.waitDay = dayOf(t);
          for (const k of Object.keys(s)) delete s[k];
          Object.assign(s, next);
        } else {
          archive(s);
          Object.assign(s, { phase: 'funded', balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, funded: { since: t }, peak: s.capital, eodPeak: s.capital, dayPnl: {} });
        }
      }
    } else {
      // Compte financé : mêmes limites de perte ; on suit le gain (partage 80 %)
      const eq = equity(s, prices);
      if (eq <= dailyFloor(s) || eq <= maxFloor(s)) {
        closeAll(s, prices, t, `${A.firm || 'FTMO'} rule`, out);
        const paidTxt = s.funded?.traderPaid ? ` after ${s.funded.payouts.length} payout${s.funded.payouts.length > 1 ? 's' : ''} ($${Math.round(s.funded.traderPaid).toLocaleString('en-US')} for you)` : ' with no payout';
        out.push({ type: 'fail', s: { ...s }, why: `funded account lost (loss limit)${paidTxt}` });
        archive(s);
        if (A.fundedOnly) {
          // Compte financé à part : en sommeil jusqu'à la prochaine évaluation réussie
          save({ dormant: true, program: PKEY, attempt: s.attempt, capital: s.capital, balance: s.balance, history: [...(s.history || []), { attempt: s.attempt, phase: 'funded', outcome: 'lost', at: t, balance: s.balance, payouts: s.funded?.payouts?.length || 0, traderPaid: Math.round(s.funded?.traderPaid || 0) }].slice(-20) });
          return out;
        }
        const next = fresh(s.attempt + 1);
        next.history = [...(s.history || []), { attempt: s.attempt, phase: 'funded', outcome: 'lost', at: t, balance: s.balance, payouts: s.funded?.payouts?.length || 0, traderPaid: Math.round(s.funded?.traderPaid || 0) }].slice(-20);
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
      // Règle du meilleur jour : gain total nécessaire (≥ objectif) et ce qu'il manque
      needed: tp === null ? null : (s.capital * effTarget(s)) / 100,
      bestDay: bestDayOf(s),
      dailyUsed: Number.isFinite(P.daily) ? Math.max(0, (s.dayStart - eq) / ((s.capital * P.daily) / 100)) : 0,
      maxUsed: P.maxUsd ? Math.max(0, 1 - (eq - floor) / P.maxUsd) : Math.max(0, ((P.trailing ? s.peak ?? s.capital : s.capital) - eq) / ((s.capital * P.max) / 100)),
      wins: s.closed.filter((c) => c.pnl > 0).length,
      trades: s.closed.length,
      // Journée en cours (pour /pnl) : solde d'ouverture, trades clôturés aujourd'hui, limite de perte du jour
      day: s.day,
      dayStart: s.dayStart,
      today: s.closed.filter((c) => dayOf(c.exitT) === s.day),
      dayFloor: dailyFloor(s),
    };
  }

  /**
   * Passage forcé en compte financé (commande /financer) : l'évaluation en cours est notée « réussite forcée » (même si
   * une règle, ex. le meilleur jour, la bloquait), ses trades sont archivés, le compte repart du capital en phase
   * financée : plus d'objectif, donc plus de réduction du risque à l'approche de l'objectif. Positions ouvertes gardées.
   */
  function forceFunded(t = Math.floor(Date.now() / 1000)) {
    if (A.fundedOnly) {
      // Compte Lucid financé à part : (re)démarré directement en compte financé
      if (!asleep()) return { already: true, s: load() };
      return { already: false, direct: true, s: startFunded(t) };
    }
    const s = load();
    if (s.phase === 'funded') return { already: true, s };
    const gain = s.balance - s.capital;
    const best = bestDayOf(s);
    const blocked = [];
    if (targetPct(s) !== null && s.balance < s.capital * (1 + targetPct(s) / 100)) blocked.push(`+${targetPct(s)}% target not reached`);
    if (P.bestDay > 0 && gain > 0 && best > (gain * P.bestDay) / 100) blocked.push(`best day ${Math.round((best / gain) * 100)}% of the gain > ${P.bestDay}%`);
    if (s.days.length < (P.minDays ?? 4)) blocked.push(`${s.days.length} trading day(s) out of ${P.minDays ?? 4}`);
    const was = { attempt: s.attempt, phase: s.phase, balance: s.balance, gainPct: (gain / s.capital) * 100, blocked };
    s.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'forced pass (/financer)', ...(blocked.length ? { why: blocked.join(', ') } : {}), at: t, balance: s.balance, days: s.days.length }].slice(-20);
    archive(s);
    Object.assign(s, { phase: 'funded', balance: s.capital, dayStart: s.capital, days: [], closed: [], startedAt: t, funded: { since: t, forced: true }, peak: s.capital, eodPeak: s.capital, dayPnl: {}, waitDay: null });
    save(s);
    return { already: false, was, s };
  }

  /**
   * Remise à zéro (commande /reset) : positions ouvertes fermées au dernier cours connu, challenge en cours archivé
   * (trades gardés dans <compte>-archive.json, ligne « réinitialisé » dans l'historique), nouveau challenge n° + 1 au
   * capital de départ. Les stats (historique des challenges, trades archivés, paper trading, IA) ne sont pas touchées.
   */
  function restart(prices = {}, t = Math.floor(Date.now() / 1000)) {
    const s = load();
    if (A.fundedOnly) {
      if (asleep()) return { was: null, asleep: true, s };
      // Compte financé à part : fermé et mis en sommeil (une nouvelle évaluation réussie le relancera)
      const nOpen0 = Object.keys(s.open || {}).length;
      if (!asleep()) closeAll(s, prices, t, 'reset (/reset)');
      archive(s);
      const was0 = { attempt: s.attempt, phase: s.phase, balance: s.balance, gainPct: ((s.balance - s.capital) / s.capital) * 100, nOpen: nOpen0 };
      save({ dormant: true, program: PKEY, attempt: s.attempt, capital: s.capital, balance: s.balance, history: [...(s.history || []), { attempt: s.attempt, phase: 'funded', outcome: 'reset (/reset)', at: t, balance: s.balance }].slice(-20) });
      return { was: was0, s: { ...fresh(s.attempt), dormant: true } };
    }
    const nOpen = Object.keys(s.open || {}).length;
    closeAll(s, prices, t, 'reset (/reset)');
    const was = { attempt: s.attempt, phase: s.phase, balance: s.balance, gainPct: ((s.balance - s.capital) / s.capital) * 100, nOpen };
    archive(s);
    const next = fresh((s.attempt || 0) + 1);
    next.history = [...(s.history || []), { attempt: s.attempt, phase: s.phase, outcome: 'reset (/reset)', at: t, balance: s.balance, days: (s.days || []).length }].slice(-20);
    save(next);
    return { was, s: next };
  }

  return { onCycle, status, load, refusedReport, follows, forceFunded, restart, asleep, archived: () => store.loadJson(ARCHIVE, []), account: A, reset: () => save(fresh()) };
}

/** /financer : passe les comptes simulés (tous, « ftmo » ou « lucid ») en compte financé ; texte de réponse (HTML). */
function financerReport(cfg, store, arg = '') {
  const a0 = String(arg || '').trim().toLowerCase();
  const accts = ftmoAccounts(cfg).filter((a) => (a0 === 'lucid' ? a.firm === 'Lucid' : a0 === 'ftmo' ? a.firm !== 'Lucid' : true));
  if (!accts.length) return 'No active simulated account. Usage: /financer · /financer ftmo · /financer lucid';
  const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = ['🏦 <b>Switch to funded account (simulation)</b>'];
  for (const a of accts) {
    // Lucid en parallèle : l'évaluation continue, c'est le compte financé à part qui démarre directement
    if (a.id === 'lucid' && cfg.lucidParallel) continue;
    const r = createFtmo({ cfg, store, account: a.id }).forceFunded();
    const name = `${a.firm || 'FTMO'} ${a.emoji} ${esc(a.label)}`;
    if (r.direct) {
      lines.push(`• ${name}: funded account started directly (${money(r.s.capital)}), alongside the Lucid evaluation and FTMO`);
      continue;
    }
    if (r.already) {
      lines.push(`• ${name}: already a funded account`);
      continue;
    }
    const w = r.was;
    lines.push(`• ${name}: evaluation #${w.attempt} stopped at ${money(w.balance)} (${w.gainPct >= 0 ? '+' : ''}${w.gainPct.toFixed(2)}%)${w.blocked.length ? ` — for real it would not be validated: ${esc(w.blocked.join(', '))}` : ''}`);
    const nOpen = Object.keys(r.s.open).length;
    lines.push(`  → funded account of ${money(r.s.capital)}, normal risk (no more target), simulated payouts${nOpen ? `, ${nOpen} open position(s) kept` : ''}`);
  }
  lines.push('', '<i>Simulation: the evaluation trades stay in the archive.</i>');
  return lines.join('\n');
}

/** /reset : remet les comptes simulés (tous, « ftmo » ou « lucid ») à zéro en gardant les stats ; « ok » pour confirmer. */
function resetReport(cfg, store, arg = '') {
  const words = String(arg || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const which = words.includes('lucid') ? 'lucid' : words.includes('ftmo') ? 'ftmo' : 'tous';
  const accts = ftmoAccounts(cfg).filter((a) => (which === 'lucid' ? a.firm === 'Lucid' : which === 'ftmo' ? a.firm !== 'Lucid' : true));
  if (!accts.length) return 'No active simulated account.';
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
  const names = accts.map((a) => `${a.firm || 'FTMO'} ${a.emoji} ${esc(a.label)}`).join(', ');
  if (!words.includes('ok')) {
    return [`♻️ <b>Reset</b>: ${names}`,
      'New challenge at the starting capital; open positions closed at the last price. <b>Kept</b>: challenge history, archived trades (site, /export), paper trading, AI.',
      `To confirm: <code>/reset ${which === 'tous' ? '' : `${which} `}ok</code>`].join('\n');
  }
  // Dernier cours connu de chaque marché (fichiers du paper trading)
  const prices = {};
  for (const m of require('./markets').allMarkets(cfg)) { const p = store.loadJson(m.file, {})?.lastPrice; if (p) prices[m.id] = p; }
  const lines = ['♻️ <b>Simulated accounts reset</b> (stats kept)'];
  for (const a of accts) {
    const r = createFtmo({ cfg, store, account: a.id }).restart(prices);
    const w = r.was;
    if (a.fundedOnly) {
      lines.push(r.asleep ? `• ${a.firm} ${a.emoji} ${esc(a.label)}: already asleep` : `• ${a.firm} ${a.emoji} ${esc(a.label)}: stopped at ${money(w.balance)} (${w.gainPct >= 0 ? '+' : ''}${w.gainPct.toFixed(2)}%)${w.nOpen ? `, ${w.nOpen} position(s) closed` : ''} → asleep (/financer lucid to restart it)`);
      continue;
    }
    lines.push(`• ${a.firm || 'FTMO'} ${a.emoji} ${esc(a.label)}: ${w.phase === 'funded' ? 'funded account' : `challenge #${w.attempt}`} stopped at ${money(w.balance)} (${w.gainPct >= 0 ? '+' : ''}${w.gainPct.toFixed(2)}%)${w.nOpen ? `, ${w.nOpen} position(s) closed` : ''} → challenge #${r.s.attempt} at ${money(r.s.capital)}`);
  }
  return lines.join('\n');
}

/**
 * /pnl [ftmo|lucid] [jours] : gain / perte du jour de chaque compte simulé (réalisé + latent, depuis le solde
 * d'ouverture de la journée), trades du jour, marge avant la limite de perte du jour, et les derniers jours.
 */
function dailyReport(cfg, store, arg = '') {
  const words = String(arg || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const nDays = Math.min(30, Math.max(1, Number(words.find((w) => /^\d+$/.test(w))) || 7));
  const which = words.includes('lucid') ? 'lucid' : words.includes('ftmo') ? 'ftmo' : 'tous';
  const accts = ftmoAccounts(cfg).filter((a) => (which === 'lucid' ? a.firm === 'Lucid' : which === 'ftmo' ? a.firm !== 'Lucid' : true));
  if (!accts.length) return 'No active simulated account.';
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const usd = (v) => `${v < -0.004 ? '−' : v > 0.004 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const pct = (v, cap) => `${v < 0 ? '−' : '+'}${Math.abs((v / cap) * 100).toFixed(2)} %`;
  const dot = (v) => (v > 0.5 ? '🟢' : v < -0.5 ? '🔴' : '⚪');
  const prices = {};
  for (const m of require('./markets').allMarkets(cfg)) { const px = store.loadJson(m.file, {})?.lastPrice; if (px) prices[m.id] = px; }
  const lines = ['📅 <b>Daily PnL</b> (simulated accounts)'];
  for (const a of accts) {
    const book = createFtmo({ cfg, store, account: a.id });
    if (book.asleep()) { lines.push('', `${a.firm} ${a.emoji} <b>${esc(a.label)}</b>: asleep (restarts at the next passed evaluation or with /financer lucid)`); continue; }
    const st = book.status(prices);
    const s = st.s;
    const realized = s.dayPnl?.[s.day] || 0;
    const total = st.equity - st.dayStart; // depuis l'ouverture de la journée (réalisé + latent)
    const wins = st.today.filter((x) => x.pnl > 0).length;
    const nOpen = Object.keys(s.open).length;
    lines.push('', `${a.firm || 'FTMO'} ${a.emoji} <b>${esc(a.label)}</b> · ${s.phase === 'funded' ? 'funded account' : `challenge #${s.attempt}`} · trading day ${esc(s.day || '—')}`);
    lines.push(`${dot(total)} <b>${usd(total)}</b> (${pct(total, s.capital)}) · realized ${usd(realized)} · unrealized ${usd(st.unrealized)}${nOpen ? ` (${nOpen} position(s))` : ''}`);
    lines.push(`Trades closed today: ${st.today.length}${st.today.length ? ` (${wins} winner(s))` : ''}`);
    for (const x of st.today.slice(-8)) lines.push(`  ${x.pnl > 0 ? '✅' : '❌'} ${esc(x.market)} ${esc(x.sid)} ${x.side === 'long' ? 'achat' : 'vente'} ${usd(x.pnl)}`);
    if (Number.isFinite(st.dayFloor)) {
      const room = Math.max(0, st.equity - st.dayFloor);
      lines.push(`Daily loss: $${Math.round(room).toLocaleString('en-US')} left before the limit (${st.program.daily}%, floor $${Math.round(st.dayFloor).toLocaleString('en-US')})`);
    }
    // Gestion de la journée pendant l'évaluation (arrêt après un gain ou N pertes)
    const lucid = a.firm === 'Lucid';
    const maxL = lucid ? cfg.lucidMaxLossesDay : cfg.ftmoMaxLossesDay;
    const capPct = lucid ? cfg.lucidDayProfitCapPct : cfg.ftmoDayProfitCapPct;
    if (s.phase !== 'funded' && (maxL > 0 || capPct > 0)) {
      const cap = ((capPct ?? 0) / 100) * s.capital * ((st.program.target ?? TARGET[s.phase] ?? 10) / 100);
      const done = (maxL > 0 && (s.dayLosses || 0) >= maxL) || (cap > 0 && s.balance - st.dayStart >= cap);
      lines.push(`Day management: ${done ? '⏸ day over (no new trades today)' : 'open'}${cap > 0 ? ` · stop at +$${Math.round(cap).toLocaleString('en-US')}` : ''}${maxL > 0 ? ` or after ${maxL} loss(es) (${s.dayLosses || 0} today)` : ''}`);
    }
    const days = Object.entries(s.dayPnl || {}).filter(([d]) => d !== s.day).sort((p, q) => (p[0] < q[0] ? 1 : -1)).slice(0, nDays);
    if (days.length) {
      lines.push(`Previous days (${days.length}, this challenge):`);
      for (const [d, v] of days) lines.push(`  ${dot(v)} ${esc(d)} ${usd(v)}`);
      const best = Math.max(...Object.values(s.dayPnl || {}), 0);
      if (st.program.bestDay > 0 && s.phase !== 'funded' && s.balance > s.capital) lines.push(`Best day ${usd(best)} = ${Math.round((best / (s.balance - s.capital)) * 100)}% of the gain (rule: ≤ ${st.program.bestDay}%)`);
    }
  }
  lines.push('', '<i>Simulation, fake money. /pnl lucid · /pnl ftmo · /pnl 30 (days)</i>');
  return lines.join('\n');
}

const ACCOUNT_FILES = ['ftmo.json', 'ftmo-nas.json', 'lucid.json', 'lucid-funded.json'];
/** Positions ouvertes sur ce marché dans un des comptes FTMO / Lucid ? */
function openOn(store, marketId) {
  return ACCOUNT_FILES.some((f) => Object.values(store.loadJson(f, null)?.open || {}).some((p) => p.market === marketId));
}
/** Décale entrée / stop / prix du signal des positions ouvertes d'un marché (changement de source des cours). */
function shiftOpen(store, marketId, shift) {
  for (const f of ACCOUNT_FILES) {
    const s = store.loadJson(f, null);
    if (!s?.open) continue;
    let n = 0;
    for (const p of Object.values(s.open)) {
      if (p.market !== marketId) continue;
      for (const k of ['entry', 'sl', 'signal']) if (Number.isFinite(p[k])) p[k] += shift;
      n++;
    }
    if (n) store.saveJson(f, s);
  }
}

module.exports = { shiftOpen, openOn, createFtmo, accountOf, ftmoAccounts, TARGET, PROGRAMS, programOf, MICRO, lucidProgram, FTMO_PAYOUT, financerReport, resetReport, dailyReport };
