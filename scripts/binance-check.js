/**
 * Vérifie que les bougies publiques Binance (or XAUUSDT, argent XAGUSDT) sont joignables depuis cette machine,
 * sans compte ni clé, et mesure l'écart avec Yahoo (GC=F / SI=F). npm run binance-check
 */
const binance = require('../src/binance');
const { fetchYahoo } = require('../src/yahoo');

(async () => {
  for (const [id, ysym] of [['gold', 'GC=F'], ['silver', 'SI=F']]) {
    const sym = binance.SYMBOL[id];
    try {
      const b = await binance.klines(sym, 300, { limit: 300 });
      const last = b[b.length - 1];
      const age = Math.round((Date.now() / 1000 - last.t) / 60);
      let gap = '';
      try {
        const y = await fetchYahoo(ysym, '5m', { range: '5d' });
        const ym = new Map(y.map((c) => [c.t, c.c]));
        const d = b.filter((c) => ym.has(c.t)).slice(-12).map((c) => c.c - ym.get(c.t)).sort((x, z) => x - z);
        if (d.length) gap = `, écart avec Yahoo ${ysym} : ${d[Math.floor(d.length / 2)].toFixed(2)} (corrigé automatiquement)`;
      } catch { /* Yahoo indisponible */ }
      console.log(`✅ ${sym} joignable : dernier cours ${last.c} (bougie d'il y a ${age} min)${gap}`);
    } catch (err) {
      console.log(`❌ ${sym} injoignable (${err.message}) : le bot restera sur Yahoo pour ${id === 'gold' ? "l'or" : "l'argent"}`);
    }
  }
  console.log(binance.openNow() ? 'Marché des métaux ouvert.' : 'Marché des métaux fermé (week-end ou pause de 17 h à New York) : le bot ne trade pas maintenant.');
})();
