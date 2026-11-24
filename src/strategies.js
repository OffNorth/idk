/**
 * Stratégies de trading de l'or (bougies 1 h). Chacune a son propre compte simulé.
 *
 * evaluate(ind, i) est appelée sur la dernière bougie CLÔTURÉE i et renvoie :
 *   { entry: 'long' | 'short' | null, exitLong: bool, exitShort: bool, sl, tp }
 *     sl / tp : distances en $ depuis le prix d'entrée (tp = null → pas d'objectif fixe)
 * trail(pos, ind, i) (optionnel) renvoie un nouveau niveau de stop (ne fait que le resserrer).
 */

const crossUp = (a, b, i) => a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) => a[i - 1] >= b[i - 1] && a[i] < b[i];

const STRATEGIES = [
  {
    id: 'ema',
    name: 'Tendance EMA 20/50',
    desc: 'Achat quand l’EMA 20 croise au-dessus de l’EMA 50 (RSI < 70), vente à découvert au croisement inverse. SL 1,5 ATR, TP 3 ATR.',
    warmup: 60,
    evaluate(ind, i) {
      const a = ind.atr[i];
      return {
        entry: crossUp(ind.ema20, ind.ema50, i) && ind.rsi[i] < 70 ? 'long'
          : crossDown(ind.ema20, ind.ema50, i) && ind.rsi[i] > 30 ? 'short' : null,
        exitLong: crossDown(ind.ema20, ind.ema50, i),
        exitShort: crossUp(ind.ema20, ind.ema50, i),
        sl: 1.5 * a,
        tp: 3 * a,
      };
    },
  },
  {
    id: 'breakout',
    name: 'Cassure Donchian 20',
    desc: 'Achat quand le prix casse le plus haut des 20 dernières heures, vente à découvert sous le plus bas. Stop suiveur 2,5 ATR, sortie au canal 10 h opposé.',
    warmup: 30,
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: c > ind.dc20.hh[i] ? 'long' : c < ind.dc20.ll[i] ? 'short' : null,
        exitLong: c < ind.dc10.ll[i],
        exitShort: c > ind.dc10.hh[i],
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
    trail(pos, ind, i) {
      const d = 2.5 * ind.atr[i];
      return pos.side === 'long' ? pos.best - d : pos.best + d;
    },
  },
  {
    id: 'meanrev',
    name: 'Retour à la moyenne (Bollinger + RSI)',
    desc: 'Achat quand le prix sort sous la bande de Bollinger basse avec RSI < 30, vente à découvert au-dessus de la bande haute avec RSI > 70. Sortie au retour sur la moyenne 20 h. SL 1,5 ATR.',
    warmup: 30,
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: c < ind.bb.lower[i] && ind.rsi[i] < 30 ? 'long' : c > ind.bb.upper[i] && ind.rsi[i] > 70 ? 'short' : null,
        exitLong: c >= ind.bb.mid[i],
        exitShort: c <= ind.bb.mid[i],
        sl: 1.5 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'macd',
    name: 'MACD + filtre EMA 200',
    desc: 'Achat quand le MACD croise au-dessus de son signal et que le prix est au-dessus de l’EMA 200, vente à découvert dans le cas inverse. SL 2 ATR, TP 4 ATR.',
    warmup: 210,
    evaluate(ind, i) {
      const c = ind.closes[i];
      const { line, signal } = ind.macd;
      return {
        entry: crossUp(line, signal, i) && c > ind.ema200[i] ? 'long'
          : crossDown(line, signal, i) && c < ind.ema200[i] ? 'short' : null,
        exitLong: crossDown(line, signal, i),
        exitShort: crossUp(line, signal, i),
        sl: 2 * ind.atr[i],
        tp: 4 * ind.atr[i],
      };
    },
  },
  {
    id: 'supertrend',
    name: 'Supertrend (10, 3)',
    desc: 'Achat quand le Supertrend passe haussier, vente à découvert quand il passe baissier. Le stop suit la ligne du Supertrend.',
    warmup: 30,
    evaluate(ind, i) {
      const { dir, line } = ind.st;
      const c = ind.closes[i];
      return {
        entry: dir[i] === 1 && dir[i - 1] === -1 ? 'long' : dir[i] === -1 && dir[i - 1] === 1 ? 'short' : null,
        exitLong: dir[i] === -1,
        exitShort: dir[i] === 1,
        sl: Math.max(Math.abs(c - line[i]), 0.5 * ind.atr[i]),
        tp: null,
      };
    },
    trail(pos, ind, i) {
      return ind.st.line[i];
    },
  },
];

/* ------------------------------------------------------------------ */
/* Stratégies tirées des documents fournis                             */
/* ------------------------------------------------------------------ */

