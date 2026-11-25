/**
 * Actions et ETF tradés par le compte FTMO (CFD, séance de New York seulement) — npm run world-research, 25/11/2026 :
 * stratégies intraday stables sur 2 ans (QQQ-like, Polygon 5 min), ajoutées ensemble au compte FTMO (réussite récente
 * 67 → 69 %, 55 → 50 j ; choix de l'utilisateur). Levier FTMO sur les actions : 1:5 au plus.
 */
const STOCKS = {
  tlt: { name: 'Obligations US (TLT)', symbol: 'TLT', code: 'TLT', tv: 'NASDAQ:TLT' },
  googl: { name: 'Alphabet (Google)', symbol: 'GOOGL', code: 'GOOGL', tv: 'NASDAQ:GOOGL' },
  pltr: { name: 'Palantir', symbol: 'PLTR', code: 'PLTR', tv: 'NASDAQ:PLTR' },
  lly: { name: 'Eli Lilly', symbol: 'LLY', code: 'LLY', tv: 'NYSE:LLY' },
  ba: { name: 'Boeing', symbol: 'BA', code: 'BA', tv: 'NYSE:BA' },
};
const STOCK_LEVERAGE = 5;
module.exports = { STOCKS, STOCK_IDS: Object.keys(STOCKS), STOCK_LEVERAGE };
