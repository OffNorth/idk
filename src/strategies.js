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

function selectStrategies(ids) {
  if (!ids || !ids.length || ids.includes('all')) return STRATEGIES;
  return STRATEGIES.filter((s) => ids.includes(s.id));
}

module.exports = { STRATEGIES, selectStrategies };
