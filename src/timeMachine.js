/**
 * Time Machine : chances de réussir (ou de garder, en compte financé) le compte FTMO / Lucid simulé EN COURS.
 * 1 000 années possibles : chacune enchaîne des journées de trading tirées au hasard (avec remise) parmi les vraies
 * journées simulées des stratégies du bot (src/mcDays.json, nov. 2024 → nov. 2026, `npm run mc-build`), les trades
 * d'une même journée restant ensemble. Chaque suite est rejouée avec runPhase (mêmes règles que les backtests), en
 * partant de l'état actuel du compte (solde, plus haut, meilleur jour, jours déjà tradés) et avec les réglages
 * actuels (risque par stratégie, règle de taille, stop du jour). Limites : positions ouvertes et IA validatrice
 * ignorées ; 2 ans de données seulement → une estimation, pas une promesse.
 */
const { runPhase, cmeDay } = require('./ftmo');
const { accountOf, programOf, createFtmo, TARGET } = require('./ftmoAccount');
const { RULES } = require('./sizing');

let DATA = null;
const data = () => (DATA ??= require('./mcDays.json'));

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Jours ouvrés (minuit UTC) à partir du lendemain de t, sur horizonDays jours calendaires. */
function businessDays(t, horizonDays) {
  const out = [];
  const d0 = Math.floor(t / 86400) * 86400 + 86400;
  for (let d = d0; d < d0 + horizonDays * 86400; d += 86400) {
    const wd = new Date(d * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d);
  }
  return out;
}

/** Options runPhase du compte (règles de la formule FTMO ou Lucid, réglages du bot). */
function phaseOptions(cfg, A, s) {
  const P = A.program || programOf(cfg);
  const common = { riskPct: 1, sizer: s.phase === 'funded' && A.firm !== 'Lucid' && cfg.fundedCushion !== false
    ? ((rule) => (t, st) => rule(t, st) * require('./sizing').cushionMul(st.room))(require('./sizing').ruleFor(cfg, A.firm)) : require('./sizing').ruleFor(cfg, A.firm), dayStopPct: cfg.ftmoDayStop || 0, capital: s.capital, minDays: P.minDays ?? 4 };
  const funded = s.phase === 'funded';
  const target = funded ? Infinity : P.target ?? TARGET[s.phase] ?? 10;
  if (P.contracts) {
    // Lucid pendant l'évaluation : journée finie après un gain du jour de LUCID_DAY_PROFIT_CAP_PCT % de l'objectif ou
    // LUCID_MAX_LOSSES_DAY trade(s) perdant(s)
    const day = funded ? {} : {
      ...(cfg.lucidDayProfitCapPct > 0 ? { dayProfitCapUsd: (cfg.lucidDayProfitCapPct / 100) * s.capital * (target / 100) } : {}),
      ...(cfg.lucidMaxLossesDay > 0 ? { maxLossesPerDay: cfg.lucidMaxLossesDay } : {}),
    };
    return { ...common, ...day, target, dailyPct: Infinity, maxLossUsd: P.maxUsd, eodTrailing: true, lockAt: P.lockAt, bestDayPct: funded ? 0 : P.bestDay,
      contracts: true, maxContracts: P.maxContracts, minOneRisk: 0.4, leverage: 1000, dayOf: cmeDay };
  }
  const dayF = funded ? {} : {
    ...(cfg.ftmoDayProfitCapPct > 0 ? { dayProfitCapUsd: (cfg.ftmoDayProfitCapPct / 100) * s.capital * (target / 100) } : {}),
    ...(cfg.ftmoMaxLossesDay > 0 ? { maxLossesPerDay: cfg.ftmoMaxLossesDay } : {}),
  };
  return { ...common, ...dayF, target, dailyPct: P.daily, maxPct: P.max, trailingMax: !!P.trailing, bestDayPct: funded ? 0 : P.bestDay || 0, leverage: cfg.ftmoLeverage, levCap: P.levCap };
}

/**
 * Simulation du compte `accountId` ('gold' = FTMO, 'nas100', 'lucid'). opts : paths, horizonDays, seed, days
 * (journées, pour les tests), state (état du compte, sinon lu dans le store), now.
 */
