/**
 * Simulation d'un compte FTMO (challenge en 2 étapes), utilisée par le banc d'essai (ftmo.js) et par le bot en direct.
 *
 * Règles reproduites (FTMO 2-Step, 2026) :
 *   - étape 1 : +10 % ; étape 2 (vérification) : +5 % ; minimum 4 jours de trading par étape ; pas de limite de temps
 *   - perte maximale du jour : 5 % du capital initial sous le solde de la veille (positions ouvertes comprises)
 *   - perte maximale : 10 % du capital initial (seuil fixe)
 * Taille des positions : on risque `riskPct` % du solde à chaque trade (taille = risque ÷ distance du stop),
 * plafonnée par l'effet de levier (`leverage`). Le jour de trading suit l'heure de Prague (minuit CE(S)T), comme FTMO.
 */

const PRAGUE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayCache = new Map();
/** Jour de trading FTMO (AAAA-MM-JJ, heure de Prague) d'un timestamp en secondes. */
function ftmoDay(t) {
  const h = Math.floor(t / 3600);
  let d = dayCache.get(h);
  if (!d) {
    d = PRAGUE.format(new Date(h * 3600 * 1000));
    dayCache.set(h, d);
  }
  return d;
}

const NY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const cmeCache = new Map();
/** Jour de trading des futures CME (la séance change à 17 h, heure de New York). */
function cmeDay(t) {
  const h = Math.floor(t / 3600);
  let d = cmeCache.get(h);
  if (!d) {
    d = NY.format(new Date((h + 7) * 3600 * 1000)); // 17 h à New York + 7 h = minuit du jour suivant
    cmeCache.set(h, d);
  }
  return d;
}

