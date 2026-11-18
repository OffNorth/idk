/**
 * Variantes de scalps « retour à la moyenne dans la tendance 1 h » (RSI, IBS, Bollinger, Williams %R, Keltner) partagées
 * par les bancs d'essai (ftmo-grid.js, ftmo-long.js) ; `toStrategy` en fait une stratégie pour backtest().
 */
const { rsi, ema } = require('./indicators');
const { helpers } = require('./scalp2');

const { active, flat, trendUp, trendDown } = helpers;

/** Variantes de retour à la moyenne dans la tendance 1 h (mêmes familles que gold-scalp-grid.js). */
function variants(x) {
  const cl = x.closes;
  const R = {};
  const rs = (k) => (R[k] ||= rsi(cl, k));
  const m20 = x.bb.mid;
  const sd = cl.map((_, i) => { if (i < 19) return null; let s = 0; for (let j = i - 19; j <= i; j++) s += (cl[j] - m20[i]) ** 2; return Math.sqrt(s / 20); });
  const e20 = ema(cl, 20);
  const V = [];
  const add = (name, buy, sell, exitL, exitS) => V.push({ name, buy, sell, exitL, exitS });
  for (const k of [2, 3, 4]) for (const lo of [3, 5, 10, 15]) for (const ex of [50, 60, 70])
    add(`RSI ${k} < ${lo} sortie ${ex}`, (i) => rs(k)[i] < lo, (i) => rs(k)[i] > 100 - lo, (i) => rs(k)[i] > ex, (i) => rs(k)[i] < 100 - ex);
  for (const lo of [0.1, 0.15, 0.2]) for (const ex of ['ibs', 'haut'])
    add(`IBS < ${lo} sortie ${ex}`, (i) => x.ibs[i] < lo && cl[i] < e20[i], (i) => x.ibs[i] > 1 - lo && cl[i] > e20[i],
      (i) => (ex === 'ibs' ? x.ibs[i] > 0.7 : cl[i] > x.candles[i - 1].h), (i) => (ex === 'ibs' ? x.ibs[i] < 0.3 : cl[i] < x.candles[i - 1].l));
  for (const z of [1.5, 2, 2.5, 3])
    add(`Bollinger ${z} σ`, (i) => sd[i] && cl[i] < m20[i] - z * sd[i], (i) => sd[i] && cl[i] > m20[i] + z * sd[i], (i) => cl[i] >= m20[i], (i) => cl[i] <= m20[i]);
  for (const w of [-90, -95, -98]) for (const ex of [-50, -30])
    add(`Williams ${w} sortie ${ex}`, (i) => x.wr10[i] !== null && x.wr10[i] < w, (i) => x.wr10[i] !== null && x.wr10[i] > -100 - w, (i) => x.wr10[i] > ex, (i) => x.wr10[i] < -100 - ex);
  for (const k of [1.5, 2, 2.5, 3])
    add(`Keltner ${k} ATR`, (i) => cl[i] < e20[i] - k * x.atr[i], (i) => cl[i] > e20[i] + k * x.atr[i], (i) => cl[i] >= e20[i], (i) => cl[i] <= e20[i]);
  return V;
}

/** Stratégie de backtest d'une variante (indicateurs `x` de computeScalp2 déjà calculés), stop 1,5 ATR. */
function toStrategy(x, v, tf) {
  return {
    id: 'grid', tf, warmup: 700,
    evaluate(ind, i) {
      const out = { entry: null, exitLong: flat(x, i) || v.exitL(i), exitShort: flat(x, i) || v.exitS(i), sl: 1.5 * x.atr[i], tp: null };
      if (!active(x, i)) return out;
      if (trendUp(x, i) && v.buy(i)) return { ...out, entry: 'long' };
      if (trendDown(x, i) && v.sell(i)) return { ...out, entry: 'short' };
      return out;
    },
  };
}

module.exports = { variants, toStrategy };