function simulate(cfg, store, accountId = 'gold', opts = {}) {
  const A = accountOf(cfg, accountId);
  const s = opts.state || createFtmo({ cfg, store, account: accountId }).load();
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const paths = opts.paths ?? 1000;
  const horizon = opts.horizonDays ?? 365;
  const follow = new Set([...(A.strategies || [])]);
  // Journées de trading avec le risque actuel du compte pour chaque trade (0 = stratégie non prise → retirée)
  const days = (opts.days || data().days).map((day) => day.flatMap((x) => {
    if (opts.days == null && !follow.has(x.s)) return [];
    const [m, id] = x.s.split(':');
    const riskPct = A.riskOf(m, { id, tf: x.i ? '5m' : '1d' }, s.phase);
    if (!(riskPct > 0)) return [];
    return [{ ...x, m, riskPct }];
  }));
  const base = phaseOptions(cfg, A, s);
  const start = { balance: s.balance, peak: s.peak ?? s.balance, eodPeak: s.eodPeak ?? s.balance, dayPnl: s.dayPnl || {}, days: (s.days || []).length };
  const cal = businessDays(now, horizon);
  const rand = rng(opts.seed ?? Math.floor(now / 86400));
  const res = { paths, pass: 0, daily: 0, maxloss: 0, open: 0, passDays: [], failDays: [], phase: s.phase, attempt: s.attempt, balance: s.balance, capital: s.capital };
  for (let k = 0; k < paths; k++) {
    const trades = [];
    for (const d of cal) {
      const day = days[Math.floor(rand() * days.length)];
      for (const x of day) {
        const entryT = d + x.o;
        trades.push({ entryT, exitT: entryT + x.d, entry: x.e, initSl: x.l, pnlPct: x.p, worstPct: x.w, riskPct: x.riskPct, market: x.m, sid: x.s, contractUsd: x.c, contractFee: x.f });
      }
    }
    const r = runPhase(trades, { ...base, from: now, start });
    const dd = (r.at - now) / 86400;
    if (r.outcome === 'target') { res.pass++; res.passDays.push(dd); }
    else if (r.outcome === 'daily') { res.daily++; res.failDays.push(dd); }
    else if (r.outcome === 'maxloss') { res.maxloss++; res.failDays.push(dd); }
    else res.open++;
  }
  const q = (l, p) => (l.length ? [...l].sort((a, b) => a - b)[Math.floor((l.length - 1) * p)] : null);
  const pc = (n) => (n / paths) * 100;
  Object.assign(res, {
    passPct: pc(res.pass), failPct: pc(res.daily + res.maxloss), dailyPct: pc(res.daily), maxlossPct: pc(res.maxloss), openPct: pc(res.open),
    medianDays: q(res.passDays, 0.5), q1Days: q(res.passDays, 0.25), q3Days: q(res.passDays, 0.75),
    // Compte financé : part des comptes encore en vie après 3 / 6 / 12 mois
    alive: Object.fromEntries([91, 182, 365].map((h) => [h, 100 - pc(res.failDays.filter((d) => d <= h).length)])),
    from: opts.days ? null : data().from, to: opts.days ? null : data().to,
  });
  delete res.passDays;
  delete res.failDays;
  return res;
}

/** Résultat gardé en cache (data/time-machine.json) jusqu'au prochain trade clôturé, changement de réglage ou lendemain. */
function cached(cfg, store, accountId = 'gold', opts = {}) {
  const s = createFtmo({ cfg, store, account: accountId }).load();
  const key = [s.attempt, s.phase, Math.round(s.balance), (s.closed || []).length, (s.days || []).length, new Date().toISOString().slice(0, 10),
    cfg.ftmoSizing, cfg.ftmoGroupSizing, cfg.fundedCushion, cfg.ftmoRisk, cfg.ftmoIntradayRisk, cfg.lucidRiskMul, cfg.lucidIntradayRisk, cfg.lucidEvalIntradayMul, cfg.ftmoProgram].join('|');
  const all = store.loadJson('time-machine.json', {});
  if (all[accountId]?.key === key) return all[accountId].res;
  const res = simulate(cfg, store, accountId, { ...opts, state: s });
  all[accountId] = { key, at: Date.now(), res };
  store.saveJson('time-machine.json', all);
  return res;
}

const pct = (v) => `${Math.round(v)}%`;
/** Une ligne pour les panneaux /ftmo et /lucid. */
function line(res) {
  if (!res) return '';
  if (res.phase === 'funded') return `🔮 Time Machine (${res.paths} simulated years): funded account still alive at 3 months ${pct(res.alive[91])} · 6 months ${pct(res.alive[182])} · 1 year ${pct(res.alive[365])}`;
  return `🔮 Time Machine (${res.paths} simulated years): pass <b>${pct(res.passPct)}</b> · fail ${pct(res.failPct)}${res.openPct >= 1 ? ` · not done in 1 year ${pct(res.openPct)}` : ''}${res.medianDays !== null ? ` · in ${Math.round(res.medianDays)} days (median)` : ''}`;
}

/** Texte détaillé (/timemachine). */
function report(cfg, store) {
  const { ftmoAccounts } = require('./ftmoAccount');
  const lines = ['🔮 <b>Time Machine</b> — odds of the current account, from 1,000 simulated years'];
  for (const a of ftmoAccounts(cfg)) {
    const r = cached(cfg, store, a.id);
    lines.push('', `<b>${a.firm || 'FTMO'} ${a.emoji} ${a.label}</b> · ${r.phase === 'funded' ? 'funded account' : 'evaluation'} #${r.attempt} · balance $${Math.round(r.balance).toLocaleString('en-US')}`);
    if (r.phase === 'funded') {
      lines.push(`Still alive: 3 months ${pct(r.alive[91])} · 6 months ${pct(r.alive[182])} · 1 year ${pct(r.alive[365])}`);
      continue;
    }
    lines.push(`✅ Pass ${pct(r.passPct)}${r.medianDays !== null ? ` — in ${Math.round(r.q1Days)} to ${Math.round(r.q3Days)} days (median ${Math.round(r.medianDays)})` : ''}`);
    lines.push(`❌ Fail ${pct(r.failPct)} (${r.daily ? `daily loss ${pct(r.dailyPct)}, ` : ''}max loss ${pct(r.maxlossPct)})${r.openPct >= 1 ? ` · ⏳ not done in 1 year ${pct(r.openPct)}` : ''}`);
  }
  const d = data();
  lines.push('', `<i>Days drawn at random from the bot strategies’ simulated trades (${d.from} → ${d.to}), current settings, current account state. Open positions and validator AI not counted. An estimate, not a promise.</i>`);
  return lines.join('\n');
}

module.exports = { simulate, cached, line, report, rng, businessDays, phaseOptions };
