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
  name: 'Référence : achat-conservation',
  desc: 'Pas une stratégie : achète l’or au démarrage et le garde. Sert de point de comparaison — une stratégie qui ne fait pas mieux n’apporte rien.',
  warmup: 1,
  evaluate(ind, i) {
    return { entry: 'long', exitLong: false, exitShort: false, sl: ind.closes[i] * 0.9, tp: null };
  },
});

function selectStrategies(ids) {
  if (!ids || !ids.length || ids.includes('all')) return STRATEGIES;
  return STRATEGIES.filter((s) => ids.includes(s.id));
}

module.exports = { STRATEGIES, selectStrategies };
