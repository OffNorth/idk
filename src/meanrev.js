/**
 * Retour à la moyenne dans la tendance (famille de x_rsi2, la seule stratégie qui passe le challenge FTMO) :
 * dans une tendance haussière de l'unité supérieure (1 h pour les bougies 5 / 15 min, le jour pour les bougies 1 h),
 * acheter un petit excès de baisse et revendre au rebond ; l'inverse en tendance baissière. Stop 1,5 ATR.
 * Testées sur 5 min, 15 min et 1 h, or et Nasdaq (npm run ftmo). Indicateurs : src/scalp2.js (computeScalp2).
 */
const { computeScalp2, helpers } = require('./scalp2');

const { active, flat, trendUp, trendDown } = helpers;
const BASE = {
  tf: '15m', onlyTf: ['5m', '15m', '1h'], scalp: true, meanrev: true, warmup: 700, markets: ['gold', 'nas100'],
  compute: (candles, barSec, market) => computeScalp2(candles, barSec, market),
};

/** Construit le signal : `buy(x, i)` / `sell(x, i)` = excès ; `exitL` / `exitS` = rebond. */
function mr(x, i, { buy, sell, exitL, exitS }) {
  const out = { entry: null, exitLong: flat(x, i) || exitL(x, i), exitShort: flat(x, i) || exitS(x, i), sl: 1.5 * x.atr[i], tp: null };
  if (!active(x, i)) return out;
  if (trendUp(x, i) && buy(x, i)) return { ...out, entry: 'long' };
  if (trendDown(x, i) && sell(x, i)) return { ...out, entry: 'short' };
  return out;
}