STRATEGIES.push(
  {
    id: 'sma1060',
    name: 'Croisement MM 10/60 (FOREX.com)',
    desc: 'Guide FOREX.com : achat quand la moyenne 10 h croise au-dessus de la moyenne 60 h, vente à découvert au croisement inverse. Toujours en position : chaque croisement clôture et retourne. Stop de protection 3 ATR.',
    warmup: 70,
    evaluate(ind, i) {
      const up = crossUp(ind.sma10, ind.sma60, i);
      const down = crossDown(ind.sma10, ind.sma60, i);
      return { entry: up ? 'long' : down ? 'short' : null, exitLong: down, exitShort: up, sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    id: 'pvt',
    name: 'PVT + EMA 50',
    desc: 'Guide PVT : achat quand le Price Volume Trend croise au-dessus de sa moyenne 21 (pression acheteuse qui monte) et que le prix est au-dessus de l’EMA 50 (confirmation), vente à découvert dans le cas inverse. SL 1,5 ATR, TP 3 ATR. Volume = PAXG sur Coinbase.',
    warmup: 60,
    evaluate(ind, i) {
      const c = ind.closes[i];
      const up = crossUp(ind.pvt, ind.pvtSig, i);
      const down = crossDown(ind.pvt, ind.pvtSig, i);
      return {
        entry: up && c > ind.ema50[i] ? 'long' : down && c < ind.ema50[i] ? 'short' : null,
        exitLong: down,
        exitShort: up,
        sl: 1.5 * ind.atr[i],
        tp: 3 * ind.atr[i],
      };
    },
  },
  {
    id: 'fibo',
    name: 'Convergence : tendance jour + Fibonacci + chandelier',
    desc: 'Guide UK Gold Trading Experts : dans le sens de la tendance journalière (prix vs MM200, MM20 vs MM50), attendre un repli de 38,2 à 61,8 % de la dernière impulsion (48 h) puis un chandelier de retournement (marteau / avalement). Stop au-delà de 78,6 %, objectif extension 127,2 %, stop au point mort après +1R puis suiveur.',
    warmup: 50,
    evaluate(ind, i) {
      const none = { entry: null, exitLong: ind.dTrend[i] === -1, exitShort: ind.dTrend[i] === 1, sl: 0, tp: null };
      const { hi, lo, hiIdx, loIdx } = ind.sw48;
      const range = hi[i] - lo[i];
      const c = ind.candles[i];
      const a = ind.atr[i];
      if (!(range > 2 * a)) return none;
      if (ind.dTrend[i] === 1 && ind.pattern[i] === 1 && loIdx[i] < hiIdx[i] && hiIdx[i] < i) {
        const depth = (hi[i] - c.l) / range;
        const stop = hi[i] - 0.786 * range;
        if (depth >= 0.382 && depth <= 0.618 && c.c > stop) {
          return { ...none, entry: 'long', sl: Math.max(c.c - stop, 0.5 * a), tp: hi[i] + 0.272 * range - c.c };
        }
      }
      if (ind.dTrend[i] === -1 && ind.pattern[i] === -1 && hiIdx[i] < loIdx[i] && loIdx[i] < i) {
        const depth = (c.h - lo[i]) / range;
        const stop = lo[i] + 0.786 * range;
        if (depth >= 0.382 && depth <= 0.618 && c.c < stop) {
          return { ...none, entry: 'short', sl: Math.max(stop - c.c, 0.5 * a), tp: c.c - (lo[i] - 0.272 * range) };
        }
      }
      return none;
    },
    trail(pos) {
      const r = Math.abs(pos.entry - pos.initSl);
      const long = pos.side === 'long';
      const gain = long ? pos.best - pos.entry : pos.entry - pos.best;
      if (gain >= 2 * r) return long ? pos.best - r : pos.best + r; // suiveur à 1R du meilleur prix
      if (gain >= r) return pos.entry; // point mort
      return pos.sl;
    },
  },
);

/** Référence : acheter l'or une fois et le garder (pour savoir si une stratégie fait mieux que détenir). */
STRATEGIES.push({
  id: 'hold',
  tf: '1d',
  name: 'Référence : achat-conservation',
  desc: 'Pas une stratégie : achète le marché au démarrage et le garde. Sert de point de comparaison — une stratégie qui ne fait pas mieux n’apporte rien.',
  warmup: 1,
  evaluate(ind, i) {
    return { entry: 'long', exitLong: false, exitShort: false, sl: ind.closes[i] * 0.9, tp: null };
  },
});

/* ------------------------------------------------------------------ */
/* Stratégies maison (idées connues sur l'or / les matières premières)  */
/* ------------------------------------------------------------------ */

STRATEGIES.push(
  {
    id: 'tsmom',
    tf: '1d',
    name: 'Momentum de tendance (achat seul)',
    desc: 'Maison, d’après le « time-series momentum » (Moskowitz et al., 2012) : l’or a tendance à continuer dans le sens de ses 3 derniers mois. Achat quand le prix est au-dessus de sa moyenne 200 jours ET a monté sur 3 mois ; sortie dès qu’une condition tombe. Jamais à découvert (l’or monte sur le long terme). Stop de protection 4 ATR.',
    warmup: 210,
    evaluate(ind, i) {
      const up = ind.closes[i] > ind.sma200[i] && ind.roc63[i] > 0;
      return { entry: up ? 'long' : null, exitLong: !up, exitShort: false, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    id: 'tsmom_ls',
    tf: '1d',
    name: 'Momentum de tendance (achat + vente)',
    desc: 'Maison : comme le momentum de tendance, mais vend aussi à découvert quand le prix est sous sa moyenne 200 jours ET a baissé sur 3 mois.',
    warmup: 210,
    evaluate(ind, i) {
      const c = ind.closes[i];
      const up = c > ind.sma200[i] && ind.roc63[i] > 0;
      const down = c < ind.sma200[i] && ind.roc63[i] < 0;
      return { entry: up ? 'long' : down ? 'short' : null, exitLong: !up, exitShort: !down, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    id: 'turtle',
    tf: '1d',
    name: 'Turtle (cassure 55 / sortie 20)',
    desc: 'Maison, d’après le système 2 des « Turtles » : achat sur un plus haut de 55 périodes, vente à découvert sur un plus bas de 55, sortie sur le canal 20 opposé. Stop 2 ATR.',
    warmup: 60,
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: c > ind.dc55.hh[i] ? 'long' : c < ind.dc55.ll[i] ? 'short' : null,
        exitLong: c < ind.dc20.ll[i],
        exitShort: c > ind.dc20.hh[i],
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'rsi2',
    tf: '1d',
    name: 'RSI 2 (repli dans la tendance, achat seul)',
    desc: 'Maison, d’après Larry Connors : dans une tendance haussière (prix > moyenne 200), acheter un repli très court (RSI 2 < 10) et revendre dès que le prix repasse au-dessus de sa moyenne 5. Stop 3 ATR.',
    warmup: 210,
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: ind.rsi2[i] < 10 && c > ind.sma200[i] ? 'long' : null,
        exitLong: c > ind.sma5[i],
        exitShort: false,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'pullback',
    tf: '6h',
    name: 'Repli RSI dans la tendance EMA 50/200',
    desc: 'Maison : tendance définie par EMA 50 vs EMA 200 ; achat quand le RSI 14 repasse au-dessus de 40 après un repli (vente à découvert quand il repasse sous 60 en tendance baissière). Sortie RSI > 70 / < 30 ou changement de tendance. Stop 2 ATR.',
    warmup: 210,
    evaluate(ind, i) {
      const up = ind.ema50[i] > ind.ema200[i];
      const r = ind.rsi;
      return {
        entry: up && r[i - 1] < 40 && r[i] >= 40 ? 'long' : !up && r[i - 1] > 60 && r[i] <= 60 ? 'short' : null,
        exitLong: !up || r[i] > 70,
        exitShort: up || r[i] < 30,
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'keltner',
    tf: '6h',
    name: 'Cassure de volatilité (Keltner)',
    desc: 'Maison : achat quand le prix clôture plus de 2 ATR au-dessus de son EMA 20 (mouvement anormalement fort), vente à découvert en dessous. Stop suiveur 3 ATR, sortie si le prix repasse l’EMA 50.',
    warmup: 60,
    evaluate(ind, i) {
      const c = ind.closes[i];
      const band = 2 * ind.atr[i];
      return {
        entry: c > ind.ema20[i] + band ? 'long' : c < ind.ema20[i] - band ? 'short' : null,
        exitLong: c < ind.ema50[i],
        exitShort: c > ind.ema50[i],
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
    trail(pos, ind, i) {
      const d = 3 * ind.atr[i];
      return pos.side === 'long' ? pos.best - d : pos.best + d;
    },
  },
  {
    id: 'asia',
    tf: '1h',
    onlyTf: ['1h'],
    name: 'Cassure du range asiatique',
    desc: 'Maison : l’or est calme pendant la session asiatique (00–07 h UTC) puis bouge à l’ouverture de Londres. Achat à la première clôture au-dessus du plus haut asiatique (vente à découvert sous le plus bas) entre 07 et 12 h UTC ; stop de l’autre côté du range, objectif = 1 range, sortie forcée à 20 h UTC.',
    warmup: 30,
    evaluate(ind, i) {
      const h = ind.hour[i];
      const end = h >= 20 || h < 7;
      const none = { entry: null, exitLong: end, exitShort: end, sl: 0, tp: null };
      const hi = ind.asia?.hi[i];
      const lo = ind.asia?.lo[i];
      if (hi == null || h > 12) return none;
      const c = ind.closes[i];
      const p = ind.closes[i - 1];
      const range = hi - lo;
      if (!(range > 0)) return none;
      if (c > hi && p <= hi) return { ...none, entry: 'long', sl: c - lo, tp: hi + range - c };
      if (c < lo && p >= lo) return { ...none, entry: 'short', sl: hi - c, tp: c - (lo - range) };
      return none;
    },
  },
);

/* ------------------------------------------------------------------ */
/* Lot 2 : autres familles (classiques + maison)                       */
/* ------------------------------------------------------------------ */

/** Vrai quand la condition devient vraie sur la bougie i (fausse sur i − 1). */
const became = (cond, i) => cond(i) && !cond(i - 1);
const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

STRATEGIES.push(
  {
    id: 'ichimoku',
    tf: '1d',
    name: 'Ichimoku (nuage + tenkan/kijun)',
    desc: 'Classique japonais : achat quand le prix est au-dessus du nuage ET la tenkan au-dessus de la kijun, vente à découvert dans le cas inverse. Sortie quand le prix repasse la kijun. Stop 2,5 ATR.',
    warmup: 80,
    evaluate(ind, i) {
      const { tenkan, kijun, top, bottom } = ind.ichi;
      const c = ind.closes;
      const bull = (k) => top[k] !== null && c[k] > top[k] && tenkan[k] > kijun[k];
      const bear = (k) => bottom[k] !== null && c[k] < bottom[k] && tenkan[k] < kijun[k];
      return {
        entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null,
        exitLong: c[i] < kijun[i],
        exitShort: c[i] > kijun[i],
        sl: 2.5 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'adx',
    tf: '1d',
    name: 'Tendance forte ADX',
    desc: 'Classique (Wilder) : n’entre que si la tendance est forte (ADX > 25), dans le sens du +DI / −DI. Sortie quand les DI se croisent ou que l’ADX retombe sous 20. Stop suiveur 3 ATR.',
    warmup: 40,
    evaluate(ind, i) {
      const { adx: a, pdi, mdi } = ind.adx;
      const bull = (k) => a[k] > 25 && pdi[k] > mdi[k];
      const bear = (k) => a[k] > 25 && mdi[k] > pdi[k];
      return {
        entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null,
        exitLong: pdi[i] < mdi[i] || a[i] < 20,
        exitShort: mdi[i] < pdi[i] || a[i] < 20,
        sl: 2.5 * ind.atr[i],
        tp: null,
      };
    },
    trail(pos, ind, i) {
      const d = 3 * ind.atr[i];
      return pos.side === 'long' ? pos.best - d : pos.best + d;
    },
  },
  {
    id: 'squeeze',
    tf: '1d',
    name: 'Compression puis explosion (Bollinger squeeze)',
    desc: 'Maison, d’après John Bollinger : quand les bandes sont les plus serrées depuis 6 mois (marché endormi), entrer dans le sens de la première clôture hors des bandes. Stop suiveur 2,5 ATR, sortie si le prix repasse la moyenne 20.',
    warmup: 140,
    evaluate(ind, i) {
      const bw = ind.bandwidth;
      let min120 = Infinity;
      for (let k = i - 120; k < i; k++) if (bw[k] !== null) min120 = Math.min(min120, bw[k]);
      let recent = Infinity;
      for (let k = i - 5; k < i; k++) if (bw[k] !== null) recent = Math.min(recent, bw[k]);
      const squeezed = recent <= min120 * 1.05;
      const c = ind.closes[i];
      return {
        entry: squeezed && c > ind.bb.upper[i] ? 'long' : squeezed && c < ind.bb.lower[i] ? 'short' : null,
        exitLong: c < ind.bb.mid[i],
        exitShort: c > ind.bb.mid[i],
        sl: 2.5 * ind.atr[i],
        tp: null,
      };
    },
    trail(pos, ind, i) {
      const d = 2.5 * ind.atr[i];
      return pos.side === 'long' ? pos.best - d : pos.best + d;
    },
  },
  {
    id: 'ribbon',
    tf: '1d',
    name: 'Alignement des moyennes 10/20/50',
    desc: 'Maison : achat quand les EMA 10, 20 et 50 s’alignent dans l’ordre haussier (10 > 20 > 50), vente à découvert dans l’ordre baissier. Sortie quand l’EMA 10 repasse l’EMA 20. Stop 2 ATR.',
    warmup: 60,
    evaluate(ind, i) {
      const { ema10: a, ema20: b, ema50: c } = ind;
      const bull = (k) => a[k] > b[k] && b[k] > c[k];
      const bear = (k) => a[k] < b[k] && b[k] < c[k];
      return {
        entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null,
        exitLong: a[i] < b[i],
        exitShort: a[i] > b[i],
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'insidebar',
    tf: '1d',
    name: 'Inside bar dans la tendance',
    desc: 'Price action : une bougie « inside » (contenue dans la précédente) marque une pause ; on entre à la cassure de la bougie mère, seulement dans le sens de la tendance (prix vs moyenne 200 et EMA 20 vs 50). Stop de l’autre côté de la bougie mère, objectif 2 fois le risque.',
    warmup: 210,
    evaluate(ind, i) {
      const k = ind.candles;
      const none = { entry: null, exitLong: false, exitShort: false, sl: 0, tp: null };
      const mother = k[i - 2];
      const inside = k[i - 1].h < mother.h && k[i - 1].l > mother.l;
      if (!inside) return none;
      const c = ind.closes[i];
      const up = c > ind.sma200[i] && ind.ema20[i] > ind.ema50[i];
      const down = c < ind.sma200[i] && ind.ema20[i] < ind.ema50[i];
      if (up && c > mother.h) {
        const risk = Math.max(c - mother.l, 0.5 * ind.atr[i]);
        return { ...none, entry: 'long', sl: risk, tp: 2 * risk };
      }
      if (down && c < mother.l) {
        const risk = Math.max(mother.h - c, 0.5 * ind.atr[i]);
        return { ...none, entry: 'short', sl: risk, tp: 2 * risk };
      }
      return none;
    },
  },
  {
    id: 'heikin',
    tf: '1d',
    name: 'Heikin-Ashi + EMA 50',
    desc: 'Classique : achat sur une bougie Heikin-Ashi verte « franche » (sans mèche basse) au-dessus de l’EMA 50, vente à découvert sur une rouge sans mèche haute sous l’EMA 50. Sortie au premier changement de couleur. Stop 2 ATR.',
    warmup: 60,
    evaluate(ind, i) {
      const h = ind.ha[i];
      const green = h.c > h.o;
      const strongUp = green && Math.min(h.o, h.c) - h.l <= (h.h - h.l) * 0.05;
      const strongDown = !green && h.h - Math.max(h.o, h.c) <= (h.h - h.l) * 0.05;
      const c = ind.closes[i];
      return {
        entry: strongUp && c > ind.ema50[i] ? 'long' : strongDown && c < ind.ema50[i] ? 'short' : null,
        exitLong: !green,
        exitShort: green,
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'vote',
    tf: '1d',
    name: 'Vote de 5 signaux de tendance',
    desc: 'Maison : 5 indicateurs de tendance votent (prix vs moyenne 200, moyenne 10 vs 60, EMA 20 vs 50, MACD vs signal, hausse sur 3 mois). Achat quand au moins 4 votent « hausse », vente à découvert quand au moins 4 votent « baisse », sortie quand le vote redevient neutre ou contraire. Stop 4 ATR. Diversifier les signaux rend en général plus robuste.',
    warmup: 210,
    evaluate(ind, i) {
      const score = (k) =>
        sign(ind.closes[k] - ind.sma200[k]) +
        sign(ind.sma10[k] - ind.sma60[k]) +
        sign(ind.ema20[k] - ind.ema50[k]) +
        sign(ind.macd.line[k] - ind.macd.signal[k]) +
        sign(ind.roc63[k]);
      const s = score(i);
      return {
        entry: became((k) => score(k) >= 3, i) && s >= 3 ? 'long' : became((k) => score(k) <= -3, i) && s <= -3 ? 'short' : null,
        exitLong: s <= 0,
        exitShort: s >= 0,
        sl: 4 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    id: 'dollar',
    tf: '1d',
    needsFx: true,
    name: 'Dollar + or (intermarché)',
    desc: 'Maison : l’or monte souvent quand le dollar baisse. Achat quand l’EUR/USD est au-dessus de sa moyenne 50 jours (dollar faible) ET l’or au-dessus de son EMA 50 ; vente à découvert quand le dollar est fort ET l’or sous son EMA 50. Sortie dès qu’une des deux conditions tombe. Stop 3 ATR.',
    warmup: 60,
    evaluate(ind, i) {
      const c = ind.closes;
      const bull = (k) => ind.dollar[k] === 1 && c[k] > ind.ema50[k];
      const bear = (k) => ind.dollar[k] === -1 && c[k] < ind.ema50[k];
      return {
        entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null,
        exitLong: !bull(i),
        exitShort: !bear(i),
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
);

/* ------------------------------------------------------------------ */
/* Scalp (bougies 1 / 5 min) — séances Londres + New York uniquement    */
/* ------------------------------------------------------------------ */

const inSession = (ind, i) => ind.minute[i] >= 7 * 60 && ind.minute[i] < 20 * 60;
const endOfDay = (ind, i) => ind.minute[i] >= 20 * 60 || ind.minute[i] < 7 * 60;
const SCALP = { tf: '5m', onlyTf: ['1m', '5m'], scalp: true, warmup: 60 };

STRATEGIES.push(
  {
    ...SCALP,
    id: 's_emavwap',
    name: 'Scalp EMA 9/21 + VWAP',
    desc: 'Scalp classique : croisement EMA 9 / EMA 21 dans le sens du prix par rapport au VWAP de la séance. Stop 1 ATR, objectif 1,5 ATR, tout fermé à 20 h UTC.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const vw = ind.vw.vwap[i];
      const up = crossUp(ind.ema9, ind.ema21, i);
      const down = crossDown(ind.ema9, ind.ema21, i);
      const ok = inSession(ind, i);
      return {
        entry: ok && up && c > vw ? 'long' : ok && down && c < vw ? 'short' : null,
        exitLong: endOfDay(ind, i) || down,
        exitShort: endOfDay(ind, i) || up,
        sl: ind.atr[i],
        tp: 1.5 * ind.atr[i],
      };
    },
  },
  {
    ...SCALP,
    id: 's_vwaprev',
    name: 'Scalp retour au VWAP',
    desc: 'Contre-tendance : quand le prix s’écarte de plus de 2 écarts-types du VWAP de la séance avec un RSI 7 extrême (< 20 ou > 80), parier sur un retour au VWAP. Stop 1 ATR, sortie au VWAP.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const { vwap, sd } = ind.vw;
      const ok = inSession(ind, i) && sd[i] > 0;
      return {
        entry: ok && c < vwap[i] - 2 * sd[i] && ind.rsi7[i] < 20 ? 'long' : ok && c > vwap[i] + 2 * sd[i] && ind.rsi7[i] > 80 ? 'short' : null,
        exitLong: endOfDay(ind, i) || c >= vwap[i],
        exitShort: endOfDay(ind, i) || c <= vwap[i],
        sl: ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...SCALP,
    id: 's_bbrsi',
    name: 'Scalp Bollinger + RSI 7',
    desc: 'Contre-tendance : clôture hors des bandes de Bollinger (20, 2) avec RSI 7 extrême → retour vers la moyenne 20. Stop 1 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const ok = inSession(ind, i);
      return {
        entry: ok && c < ind.bb.lower[i] && ind.rsi7[i] < 20 ? 'long' : ok && c > ind.bb.upper[i] && ind.rsi7[i] > 80 ? 'short' : null,
        exitLong: endOfDay(ind, i) || c >= ind.bb.mid[i],
        exitShort: endOfDay(ind, i) || c <= ind.bb.mid[i],
        sl: ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...SCALP,
    id: 's_orb',
    name: 'Scalp cassure du range d’ouverture (Londres / New York)',
    desc: 'Range des 30 premières minutes de Londres (07:00 UTC) et de New York (13:30 UTC) ; entrée à la première clôture hors du range dans les 2 h qui suivent. Stop de l’autre côté du range, objectif 1,5 fois le risque. Sortie à 12:00 (Londres) / 17:00 UTC (New York).',
    evaluate(ind, i) {
      const m = ind.minute[i];
      const exit = (m >= 12 * 60 && m < 14 * 60) || m >= 17 * 60 || m < 7 * 60;
      const none = { entry: null, exitLong: exit, exitShort: exit, sl: 0, tp: null };
      const or = m >= 7 * 60 + 30 && m < 9 * 60 + 30 ? ind.orLondon : m >= 14 * 60 && m < 16 * 60 ? ind.orNy : null;
      if (!or || or.hi[i] === null) return none;
      const c = ind.closes[i];
      const p = ind.closes[i - 1];
      const { hi, lo } = { hi: or.hi[i], lo: or.lo[i] };
      if (c > hi && p <= hi) {
        const risk = Math.max(c - lo, 0.5 * ind.atr[i]);
        return { ...none, entry: 'long', sl: risk, tp: 1.5 * risk };
      }
      if (c < lo && p >= lo) {
        const risk = Math.max(hi - c, 0.5 * ind.atr[i]);
        return { ...none, entry: 'short', sl: risk, tp: 1.5 * risk };
      }
      return none;
    },
  },
  {
    ...SCALP,
    id: 's_stoch',
    name: 'Scalp stochastique dans la tendance',
    desc: 'Repli dans la tendance courte : prix au-dessus d’une EMA 50 montante, achat quand le stochastique (14, 3, 3) repart à la hausse depuis la zone < 20 ; inverse en tendance baissière. Stop 1 ATR, objectif 1,5 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const e = ind.ema50;
      const { k, d } = ind.stoch;
      const ok = inSession(ind, i);
      const up = c > e[i] && e[i] > e[i - 10];
      const down = c < e[i] && e[i] < e[i - 10];
      return {
        entry: ok && up && crossUp(k, d, i) && k[i - 1] < 20 ? 'long' : ok && down && crossDown(k, d, i) && k[i - 1] > 80 ? 'short' : null,
        exitLong: endOfDay(ind, i),
        exitShort: endOfDay(ind, i),
        sl: ind.atr[i],
        tp: 1.5 * ind.atr[i],
      };
    },
  },
  {
    ...SCALP,
    id: 's_burst',
    name: 'Scalp accélération (3 bougies)',
    desc: 'Momentum : 3 bougies consécutives dans le même sens, mouvement total > 2 ATR et clôture près de l’extrême → suivre le mouvement. Stop 1 ATR, objectif 1 ATR.',
    evaluate(ind, i) {
      const k = ind.candles;
      const ok = inSession(ind, i) && i >= 3;
      const a = ind.atr[i];
      const ups = ok && [0, 1, 2].every((j) => k[i - j].c > k[i - j].o);
      const downs = ok && [0, 1, 2].every((j) => k[i - j].c < k[i - j].o);
      const move = ok ? k[i].c - k[i - 2].o : 0;
      const c = k[i];
      const nearHigh = c.c >= c.h - 0.2 * (c.h - c.l);
      const nearLow = c.c <= c.l + 0.2 * (c.h - c.l);
      return {
        entry: ups && move > 2 * a && nearHigh ? 'long' : downs && -move > 2 * a && nearLow ? 'short' : null,
        exitLong: endOfDay(ind, i),
        exitShort: endOfDay(ind, i),
        sl: a,
        tp: a,
      };
    },
  },
);

/* ------------------------------------------------------------------ */
/* Lot Nasdaq : effets connus des indices actions (achat seul)          */
/* ------------------------------------------------------------------ */

// Testées aussi sur l'or (même logique : repli dans la tendance, calendrier, VIX)
const EQUITY = { tf: '1d', markets: ['nas100', 'gold'], warmup: 210 };

STRATEGIES.push(
  {
    ...EQUITY,
    id: 'tom',
    name: 'Effet de début de mois',
    desc: 'Effet calendaire documenté sur les indices actions (Ariel 1987, Lakonishok & Smidt 1988) : les flux d’épargne arrivent en fin / début de mois. Achat à la clôture de l’avant-dernier jour ouvré du mois, revente à la clôture du 3e jour de bourse du mois suivant. Stop 3 ATR.',
    evaluate(ind, i) {
      const { tdom, bizLeft } = ind.cal || { tdom: [], bizLeft: [] };
      return {
        entry: bizLeft[i] === 1 ? 'long' : null,
        exitLong: tdom[i] >= 3 && tdom[i] <= 10, // 3e jour de bourse du nouveau mois
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'ibs',
    name: 'IBS : clôture au plus bas du jour',
    desc: 'Retour à la moyenne très court terme bien connu sur les indices : quand l’indice clôture dans les 20 % les plus bas de sa journée (IBS < 0,2) au-dessus de sa moyenne 200 jours, acheter ; revendre quand il clôture dans le haut de sa journée (IBS > 0,8) ou au-dessus du plus haut de la veille. Stop 3 ATR.',
    evaluate(ind, i) {
      const k = ind.candles;
      return {
        entry: ind.ibs[i] < 0.2 && ind.closes[i] > ind.sma200[i] ? 'long' : null,
        exitLong: ind.ibs[i] > 0.8 || ind.closes[i] > k[i - 1].h,
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'double7',
    name: 'Double 7 (Connors)',
    desc: 'Larry Connors : au-dessus de la moyenne 200 jours, acheter quand l’indice clôture à son plus bas de 7 jours, revendre quand il clôture à son plus haut de 7 jours. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: c > ind.sma200[i] && c <= ind.c7.min[i] ? 'long' : null,
        exitLong: c >= ind.c7.max[i],
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'down3',
    name: '3 jours de baisse',
    desc: 'Maison : dans une tendance haussière (prix > moyenne 200), acheter après 3 clôtures en baisse d’affilée, revendre à la première clôture en hausse. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const down3 = c[i] < c[i - 1] && c[i - 1] < c[i - 2] && c[i - 2] < c[i - 3];
      return {
        entry: down3 && c[i] > ind.sma200[i] ? 'long' : null,
        exitLong: c[i] > c[i - 1],
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'sma200',
    name: 'Filtre moyenne 200 jours',
    desc: 'Le « market timing » le plus connu (Faber 2007) : être investi tant que l’indice est au-dessus de sa moyenne 200 jours (avec 2 % de marge pour éviter les allers-retours), sortir en dessous. Garde l’essentiel des hausses et évite le cœur des krachs. Stop de protection 5 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      const m = ind.sma200[i];
      return {
        entry: c > m * 1.02 ? 'long' : null,
        exitLong: c < m * 0.98,
        exitShort: true,
        sl: 5 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'vixspike',
    name: 'Pic de peur (VIX)',
    desc: 'Maison : quand le VIX (indice de la peur) dépasse de 25 % sa moyenne 20 jours alors que l’indice reste au-dessus de sa moyenne 200 jours, acheter la panique ; revendre quand le VIX repasse sous sa moyenne 10 jours. Stop 3 ATR.',
    needsVix: true,
    evaluate(ind, i) {
      const v = ind.vix;
      const spike = v.c[i] !== null && v.sma20[i] !== null && v.c[i] > 1.25 * v.sma20[i];
      return {
        entry: spike && ind.closes[i] > ind.sma200[i] ? 'long' : null,
        exitLong: v.c[i] !== null && v.sma10[i] !== null && v.c[i] < v.sma10[i],
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...EQUITY,
    id: 'vixcalm',
    name: 'Marché calme (VIX)',
    desc: 'Maison : être investi quand la peur est faible (VIX sous sa moyenne 50 jours) et l’indice au-dessus de sa moyenne 50 jours ; sortir quand le VIX dépasse de 10 % sa moyenne 50 jours ou que l’indice passe sous sa moyenne 50. Stop 4 ATR.',
    needsVix: true,
    evaluate(ind, i) {
      const v = ind.vix;
      const c = ind.closes;
      const calm = (k) => v.c[k] !== null && v.sma50[k] !== null && v.c[k] < v.sma50[k] && c[k] > ind.sma50[k];
      return {
        entry: became(calm, i) ? 'long' : null,
        exitLong: (v.c[i] !== null && v.sma50[i] !== null && v.c[i] > 1.1 * v.sma50[i]) || c[i] < ind.sma50[i],
        exitShort: true,
        sl: 4 * ind.atr[i],
        tp: null,
      };
    },
  },
);

/* ------------------------------------------------------------------ */
/* Lot or : effets propres à l'or (saison, taux, dollar, peur)          */
/* ------------------------------------------------------------------ */

const GOLD = { tf: '1d', markets: ['gold'], warmup: 260 };
/** Croisement d'état d'une série externe (taux, dollar, VIX) avec sa moyenne 50 jours. */
const aboveAvg = (s, k, mult = 1) => s.c[k] !== null && s.sma50[k] !== null && s.c[k] > mult * s.sma50[k];
const belowAvg = (s, k, mult = 1) => s.c[k] !== null && s.sma50[k] !== null && s.c[k] < mult * s.sma50[k];

STRATEGIES.push(
  {
    ...GOLD,
    id: 'season',
    name: 'Saison de l’or (août → février)',
    desc: 'Effet saisonnier souvent cité : la demande physique d’or monte d’août à février (saison des mariages et fêtes en Inde, Nouvel An chinois). Investi d’août à fin février, dehors de mars à juillet. Stop de protection 4 ATR.',
    evaluate(ind, i) {
      const m = ind.month[i];
      const inSeason = m >= 8 || m <= 2;
      return { entry: inSeason ? 'long' : null, exitLong: !inSeason, exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'yields',
    needsTnx: true,
    name: 'Taux US 10 ans + or',
    desc: 'L’or ne rapporte pas d’intérêts : il monte souvent quand les taux baissent. Achat quand le taux 10 ans US est sous sa moyenne 50 jours (taux en baisse) ET l’or au-dessus de son EMA 50 ; vente à découvert dans le cas inverse. Sortie dès qu’une condition tombe. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const bull = (k) => belowAvg(ind.tnx, k) && c[k] > ind.ema50[k];
      const bear = (k) => aboveAvg(ind.tnx, k) && c[k] < ind.ema50[k];
      return { entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null, exitLong: !bull(i), exitShort: !bear(i), sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'dxy',
    needsDxy: true,
    name: 'Indice du dollar (DXY) + or',
    desc: 'Comme « Dollar + or », mais avec le vrai indice du dollar (DXY, 6 devises) : achat quand le DXY est sous sa moyenne 50 jours ET l’or au-dessus de son EMA 50 ; vente à découvert dans le cas inverse. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const bull = (k) => belowAvg(ind.dxy, k) && c[k] > ind.ema50[k];
      const bear = (k) => aboveAvg(ind.dxy, k) && c[k] < ind.ema50[k];
      return { entry: became(bull, i) ? 'long' : became(bear, i) ? 'short' : null, exitLong: !bull(i), exitShort: !bear(i), sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'fear',
    needsVix: true,
    name: 'Valeur refuge (VIX élevé)',
    desc: 'L’or sert de refuge quand les marchés ont peur : achat quand le VIX dépasse de 10 % sa moyenne 50 jours ET l’or est au-dessus de sa moyenne 50 jours ; sortie quand le VIX repasse sous sa moyenne ou l’or sous sa moyenne 50. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const on = (k) => aboveAvg(ind.vix, k, 1.1) && c[k] > ind.sma50[k];
      return { entry: became(on, i) ? 'long' : null, exitLong: belowAvg(ind.vix, i) || c[i] < ind.sma50[i], exitShort: true, sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    markets: ['gold', 'nas100'],
    id: 'mom12',
    name: 'Momentum 12 mois',
    desc: 'Momentum « absolu » classique (Antonacci) : investi tant que l’or a monté sur les 12 derniers mois, dehors sinon. Stop de protection 5 ATR.',
    evaluate(ind, i) {
      const up = ind.roc252[i] !== null && ind.roc252[i] > 0;
      return { entry: up ? 'long' : null, exitLong: !up, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    markets: ['gold', 'nas100'],
    id: 'high52',
    name: 'Nouveau plus haut annuel',
    desc: 'Maison : acheter quand l’or clôture à son plus haut de 52 semaines (les nouveaux sommets attirent les acheteurs), revendre à son plus bas de 50 jours. Stop suiveur 4 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      return { entry: c >= ind.c252.max[i] ? 'long' : null, exitLong: c <= ind.c50.min[i], exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
    trail(pos, ind, i) {
      return pos.best - 4 * ind.atr[i];
    },
  },
);

/* ------------------------------------------------------------------ */
/* Lot Nasdaq 2 : saisonnalité, retours à la moyenne courts, régimes    */
/* ------------------------------------------------------------------ */

const NAS2 = { tf: '1d', markets: ['nas100'], warmup: 280 };

STRATEGIES.push(
  {
    ...NAS2,
    id: 'halloween',
    name: '« Sell in May » (novembre → avril)',
    desc: 'Effet Halloween (Bouman & Jacobsen 2002), observé sur la plupart des marchés actions depuis des décennies : investi de novembre à fin avril, dehors de mai à octobre. Stop de protection 5 ATR.',
    evaluate(ind, i) {
      const m = ind.month[i];
      const on = m >= 11 || m <= 4;
      return { entry: on ? 'long' : null, exitLong: !on, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...NAS2,
    id: 'cumrsi',
    name: 'RSI cumulé (Connors)',
    desc: 'Larry Connors : au-dessus de la moyenne 200 jours, acheter quand la somme des RSI 2 des deux derniers jours passe sous 35 ; revendre quand le RSI 2 dépasse 65. Stop 3 ATR.',
    evaluate(ind, i) {
      const s = ind.rsi2sum[i];
      return {
        entry: s !== null && s < 35 && ind.closes[i] > ind.sma200[i] ? 'long' : null,
        exitLong: ind.rsi2[i] > 65,
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...NAS2,
    id: 'pctb',
    name: 'Bollinger %b sous 0 dans la tendance',
    desc: 'Retour à la moyenne : au-dessus de la moyenne 200 jours, acheter une clôture sous la bande de Bollinger basse (%b < 0) ; revendre au retour sur la moyenne 20 jours. Stop 3 ATR.',
    evaluate(ind, i) {
      const b = ind.pctB[i];
      return {
        entry: b !== null && b < 0 && ind.closes[i] > ind.sma200[i] ? 'long' : null,
        exitLong: ind.closes[i] >= ind.bb.mid[i],
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...NAS2,
    id: 'lowvol',
    name: 'Régime de volatilité basse',
    desc: 'Les krachs arrivent quand la volatilité explose : investi quand la volatilité des 20 derniers jours est sous sa moyenne d’un an ET l’indice au-dessus de sa moyenne 200 jours ; sortie si la volatilité dépasse de 10 % sa moyenne ou si l’indice passe 2 % sous sa moyenne 200. Stop 5 ATR.',
    evaluate(ind, i) {
      const v = ind.rv20[i];
      const a = ind.rv20avg[i];
      const c = ind.closes[i];
      const ok = v !== null && a !== null;
      return {
        entry: ok && v < a && c > ind.sma200[i] ? 'long' : null,
        exitLong: !ok || v > 1.1 * a || c < 0.98 * ind.sma200[i],
        exitShort: true,
        sl: 5 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...NAS2,
    id: 'rates',
    needsTnx: true,
    name: 'Taux US en baisse',
    desc: 'Les valeurs de croissance (tech) profitent de la baisse des taux : investi quand le taux 10 ans US est sous sa moyenne 50 jours ET le Nasdaq au-dessus de sa moyenne 50 jours ; sortie dès qu’une condition tombe. Stop 4 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const on = (k) => belowAvg(ind.tnx, k) && c[k] > ind.sma50[k];
      return { entry: became(on, i) ? 'long' : null, exitLong: !on(i), exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    ...NAS2,
    id: 'dip5',
    name: 'Repli de 5 % dans la tendance',
    desc: 'Maison : au-dessus de la moyenne 200 jours, acheter quand l’indice clôture 5 % sous son plus haut de 20 jours ; revendre quand il retrouve son plus haut de 20 jours. Stop 3 ATR.',
    evaluate(ind, i) {
      const c = ind.closes[i];
      return {
        entry: c <= 0.95 * ind.c20.max[i] && c > ind.sma200[i] ? 'long' : null,
        exitLong: c >= ind.c20.max[i],
        exitShort: true,
        sl: 3 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...NAS2,
    id: 'tuesday',
    name: '« Turnaround Tuesday »',
    desc: 'Effet de calendrier connu des traders : un lundi en baisse est souvent suivi d’un mardi en hausse. Achat à la clôture d’un lundi baissier (au-dessus de la moyenne 200 jours), revente à la clôture suivante. Stop 2 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const monday = ind.weekday[i] === 1;
      return {
        entry: monday && c[i] < c[i - 1] && c[i] > ind.sma200[i] ? 'long' : null,
        exitLong: !monday,
        exitShort: true,
        sl: 2 * ind.atr[i],
        tp: null,
      };
    },
  },
);

/* ------------------------------------------------------------------ */
/* Lot 4 : tendance multi-horizons, momentum relatif, marchés liés      */
/* ------------------------------------------------------------------ */

const BOTH = { tf: '1d', markets: ['gold', 'nas100'], warmup: 260 };
const pos = (x) => x !== null && x > 0;

STRATEGIES.push(
  {
    ...BOTH,
    id: 'golden',
    name: 'Croix dorée (moyennes 50 / 200)',
    desc: 'Le signal de tendance le plus suivi : investi tant que la moyenne 50 jours est au-dessus de la moyenne 200 jours (« croix dorée »), dehors après la « croix de la mort ». Stop de protection 5 ATR.',
    evaluate(ind, i) {
      const up = ind.sma50[i] !== null && ind.sma200[i] !== null && ind.sma50[i] > ind.sma200[i];
      return { entry: up ? 'long' : null, exitLong: !up, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...BOTH,
    id: 'trendmix',
    name: 'Tendance sur 4 horizons',
    desc: 'Maison, inspirée des fonds « trend following » : on regarde si le prix a monté sur 1, 3, 6 et 12 mois. Investi quand au moins 3 horizons sur 4 sont en hausse, sortie quand il n’en reste qu’un ou aucun. Stop 5 ATR.',
    evaluate(ind, i) {
      const score = [ind.roc21[i], ind.roc63[i], ind.roc126[i], ind.roc252[i]].filter(pos).length;
      return { entry: score >= 3 ? 'long' : null, exitLong: score <= 1, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...BOTH,
    id: 'mom12_1',
    name: 'Momentum 12 mois sauf le dernier',
    desc: 'Variante académique du momentum (Jegadeesh & Titman) : la hausse des 12 derniers mois en ignorant le dernier mois, souvent trompeur à court terme. Investi si elle est positive, dehors sinon. Stop 5 ATR.',
    evaluate(ind, i) {
      const c = ind.closes;
      const up = i >= 252 && c[i - 21] / c[i - 252] > 1;
      return { entry: up ? 'long' : null, exitLong: !up, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...BOTH,
    id: 'dualmom',
    needsAux: ['peer'],
    name: 'Double momentum or / Nasdaq',
    desc: 'Antonacci (« Dual Momentum ») : chaque mois, on compare la hausse sur 12 mois de l’or et du Nasdaq. Investi dans ce marché seulement s’il a monté ET s’il fait mieux que l’autre ; les deux comptes se passent donc le relais. Stop 5 ATR.',
    evaluate(ind, i) {
      const own = ind.roc252[i];
      const other = ind.peer.r252[i];
      const best = own !== null && own > 0 && (other === null || own > other);
      return { entry: best ? 'long' : null, exitLong: !best, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'season200',
    name: 'Saison de l’or + tendance',
    desc: 'Combinaison de deux stratégies retenues : investi d’août à février (saison) SEULEMENT si l’or est au-dessus de sa moyenne 200 jours. Moins de temps sur le marché, moins de baisses subies. Stop 4 ATR.',
    evaluate(ind, i) {
      const m = ind.month[i];
      const on = (m >= 8 || m <= 2) && ind.closes[i] > ind.sma200[i];
      return { entry: on ? 'long' : null, exitLong: !on, exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'seasonplus',
    name: 'Saison de l’or OU tendance',
    desc: 'Investi d’août à février (saison), et aussi le reste de l’année quand l’or est nettement au-dessus de sa moyenne 200 jours (+2 %). Garde la saison et profite des grandes hausses de printemps. Stop 4 ATR.',
    evaluate(ind, i) {
      const m = ind.month[i];
      const c = ind.closes[i];
      const s200 = ind.sma200[i];
      const inSeason = m >= 8 || m <= 2;
      return {
        entry: inSeason || c > 1.02 * s200 ? 'long' : null,
        exitLong: !inSeason && c < 0.98 * s200,
        exitShort: true,
        sl: 4 * ind.atr[i],
        tp: null,
      };
    },
  },
  {
    ...GOLD,
    id: 'silver',
    needsAux: ['silver'],
    name: 'Argent en tête (ratio or / argent)',
    desc: 'Quand l’argent monte plus vite que l’or (le ratio or / argent passe sous sa moyenne 50 jours), c’est souvent le début d’un mouvement haussier de tous les métaux. Achat de l’or si en plus il est au-dessus de sa moyenne 50 ; sortie dès qu’une condition tombe. Stop 3 ATR.',
    evaluate(ind, i) {
      const g = ind.gsr;
      const on = (k) => g.r[k] !== null && g.avg[k] !== null && g.r[k] < g.avg[k] && ind.closes[k] > ind.sma50[k];
      return { entry: became(on, i) ? 'long' : null, exitLong: !on(i), exitShort: true, sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    ...GOLD,
    id: 'riskoff',
    needsAux: ['peer'],
    name: 'Refuge quand la Bourse baisse',
    desc: 'L’or est acheté quand les actions vont mal : investi quand le Nasdaq 100 est sous sa moyenne 50 jours ET l’or au-dessus de la sienne ; sortie quand le Nasdaq repasse au-dessus ou que l’or casse sa moyenne. Stop 3 ATR.',
    evaluate(ind, i) {
      const p = ind.peer;
      const on = (k) => p.c[k] !== null && p.sma50[k] !== null && p.c[k] < p.sma50[k] && ind.closes[k] > ind.sma50[k];
      return { entry: became(on, i) ? 'long' : null, exitLong: !on(i), exitShort: true, sl: 3 * ind.atr[i], tp: null };
    },
  },
  {
    ...NAS2,
    id: 'macro',
    needsVix: true,
    needsTnx: true,
    name: 'Feu vert macro (tendance, peur, taux)',
    desc: 'Maison : trois feux — Nasdaq au-dessus de sa moyenne 200 jours, VIX sous sa moyenne 50 jours, taux 10 ans US sous sa moyenne 50 jours. Investi quand au moins 2 feux sur 3 sont verts, dehors quand il en reste un ou aucun. Stop 5 ATR.',
    evaluate(ind, i) {
      const score = (ind.closes[i] > ind.sma200[i]) + belowAvg(ind.vix, i) + belowAvg(ind.tnx, i);
      return { entry: score >= 2 ? 'long' : null, exitLong: score <= 1, exitShort: true, sl: 5 * ind.atr[i], tp: null };
    },
  },
  {
    ...NAS2,
    id: 'sox',
    needsAux: ['sox'],
    name: 'Les semi-conducteurs montrent la voie',
    desc: 'Les puces (indice SOX) anticipent souvent le reste de la tech : investi quand le SOX ET le Nasdaq sont au-dessus de leur moyenne 50 jours, sortie dès que l’un passe en dessous. Stop 4 ATR.',
    evaluate(ind, i) {
      const on = (k) => aboveAvg(ind.sox, k) && ind.closes[k] > ind.sma50[k];
      return { entry: on(i) ? 'long' : null, exitLong: !on(i), exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
  },
  {
    ...NAS2,
    id: 'dollarweak',
    needsDxy: true,
    name: 'Dollar faible',
    desc: 'Un dollar qui baisse aide les grandes entreprises tech (revenus à l’étranger) : investi quand l’indice du dollar (DXY) est sous sa moyenne 50 jours ET le Nasdaq au-dessus de la sienne ; sortie dès qu’une condition tombe. Stop 4 ATR.',
    evaluate(ind, i) {
      const on = (k) => belowAvg(ind.dxy, k) && ind.closes[k] > ind.sma50[k];
      return { entry: on(i) ? 'long' : null, exitLong: !on(i), exitShort: true, sl: 4 * ind.atr[i], tp: null };
    },
  },
);

/* ------------------------------------------------------------------ */
/* Versions « achat seul » (indices actions : les ventes à découvert    */
/* y font perdre sur le long terme)                                    */
/* ------------------------------------------------------------------ */

function longOnly(base, tf = base.tf) {
  return {
    ...base,
    tf,
    id: `${base.id}_long`,
    name: `${base.name} (achat seul)`,
    desc: `${base.desc} Version achat seul : ne vend jamais à découvert.`,
    evaluate(ind, i) {
      const s = base.evaluate(ind, i);
      return { ...s, entry: s.entry === 'long' ? 'long' : null, exitShort: true };
    },
  };
}

STRATEGIES.push(longOnly(STRATEGIES.find((s) => s.id === 'macd'), '1d'), longOnly(STRATEGIES.find((s) => s.id === 'ema'), '1d'));

/* Scalp 2e série (or et Nasdaq, bougies 1 / 5 min) : voir src/scalp2.js et npm run scalp2 */
{
  const { SCALP2, computeScalp2 } = require('./scalp2');
  STRATEGIES.push(...SCALP2.map((s) => ({ ...s, compute: (candles, barSec, market) => computeScalp2(candles, barSec, market) })));
}

/* Stratégies « style FTMO » (stop clair, taille au risque) : voir src/ftmostrats.js et npm run ftmo */
STRATEGIES.push(...require('./ftmostrats').FTMO);

/* Retour à la moyenne dans la tendance (famille de x_rsi2) : voir src/meanrev.js et npm run ftmo-mr */
STRATEGIES.push(...require('./meanrev').MEANREV);

/* Nasdaq : effets documentés (nuit, gap, première heure, veille de férié) : voir src/nas2.js */
STRATEGIES.push(...require('./nas2').NAS2);

/* Or : nouvelles stratégies (journalières + séance asiatique) : voir src/gold2.js et npm run gold-new */
STRATEGIES.push(...require('./gold2').GOLD2);
STRATEGIES.push(...require('./nasintra').NASINTRA);
STRATEGIES.push(...require('./research2').RESEARCH2);
STRATEGIES.push(...require('./goldmom').GOLDMOM);
// Séances d'Asie et de New York (npm run sessions) : à l'essai en paper trading
STRATEGIES.push(...require('./sessions').SESSIONS);
STRATEGIES.push(...require('./events').EVENTS);

/* Intraday NAS100 (formation TradingView, module 5) : voir src/intraday.js */
STRATEGIES.push(...require('./intraday').INTRADAY);

/* ------------------------------------------------------------------ */
/* Unités de temps                                                     */
/* ------------------------------------------------------------------ */

const TF_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400 };
const tfOf = (s) => s.tf || '1h';

/** Copie d'une stratégie sur une autre unité de temps (id « ema@6h »). */
function withTf(s, tf) {
  if (tf === tfOf(s)) return s;
  return { ...s, tf, id: `${s.id}@${tf}`, name: `${s.name} [${tf}]` };
}

/** ids : 'all', ou liste d'ids, éventuellement suffixés d'une unité de temps (« ema@6h »). */
function selectStrategies(ids) {
  if (!ids || !ids.length || ids.includes('all')) return STRATEGIES.filter((s) => !s.scalp && !s.markets && !s.intraday);
  const out = [];
  for (const id of ids) {
    const [base, tf] = id.split('@');
    const s = STRATEGIES.find((x) => x.id === base);
    if (s && TF_SEC[tf || tfOf(s)]) out.push(tf ? withTf(s, tf) : s);
  }
  return out;
}

module.exports = { STRATEGIES, selectStrategies, withTf, tfOf, TF_SEC };
