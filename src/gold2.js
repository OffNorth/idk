/**
 * Or : nouvelles stratégies.
 *   Journalières (future GC=F) : plus bas de 10 jours, mauvaise semaine, chute des taux, chute du dollar, l'argent en tête.
 *   Pétrole en baisse (test en masse) ; 5 min : bougie fermée en bas (test en masse des scalps) ;
 *   5 min : retour à la moyenne pendant la séance asiatique (0 h – 6 h UTC), quand Londres et New York dorment.
 */
const { computeScalp2, helpers } = require('./scalp2');

const { ema } = require('./indicators');

const { trendUp, trendDown, active, flat } = helpers;
const D = { tf: '1d', onlyTf: ['1d'], markets: ['gold'], gold2: true, warmup: 210 };
const none = (exitLong = false) => ({ entry: null, exitLong, exitShort: true, sl: 0, tp: null });

const GOLD2 = [
  {
    ...D,
    id: 'g_low10',
    name: 'Or : plus bas de 10 jours dans la tendance',
    desc: 'Au-dessus de sa moyenne 200 jours, l’or clôture au plus bas des 10 dernières séances → achat ; revente à la clôture au plus haut des 5 dernières séances. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      if (i < 12) return none();
      const lo10 = Math.min(...c.slice(i - 9, i + 1));
      const hi5 = Math.max(...c.slice(i - 4, i));
      return { entry: c[i] <= lo10 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] >= hi5, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...D,
    id: 'g_weekrev',
    name: 'Or : rebond après une mauvaise semaine',
    desc: 'L’or a perdu plus de 3 % en 5 séances tout en restant au-dessus de sa moyenne 200 jours → achat ; revente au plus haut des 5 dernières séances. Stop 3 ATR.',
    evaluate(x, i) {
      const c = x.closes;
      if (i < 15) return none();
      const hi5 = Math.max(...c.slice(i - 5, i));
      return { entry: c[i] / c[i - 5] - 1 < -0.03 && c[i] > x.sma200[i] ? 'long' : null, exitLong: c[i] >= hi5, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...D,
    needsTnx: true,
    id: 'g_yieldfall',
    name: 'Or : chute rapide des taux',
    desc: 'L’or ne rapporte pas d’intérêts : quand le taux 10 ans US baisse de plus de 5 % en 5 séances et que l’or est au-dessus de sa moyenne 50 jours → achat ; revente quand les taux repassent au-dessus de leur moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const t = x.tnx;
      const fall = i >= 5 && t.c[i] !== null && t.c[i - 5] && t.c[i] / t.c[i - 5] - 1 < -0.05;
      const up = t.c[i] !== null && t.sma10[i] !== null && t.c[i] > t.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...D,
    needsDxy: true,
    id: 'g_dollarfall',
    name: 'Or : chute rapide du dollar',
    desc: 'L’or est coté en dollars : quand l’indice du dollar (DXY) baisse de plus de 2 % en 10 séances et que l’or est au-dessus de sa moyenne 50 jours → achat ; revente quand le dollar repasse au-dessus de sa moyenne 10 jours. Stop 3 ATR.',
    evaluate(x, i) {
      const d = x.dxy;
      const fall = i >= 10 && d.c[i] !== null && d.c[i - 10] && d.c[i] / d.c[i - 10] - 1 < -0.02;
      const up = d.c[i] !== null && d.sma10[i] !== null && d.c[i] > d.sma10[i];
      return { entry: fall && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: up, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...D,
    needsAux: ['silver'],
    id: 'g_silverlead',
    name: 'Or : l’argent prend de l’avance',
    desc: 'Quand l’argent fait au moins 5 points de mieux que l’or sur 10 séances (le ratio or / argent chute), les métaux sont en mouvement : achat de l’or s’il est au-dessus de sa moyenne 50 jours ; revente quand l’avance de l’argent disparaît ou sous la moyenne 50. Stop 3 ATR.',
    evaluate(x, i) {
      const g = x.gsr;
      if (i < 12 || g.r[i] === null || !g.r[i - 10]) return none(x.closes[i] < x.sma50[i]);
      const lead = 1 - g.r[i] / g.r[i - 10]; // l'argent surperforme quand le ratio baisse
      return { entry: lead > 0.05 && x.closes[i] > x.sma50[i] ? 'long' : null, exitLong: lead < 0 || x.closes[i] < x.sma50[i], exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    ...D,
    needsAux: ['oil'],
    id: 'g_oilfall',
    name: 'Or : chute du pétrole',
    desc: 'Meilleure « autres marchés » du test en masse or : quand le pétrole perd plus de 4 % en 20 séances et que l’or est au-dessus de sa moyenne 50 jours → achat ; revente 20 séances après le dernier signal. Stop 3 ATR.',
    evaluate(x, i) {
      const o = x.oil;
      if (!o || i < 45) return none(true);
      const sig = (j) => o.c[j] !== null && o.c[j - 20] && o.c[j] / o.c[j - 20] - 1 < -0.04 && x.closes[j] > x.sma50[j];
      let recent = false;
      for (let j = i; j > i - 20 && !recent; j--) recent = sig(j);
      return { entry: sig(i) ? 'long' : null, exitLong: !recent, exitShort: true, sl: 3 * x.atr[i], tp: null };
    },
  },
  {
    tf: '5m', onlyTf: ['5m', '15m'], markets: ['gold'], scalp: true, gold2: true, warmup: 700,
    compute: (c, s, m) => computeScalp2(c, s, m),
    id: 'g_ibsh',
    name: 'Or : bougie fermée en bas, sortie au-dessus du plus haut',
    desc: 'Meilleur total du test en masse des scalps or (112 variantes) : dans la tendance 1 h, bougie 5 min qui clôture dans les 20 % bas de son range (IBS < 0,2) sous l’EMA 20 → achat ; sortie dès qu’une clôture dépasse le plus haut de la bougie précédente (symétrique à la vente). Stop 1,5 ATR, tout fermé hors séance.',
    evaluate(x, i) {
      const c = x.closes;
      const e = x.ema20 || (x.ema20 = ema(c, 20));
      const fl = flat(x, i);
      const out = { entry: null, exitLong: fl || c[i] > x.candles[i - 1].h, exitShort: fl || c[i] < x.candles[i - 1].l, sl: 1.5 * x.atr[i], tp: null };
      if (!active(x, i)) return out;
      if (trendUp(x, i) && x.ibs[i] < 0.2 && c[i] < e[i]) return { ...out, entry: 'long' };
      if (trendDown(x, i) && x.ibs[i] > 0.8 && c[i] > e[i]) return { ...out, entry: 'short' };
      return out;
    },
  },
  {
    tf: '5m', onlyTf: ['5m', '15m'], markets: ['gold'], scalp: true, gold2: true, warmup: 700,
    compute: (c, s, m) => computeScalp2(c, s, m),
    id: 'g_asia',
    name: 'Or : retour à la moyenne en séance asiatique',
    desc: 'Entre 0 h et 6 h UTC (Tokyo, Hong Kong, Sydney ; Londres et New York fermés), le marché de l’or est calme et revient souvent à sa moyenne : dans la tendance 1 h, RSI 2 sous 5 → achat (au-dessus de 95 → vente en tendance baissière), sortie quand le RSI 2 repasse 60 (40), tout fermé à 6 h 55. Stop 1,5 ATR.',
    evaluate(x, i) {
      const m = x.min[i];
      const wd = x.wd[i] >= 1 && x.wd[i] <= 5;
      const flat = !wd || m >= 6 * 60 + 55 || m < 30;
      const r = x.rsi2[i];
      const out = { entry: null, exitLong: flat || r > 60, exitShort: flat || r < 40, sl: 1.5 * x.atr[i], tp: null };
      if (!wd || m < 60 || m >= 6 * 60 + 30) return out;
      if (trendUp(x, i) && r < 5) return { ...out, entry: 'long' };
      if (trendDown(x, i) && r > 95) return { ...out, entry: 'short' };
      return out;
    },
  },
];

module.exports = { GOLD2 };