const MEANREV = [
  {
    ...BASE,
    id: 'm_ibs',
    name: 'Clôture au plus bas de la bougie, dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; la bougie clôture dans les 15 % les plus bas de son range et sous l’EMA 20 → achat ; sortie quand une bougie clôture dans le haut de son range (IBS > 0,7) ou au-dessus du plus haut précédent. Stop 1,5 ATR. Inverse en tendance baissière.',
    evaluate(x, i) {
      const k = x.candles;
      return mr(x, i, {
        buy: () => x.ibs[i] < 0.15 && x.closes[i] < x.ema20[i],
        sell: () => x.ibs[i] > 0.85 && x.closes[i] > x.ema20[i],
        exitL: () => x.ibs[i] > 0.7 || k[i].c > k[i - 1].h,
        exitS: () => x.ibs[i] < 0.3 || k[i].c < k[i - 1].l,
      });
    },
  },
  {
    ...BASE,
    id: 'm_bb',
    name: 'Sous la bande de Bollinger, dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; clôture sous la bande de Bollinger basse (20, 2) → achat ; sortie au retour sur la moyenne 20. Stop 1,5 ATR. Inverse au-dessus de la bande haute en tendance baissière.',
    evaluate(x, i) {
      const c = x.closes[i];
      return mr(x, i, {
        buy: () => x.bb.lower[i] !== null && c < x.bb.lower[i],
        sell: () => x.bb.upper[i] !== null && c > x.bb.upper[i],
        exitL: () => c >= x.bb.mid[i],
        exitS: () => c <= x.bb.mid[i],
      });
    },
  },
  {
    ...BASE,
    id: 'm_down3',
    name: '3 bougies de baisse dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; 3 clôtures en baisse d’affilée → achat ; sortie à la première clôture en hausse. Stop 1,5 ATR. Inverse (3 hausses) en tendance baissière.',
    evaluate(x, i) {
      const c = x.closes;
      return mr(x, i, {
        buy: () => c[i] < c[i - 1] && c[i - 1] < c[i - 2] && c[i - 2] < c[i - 3],
        sell: () => c[i] > c[i - 1] && c[i - 1] > c[i - 2] && c[i - 2] > c[i - 3],
        exitL: () => c[i] > c[i - 1],
        exitS: () => c[i] < c[i - 1],
      });
    },
  },
  {
    ...BASE,
    id: 'm_vwap',
    name: 'Écart au VWAP dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; le prix tombe à plus de 1,5 ATR sous le VWAP de la séance → achat ; sortie au retour sur le VWAP. Stop 1,5 ATR. Inverse au-dessus du VWAP en tendance baissière.',
    evaluate(x, i) {
      const c = x.closes[i];
      const v = x.vwap[i];
      return mr(x, i, {
        buy: () => v !== null && c < v - 1.5 * x.atr[i],
        sell: () => v !== null && c > v + 1.5 * x.atr[i],
        exitL: () => v === null || c >= v,
        exitS: () => v === null || c <= v,
      });
    },
  },
  {
    ...BASE,
    id: 'm_rsi2x',
    name: 'RSI 2 extrême + clôture basse',
    desc: 'Variante plus sélective de x_rsi2 : tendance haussière de l’unité supérieure, RSI 2 sous 10 ET clôture dans le bas de la bougie (IBS < 0,3) → achat ; sortie RSI 2 > 60. Stop 1,5 ATR. Inverse en tendance baissière.',
    evaluate(x, i) {
      const r = x.rsi2[i];
      return mr(x, i, {
        buy: () => r < 10 && x.ibs[i] < 0.3,
        sell: () => r > 90 && x.ibs[i] > 0.7,
        exitL: () => r > 60,
        exitS: () => r < 40,
      });
    },
  },
  {
    ...BASE,
    id: 'm_wr',
    name: 'Williams %R au plancher, dans la tendance',
    desc: 'Larry Williams : tendance haussière de l’unité supérieure et Williams %R (10) sous −95 (clôture tout en bas des 10 dernières bougies) → achat ; sortie quand il remonte au-dessus de −30. Stop 1,5 ATR. Inverse au-dessus de −5 en tendance baissière.',
    evaluate(x, i) {
      const w = x.wr10[i];
      return mr(x, i, { buy: () => w !== null && w < -95, sell: () => w !== null && w > -5, exitL: () => w > -30, exitS: () => w < -70 });
    },
  },
  {
    ...BASE,
    id: 'm_keltner',
    name: 'Sous le canal de Keltner, dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; clôture sous le bas du canal de Keltner (EMA 20 − 2 ATR) → achat ; sortie au retour sur l’EMA 20. Stop 1,5 ATR. Inverse au-dessus du canal en tendance baissière.',
    evaluate(x, i) {
      const c = x.closes[i];
      return mr(x, i, { buy: () => c < x.kDn[i], sell: () => c > x.kUp[i], exitL: () => c >= x.ema20[i], exitS: () => c <= x.ema20[i] });
    },
  },
  {
    ...BASE,
    id: 'm_cci',
    name: 'CCI très bas, dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; CCI (20) sous −150 (prix très en dessous de sa moyenne habituelle) → achat ; sortie quand le CCI repasse au-dessus de 0. Stop 1,5 ATR. Inverse au-dessus de +150 en tendance baissière.',
    evaluate(x, i) {
      const v = x.cci20[i];
      return mr(x, i, { buy: () => v !== null && v < -150, sell: () => v !== null && v > 150, exitL: () => v === null || v > 0, exitS: () => v === null || v < 0 });
    },
  },
  {
    ...BASE,
    id: 'm_stoch',
    name: 'Stochastique rapide qui repart, dans la tendance',
    desc: 'Tendance haussière de l’unité supérieure ; le stochastique rapide (14, 3) était sous 10 et repart à la hausse → achat ; sortie au-dessus de 70. Stop 1,5 ATR. Inverse en tendance baissière.',
    evaluate(x, i) {
      const k = x.stochK;
      return mr(x, i, {
        buy: () => k[i - 1] !== null && k[i - 1] < 10 && k[i] > k[i - 1],
        sell: () => k[i - 1] !== null && k[i - 1] > 90 && k[i] < k[i - 1],
        exitL: () => k[i] > 70,
        exitS: () => k[i] < 30,
      });
    },
  },
  {
    ...BASE,
    id: 'm_2ll',
    name: 'Deux plus bas plus bas, dans la tendance',
    desc: 'Connors : tendance haussière de l’unité supérieure ; deux bougies d’affilée font un plus bas plus bas ET clôturent sous l’EMA 20 → achat ; sortie à la première clôture au-dessus du plus haut précédent. Stop 1,5 ATR. Inverse (deux plus hauts plus hauts) en tendance baissière.',
    evaluate(x, i) {
      const k = x.candles;
      const c = x.closes[i];
      return mr(x, i, {
        buy: () => k[i].l < k[i - 1].l && k[i - 1].l < k[i - 2].l && c < x.ema20[i],
        sell: () => k[i].h > k[i - 1].h && k[i - 1].h > k[i - 2].h && c > x.ema20[i],
        exitL: () => c > k[i - 1].h,
        exitS: () => c < k[i - 1].l,
      });
    },
  },
];

module.exports = { MEANREV };
