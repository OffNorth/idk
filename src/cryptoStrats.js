/**
 * Crypto (BTC, ETH, contrats perpétuels Binance) : cassure 4 h confirmée par le volume et le VRAI delta (achats agressifs
 * − ventes agressives, champ « taker buy volume » des bougies Binance). Proposition de l'utilisateur (28/11/2026),
 * vérifiée par npm run crypto4h et npm run lucid-ideas3 (idée 19) :
 *   seule, frais et funding compris : BTC +0,36 R (397 trades 2020–2026), ETH +0,29 R ; achats +0,59 / +0,44 R,
 *   ventes ≈ +0,1 R (biais haussier du crypto) ;
 *   compte FTMO, ACHATS SEULS à 0,25 % : réussite < 1 an 51 / 53 / 84 % → 50 / 66 / 84 % (2009–19 | 2020–26 | nov. 24–26).
 * Entrée (clôture 4 h) : clôture > plus haut des 20 bougies précédentes, volume et delta ≥ moyenne + 0,5 écart-type
 * (20 bougies). Stop 1,5 ATR(14), puis stop suiveur à 3 ATR du meilleur cours de clôture ; 10 jours au plus.
 */
const N = 20;
const K = 0.5;

function compute(candles) {
  const closes = candles.map((c) => c.c);
  const atr = []; let a = 0;
  candles.forEach((b, i) => { const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - candles[i - 1].c), Math.abs(b.l - candles[i - 1].c)) : b.h - b.l; a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(a); });
  const vol = candles.map((c) => c.v);
  const del = candles.map((c) => (Number.isFinite(c.bv) ? 2 * c.bv - c.v : NaN)); // sans « taker buy » : pas de delta → pas d'entrée
  const z = (arr, i) => {
    let s = 0, s2 = 0;
    for (let k = i - N; k < i; k++) { s += arr[k]; s2 += arr[k] * arr[k]; }
    const m = s / N, sd = Math.sqrt(Math.max(1e-12, s2 / N - m * m));
    return (arr[i] - m) / sd;
  };
  const hi = candles.map((_, i) => (i < N ? NaN : Math.max(...candles.slice(i - N, i).map((c) => c.h))));
  return { closes, atr, hi, zVol: candles.map((_, i) => (i < N ? NaN : z(vol, i))), zDelta: candles.map((_, i) => (i < N ? NaN : z(del, i))) };
}

const CRYPTO = [{
  id: 'x_brk4h',
  name: 'Crypto: 4h breakout with volume and delta',
  desc: '4-hour candle closing above the high of the previous 20, with volume and delta (aggressive buys minus aggressive sells, from Binance) above their average by 0.5 standard deviation. Buys only (the edge on sells is close to zero). Stop 1.5 ATR, then trailing stop 3 ATR from the best close; 10 days at most. FTMO account only, 0.25% risk.',
  tf: '4h',
  markets: ['btc', 'eth'], // réservée au crypto (bougies Binance avec delta)
  warmup: N + 15,
  maxHoldSec: 10 * 86400,
  compute: (candles) => compute(candles),
  evaluate(ind, i) {
    const c = ind.closes[i];
    const go = c > ind.hi[i] && ind.zVol[i] >= K && ind.zDelta[i] >= K;
    return { entry: go ? 'long' : null, exitLong: false, exitShort: true, sl: 1.5 * ind.atr[i], tp: null };
  },
  trail(pos, ind, i) {
    return pos.side === 'long' ? pos.best - 3 * ind.atr[i] : pos.best + 3 * ind.atr[i];
  },
}];

module.exports = { CRYPTO, compute };