/** Risque d'un trade en % du prix (distance au stop initial). */
const stopPct = (t) => (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100;

/** Résultat d'un trade en « R » (multiples du risque pris), frais inclus. */
const rMultiple = (t) => t.pnlPct / Math.max(1e-9, stopPct(t));

/**
 * Rejoue une liste de trades (de une ou plusieurs stratégies) sur un compte de type FTMO.
 * trades : [{ entryT, exitT, entry, initSl|sl, pnlPct (frais inclus, en % du montant), worstPct? }]
 * dayStopPct > 0 : règle de prudence « maison » — plus de nouveau trade dans la journée une fois la perte du jour
 * (soldée) arrivée à dayStopPct % du capital initial.
 * riskMul : multiplie le risque de chaque trade (challengeStats : `phase2Mul` pour l'étape 2, objectif +5 % seulement).
 * trailingMax : perte max mesurée depuis le plus haut solde (1 étape) ; bestDayPct : règle du meilleur jour ;
 * levCap : levier max par marché ({ gold, nas100 }, compte Swing) ; challengeStats({ steps: 1 }) : challenge 1 étape.
 * maxOpen : nombre maximal de positions ouvertes en même temps (les signaux suivants sont ignorés).
 * Comptes de futures (Lucid) : maxLossUsd (perte max en $), eodTrailing (seuil = plus haut solde de CLÔTURE de journée
 * − perte max, recalculé en fin de journée seulement), lockAt (seuil bloqué à capital + lockAt), dailyPct: Infinity
 * (pas de perte du jour), contracts (taille en contrats entiers : t.contractUsd = valeur d'un contrat, t.contractFee =
 * frais aller-retour par contrat), maxContracts (contrats ouverts en tout), dayOf (jour de trading).
 * Phase financée : until (dernière entrée), payout({ day, balance, capital, dayPnl }) → montant retiré à la clôture.
 * Retourne l'issue (target / daily / maxloss / open), le solde et le nombre de jours de trading.
 */
function runPhase(trades, { capital = 100_000, target = 10, riskPct = 1, leverage = 30, dailyPct = 5, maxPct = 10, minDays = 4, from = 0, dayStopPct = 0, maxOpen = Infinity, riskMul = 1, sizer = null, trailingMax = false, bestDayPct = 0, levCap = null,
  maxLossUsd = null, eodTrailing = false, lockAt = null, contracts = false, maxContracts = Infinity, dayOf = ftmoDay, until = Infinity, payout = null } = {}) {
  const maxLoss = maxLossUsd ?? (capital * maxPct) / 100;
  const events = [];
  for (const t of trades) {
    if (t.entryT < from || t.entryT > until) continue;
    events.push({ t: t.entryT, kind: 'open', tr: t }, { t: t.exitT, kind: 'close', tr: t });
  }
  events.sort((a, b) => a.t - b.t || (a.kind === 'close' ? -1 : 1));
  let balance = capital;
  let peak = capital; // plus haut solde (perte max suiveuse, challenge 1 étape)
  let eodPeak = capital; // plus haut solde de clôture de journée (perte max suiveuse fin de journée, Lucid)
  let lots = 0; // contrats ouverts (futures)
  const paid = []; // versements (phase financée)
  const dayPnl = new Map(); // gain soldé par jour (règle du meilleur jour)
  let dayStart = capital;
  let day = null;
  const days = new Set();
  const open = new Map();
  for (const e of events) {
    const d = dayOf(e.t);
    if (d !== day) {
      if (day !== null) {
        eodPeak = Math.max(eodPeak, balance);
        // Versement (phase financée) : décidé à la clôture de la journée précédente
        const out = payout ? payout({ day, t: e.t, balance, capital, dayPnl }) : 0;
        if (out > 0) {
          balance -= out;
          paid.push({ t: e.t, amount: out });
          if (!eodTrailing) peak = balance; // FTMO : le compte repart du capital après retrait des gains
        }
      }
      day = d;
      dayStart = balance;
    }
    if (e.kind === 'open') {
      if (dayStopPct > 0 && balance <= dayStart - (capital * dayStopPct) / 100) continue;
      if (open.size >= maxOpen) continue; // pas plus de maxOpen positions en même temps (limite le risque d'un trou de cotation)
      const sp = stopPct(e.tr);
      if (!(sp > 0)) continue;
      // risque propre au trade si fourni (comptes multi-marchés) ; `sizer` : multiplicateur de risque selon le trade et l'état du compte
      const mul = sizer ? sizer(e.tr, { balance, capital, dayStart, target, open: open.size }) : 1;
      if (!(mul > 0)) continue;
      const cap = (levCap && e.tr.market && levCap[e.tr.market]) || leverage; // levier max par marché (compte Swing)
      let notional = Math.min((balance * (e.tr.riskPct ?? riskPct) * riskMul * mul) / sp, balance * cap);
      let n = 0;
      if (contracts) {
        // Futures : contrats entiers (arrondi vers le bas), plafond de contrats ouverts en tout
        n = Math.min(Math.floor(notional / e.tr.contractUsd), maxContracts - lots);
        if (!(n >= 1)) continue;
        notional = n * e.tr.contractUsd;
        lots += n;
      }
      open.set(e.tr, { notional, n });
      days.add(d);
      continue;
    }
    const pos = open.get(e.tr);
    if (pos === undefined) continue;
    open.delete(e.tr);
    const { notional, n } = pos;
    lots -= n;
    const fees = n * (e.tr.contractFee || 0);
    // Pire moment du trade (si connu) : compte pour la perte du jour comme sur FTMO (positions ouvertes comprises)
    // Perte max : seuil fixe (capital − 10 %) ou suiveur (plus haut solde − 10 %, challenge 1 étape)
    let floor = (eodTrailing ? eodPeak : trailingMax ? peak : capital) - maxLoss;
    if (lockAt !== null) floor = Math.min(floor, capital + lockAt); // Lucid : le seuil ne monte plus au-delà de capital + lockAt
    if (e.tr.worstPct !== undefined) {
      const worst = balance + (notional * e.tr.worstPct) / 100;
      if (worst <= dayStart - (capital * dailyPct) / 100) return { outcome: 'daily', at: e.t, balance: worst, days: days.size, paid };
      if (worst <= floor) return { outcome: 'maxloss', at: e.t, balance: worst, days: days.size, paid };
    }
    const gain = (notional * e.tr.pnlPct) / 100 - fees;
    balance += gain;
    dayPnl.set(d, (dayPnl.get(d) || 0) + gain);
    peak = Math.max(peak, balance);
    if (balance <= dayStart - (capital * dailyPct) / 100) return { outcome: 'daily', at: e.t, balance, days: days.size, paid };
    if (balance <= floor) return { outcome: 'maxloss', at: e.t, balance, days: days.size, paid };
    if (balance >= capital * (1 + target / 100) && days.size >= minDays && open.size === 0) {
      // Règle du meilleur jour : le meilleur jour ne doit pas dépasser bestDayPct % du gain total (sinon on continue)
      const best = Math.max(...dayPnl.values());
      if (!(bestDayPct > 0) || best <= ((balance - capital) * bestDayPct) / 100) return { outcome: 'target', at: e.t, balance, days: days.size };
    }
  }
  return { outcome: 'open', at: events.length ? events[events.length - 1].t : from, balance, days: days.size, paid };
}

/**
 * Challenge complet (étape 1 puis étape 2) à partir de chaque date de départ (toutes les `everyDays` jours).
 * Retourne les statistiques : taux de réussite, durée médiane, causes d'échec.
 */
function challengeStats(trades, opts = {}) {
  const { everyDays = 7, start = null, end = null, horizonDays = 180 } = opts;
  if (!trades.length) return null;
  const t0 = start ?? Math.min(...trades.map((t) => t.entryT));
  const t1 = end ?? Math.max(...trades.map((t) => t.exitT));
  const res = { tries: 0, passed: 0, failedDaily: 0, failedMax: 0, unfinished: 0, durations: [], fundedRuns: [] };
  // Départs avec au moins `horizonDays` jours de données ensuite ; réussite = les 2 étapes en moins de horizonDays jours
  for (let s = t0; s < t1 - horizonDays * 86400; s += everyDays * 86400) {
    res.tries++;
    const p1 = runPhase(trades, { ...opts, from: s, target: opts.target1 ?? 10 });
    if (p1.outcome === 'target' && (p1.at - s) / 86400 > horizonDays) {
      res.unfinished++;
      continue;
    }
    if (opts.steps === 1 && p1.outcome === 'target') {
      // Challenge 1 étape : une seule phase à +10 %
      res.passed++;
      res.durations.push((p1.at - s) / 86400);
      if (opts.funded) res.fundedRuns.push(fundedRun(trades, opts, p1.at + 1));
      continue;
    }
    if (p1.outcome !== 'target') {
      if (p1.outcome === 'daily') res.failedDaily++;
      else if (p1.outcome === 'maxloss') res.failedMax++;
      else res.unfinished++;
      continue;
    }
    const p2 = runPhase(trades, { ...opts, from: p1.at + 1, target: 5, riskMul: opts.phase2Mul ?? 1 });
    if (p2.outcome === 'target' && (p2.at - s) / 86400 <= horizonDays) {
      res.passed++;
      res.durations.push((p2.at - s) / 86400);
      if (opts.funded) res.fundedRuns.push(fundedRun(trades, opts, p2.at + 1));
    } else if (p2.outcome === 'target') res.unfinished++;
    else if (p2.outcome === 'daily') res.failedDaily++;
    else if (p2.outcome === 'maxloss') res.failedMax++;
    else res.unfinished++;
  }
  // Taux de réussite sur TOUS les départs : un challenge non fini en horizonDays jours compte comme raté
  res.passRate = res.tries ? (res.passed / res.tries) * 100 : 0;
  res.durations.sort((a, b) => a - b);
  res.medianDays = res.durations.length ? res.durations[Math.floor(res.durations.length / 2)] : null;
  if (opts.funded) {
    // Gain net moyen par challenge acheté : versements (part du trader) − prix, frais remboursés au 1er versement si prévu
    const f = opts.funded;
    const nets = [];
    for (let i = 0; i < res.tries; i++) {
      const r = res.fundedRuns[i];
      if (!r) { nets.push(-f.fee); continue; }
      nets.push(r.paid * f.split - f.fee + (f.refund && r.paid > 0 ? f.fee : 0));
    }
    const fr = res.fundedRuns;
    res.netPerTry = nets.reduce((a, b) => a + b, 0) / Math.max(1, nets.length);
    res.fundedMonths = fr.length ? fr.reduce((a, r) => a + r.months, 0) / fr.length : 0;
    res.paidPerMonth = fr.length ? fr.reduce((a, r) => a + r.paid * f.split, 0) / Math.max(1e-9, fr.reduce((a, r) => a + r.months, 0)) : 0;
    res.fundedLost = fr.length ? (fr.filter((r) => r.lost).length / fr.length) * 100 : 0;
  }
  return res;
}

/**
 * Phase financée après réussite : rejoue le compte (sans objectif) pendant `funded.days` jours au plus ou jusqu'à la
 * perte du compte. funded.rule : 'ftmo' (retrait de tout le gain tous les `every` jours) ou 'lucid' (cycle de
 * `cycleDays` jours gagnants ≥ `minDay` $, retrait ≤ `share` du gain et ≤ `cap` $). Retourne { paid (brut), months, lost }.
 */
function fundedRun(trades, opts, from) {
  const f = opts.funded;
  const until = from + f.days * 86400;
  let last = from;
  let good = 0;
  const payout = ({ day, t, balance, capital, dayPnl }) => {
    const gain = balance - capital;
    if (f.rule === 'lucid') {
      if ((dayPnl.get(day) || 0) >= f.minDay) good++;
      if (good < f.cycleDays || gain <= 0) return 0;
      good = 0;
      return Math.min(gain * f.share, f.cap);
    }
    if (t - last < f.every * 86400 || gain <= 0) return 0;
    last = t;
    return gain;
  };
  const r = runPhase(trades, { ...opts, ...(f.phase || {}), from, until, target: Infinity, bestDayPct: 0, payout });
  const paid = r.paid.reduce((a, p) => a + p.amount, 0);
  const end = r.outcome === 'open' ? Math.min(until, Math.max(from, r.at)) : r.at;
  return { paid, months: Math.max(0, end - from) / (30.4 * 86400), lost: r.outcome !== 'open' };
}

/** Statistiques en R d'une liste de trades : espérance, % gagnants, pire série de pertes, R par mois. */
function rStats(trades) {
  if (!trades.length) return { n: 0, expR: 0, win: 0, worstRun: 0, rPerMonth: 0 };
  const rs = trades.map(rMultiple);
  let run = 0;
  let worst = 0;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
    run = r < 0 ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  const months = Math.max(1, (trades[trades.length - 1].exitT - trades[0].entryT) / (30.4 * 86400));
  return {
    n: rs.length,
    expR: cum / rs.length,
    win: (rs.filter((r) => r > 0).length / rs.length) * 100,
    worstRun: worst,
    maxDdR: dd,
    rPerMonth: cum / months,
    tradesPerMonth: rs.length / months,
  };
}

module.exports = { runPhase, challengeStats, fundedRun, rStats, rMultiple, stopPct, ftmoDay, cmeDay };
