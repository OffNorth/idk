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

/* ------------------------------------------------------------------ */
/* Unités de temps                                                     */
/* ------------------------------------------------------------------ */

const TF_SEC = { '1m': 60, '5m': 300, '1h': 3600, '6h': 21600, '1d': 86400 };
const tfOf = (s) => s.tf || '1h';

/** Copie d'une stratégie sur une autre unité de temps (id « ema@6h »). */
function withTf(s, tf) {
  if (tf === tfOf(s)) return s;
  return { ...s, tf, id: `${s.id}@${tf}`, name: `${s.name} [${tf}]` };
}

/** ids : 'all', ou liste d'ids, éventuellement suffixés d'une unité de temps (« ema@6h »). */
function selectStrategies(ids) {
  if (!ids || !ids.length || ids.includes('all')) return STRATEGIES.filter((s) => !s.scalp);
  const out = [];
  for (const id of ids) {
    const [base, tf] = id.split('@');
    const s = STRATEGIES.find((x) => x.id === base);
    if (s && TF_SEC[tf || tfOf(s)]) out.push(tf ? withTf(s, tf) : s);
  }
  return out;
}

module.exports = { STRATEGIES, selectStrategies, withTf, tfOf, TF_SEC };
