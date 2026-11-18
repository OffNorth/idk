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

/** Risque d'un trade en % du prix (distance au stop initial). */
const stopPct = (t) => (Math.abs(t.entry - (t.initSl ?? t.sl)) / t.entry) * 100;

/** Résultat d'un trade en « R » (multiples du risque pris), frais inclus. */
const rMultiple = (t) => t.pnlPct / Math.max(1e-9, stopPct(t));

/**
 * Rejoue une liste de trades (de une ou plusieurs stratégies) sur un compte de type FTMO.
 * trades : [{ entryT, exitT, entry, initSl|sl, pnlPct (frais inclus, en % du montant), worstPct? }]
 * dayStopPct > 0 : règle de prudence « maison » — plus de nouveau trade dans la journée une fois la perte du jour
 * (soldée) arrivée à dayStopPct % du capital initial.
 * maxOpen : nombre maximal de positions ouvertes en même temps (les signaux suivants sont ignorés).
 * Retourne l'issue (target / daily / maxloss / open), le solde et le nombre de jours de trading.
 */
function runPhase(trades, { capital = 100_000, target = 10, riskPct = 1, leverage = 30, dailyPct = 5, maxPct = 10, minDays = 4, from = 0, dayStopPct = 0, maxOpen = Infinity } = {}) {
  const events = [];
  for (const t of trades) {
    if (t.entryT < from) continue;
    events.push({ t: t.entryT, kind: 'open', tr: t }, { t: t.exitT, kind: 'close', tr: t });
  }
  events.sort((a, b) => a.t - b.t || (a.kind === 'close' ? -1 : 1));
  let balance = capital;
  let dayStart = capital;
  let day = null;
  const days = new Set();
  const open = new Map();
  for (const e of events) {
    const d = ftmoDay(e.t);
    if (d !== day) {
      day = d;
      dayStart = balance;
    }
    if (e.kind === 'open') {
      if (dayStopPct > 0 && balance <= dayStart - (capital * dayStopPct) / 100) continue;
      if (open.size >= maxOpen) continue; // pas plus de maxOpen positions en même temps (limite le risque d'un trou de cotation)
      const sp = stopPct(e.tr);
      if (!(sp > 0)) continue;
      const notional = Math.min((balance * (e.tr.riskPct ?? riskPct)) / sp, balance * leverage); // risque propre au trade si fourni (comptes multi-marchés)
      open.set(e.tr, notional);
      days.add(d);
      continue;
    }
    const notional = open.get(e.tr);
    if (notional === undefined) continue;
    open.delete(e.tr);
    // Pire moment du trade (si connu) : compte pour la perte du jour comme sur FTMO (positions ouvertes comprises)
    if (e.tr.worstPct !== undefined) {
      const worst = balance + (notional * e.tr.worstPct) / 100;
      if (worst <= dayStart - (capital * dailyPct) / 100) return { outcome: 'daily', at: e.t, balance: worst, days: days.size };
      if (worst <= capital * (1 - maxPct / 100)) return { outcome: 'maxloss', at: e.t, balance: worst, days: days.size };
    }
    balance += (notional * e.tr.pnlPct) / 100;
    if (balance <= dayStart - (capital * dailyPct) / 100) return { outcome: 'daily', at: e.t, balance, days: days.size };
    if (balance <= capital * (1 - maxPct / 100)) return { outcome: 'maxloss', at: e.t, balance, days: days.size };
    if (balance >= capital * (1 + target / 100) && days.size >= minDays && open.size === 0) return { outcome: 'target', at: e.t, balance, days: days.size };
  }
  return { outcome: 'open', at: events.length ? events[events.length - 1].t : from, balance, days: days.size };
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
  const res = { tries: 0, passed: 0, failedDaily: 0, failedMax: 0, unfinished: 0, durations: [] };
  // Départs avec au moins `horizonDays` jours de données ensuite ; réussite = les 2 étapes en moins de horizonDays jours
  for (let s = t0; s < t1 - horizonDays * 86400; s += everyDays * 86400) {
    res.tries++;
    const p1 = runPhase(trades, { ...opts, from: s, target: 10 });
    if (p1.outcome === 'target' && (p1.at - s) / 86400 > horizonDays) {
      res.unfinished++;
      continue;
    }
    if (p1.outcome !== 'target') {
      if (p1.outcome === 'daily') res.failedDaily++;
      else if (p1.outcome === 'maxloss') res.failedMax++;
      else res.unfinished++;
      continue;
    }
    const p2 = runPhase(trades, { ...opts, from: p1.at + 1, target: 5 });
    if (p2.outcome === 'target' && (p2.at - s) / 86400 <= horizonDays) {
      res.passed++;
      res.durations.push((p2.at - s) / 86400);
    } else if (p2.outcome === 'target') res.unfinished++;
    else if (p2.outcome === 'daily') res.failedDaily++;
    else if (p2.outcome === 'maxloss') res.failedMax++;
    else res.unfinished++;
  }
  // Taux de réussite sur TOUS les départs : un challenge non fini en horizonDays jours compte comme raté
  res.passRate = res.tries ? (res.passed / res.tries) * 100 : 0;
  res.durations.sort((a, b) => a - b);
  res.medianDays = res.durations.length ? res.durations[Math.floor(res.durations.length / 2)] : null;
  return res;
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

module.exports = { runPhase, challengeStats, rStats, rMultiple, stopPct, ftmoDay };
