/**
 * Catalogue des stratégies : famille, verdict du banc d'essai et résultat résumé.
 * Le statut « active » ne figure pas ici : il dépend de GOLD_STRATEGIES / NAS_STRATEGIES (voir config).
 *   verdict : 'retenue' (passe le test), 'dispo' (positive mais pas retenue), 'essai', 'rejet'
 *   Résultats : gains réinvestis, or 2001–2026 (frais 0,05 %), Nasdaq 2010–2026 (CFD, frais 0,01 % + financement 6 %/an).
 */
const { STRATEGIES, selectStrategies, tfOf } = require('./strategies');

const FAMILIES = [
  ['Premières stratégies (guides fournis)', ['macd', 'ema', 'breakout', 'meanrev', 'supertrend', 'sma1060', 'pvt', 'fibo']],
  ['Maison', ['tsmom', 'tsmom_ls', 'turtle', 'rsi2', 'pullback', 'keltner', 'asia']],
  ['Analyse technique classique', ['ichimoku', 'adx', 'squeeze', 'ribbon', 'insidebar', 'heikin', 'vote', 'dollar']],
  ['Spécifiques à l’or', ['season', 'seasonplus', 'season200', 'mom12', 'high52', 'silver', 'riskoff', 'yields', 'dxy', 'fear']],
  ['Tendance multi-horizons (or + Nasdaq)', ['golden', 'trendmix', 'mom12_1', 'dualmom']],
  ['Spécifiques au Nasdaq', ['sma200', 'macro', 'lowvol', 'vixcalm', 'halloween', 'rates', 'macd_long', 'sox', 'dollarweak', 'ibs', 'cumrsi', 'ema_long', 'tom', 'double7', 'down3', 'dip5', 'vixspike', 'tuesday', 'pctb']],
  ['Effets de calendrier Nasdaq', ['n_overnight', 'n_preholiday', 'n_gapfill', 'n_firsthour']],
  ['Intraday Nasdaq (5 min)', ['sweep', 'orb15', 'vwappb']],
  ['Scalp (1–5 min)', ['s_emavwap', 's_vwaprev', 's_bbrsi', 's_orb', 's_stoch', 's_burst']],
  ['Style FTMO (stop clair, taille au risque)', ['f_pullback', 'f_pdbreak', 'f_nightbreak', 'f_insideday', 'f_nr7', 'f_weekbreak']],
  ['Retour à la moyenne dans la tendance (FTMO)', ['m_bb', 'm_ibs', 'm_rsi2x', 'm_wr', 'm_keltner', 'm_vwap', 'm_down3', 'm_cci', 'm_stoch', 'm_2ll']],
  ['Scalp 2e série (or et Nasdaq, 1–5 min)', ['x_rsi2', 'x_trendpb', 'x_vwapbounce', 'x_rangesweep', 'x_pdsweep', 'x_orb5', 'x_lasthalf', 'x_squeeze', 'x_break20']],
  ['Référence', ['hold']],
];

const VERDICT = {
  macd: ['retenue', 'Or +1,8 %/an'],
  ema: ['rejet', 'Or −0,2 %/an'],
  breakout: ['rejet', 'perdante'],
  meanrev: ['rejet', 'perdante'],
  supertrend: ['rejet', 'instable selon les périodes'],
  sma1060: ['rejet', 'bonne sur 2021–2026, −1,1 %/an sur 25 ans'],
  pvt: ['rejet', 'perdante'],
  fibo: ['rejet', 'faible sur le long terme'],
  tsmom: ['retenue', 'Or +5,9 %/an · Nasdaq +3,9 %/an'],
  tsmom_ls: ['rejet', 'les ventes à découvert font perdre'],
  turtle: ['rejet', 'faible'],
  rsi2: ['dispo', 'Nasdaq +3,4 %/an'],
  pullback: ['rejet', ''],
  keltner: ['rejet', ''],
  asia: ['rejet', 'perdante'],
  ichimoku: ['rejet', 'pas assez solide'],
  adx: ['rejet', 'perdante'],
  squeeze: ['rejet', 'perdante'],
  ribbon: ['rejet', ''],
  insidebar: ['rejet', '≈ 0'],
  heikin: ['rejet', 'perdante'],
  vote: ['rejet', 'Or +1,1 %/an'],
  dollar: ['rejet', 'Or −1,1 %/an'],
  season: ['retenue', 'Or +9,6 %/an, pire baisse −22 %'],
  seasonplus: ['retenue', 'Or +10,5 %/an, pire baisse −30 % (garder l’or : −44 %)'],
  season200: ['dispo', 'Or +6,6 %/an'],
  mom12: ['retenue', 'Or +7,3 %/an · Nasdaq +8,0 %/an'],
  high52: ['retenue', 'Or +5,1 %/an, pire baisse −18 %'],
  silver: ['dispo', 'Or +2,9 %/an'],
  riskoff: ['rejet', 'Or −0,4 %/an'],
  yields: ['rejet', 'perdante sur 2000–2015'],
  dxy: ['rejet', 'perdante'],
  fear: ['rejet', 'perdante sur 2000–2015'],
  golden: ['retenue', 'Or +8,1 %/an · Nasdaq +10,1 %/an'],
  trendmix: ['retenue', 'Or +8,0 %/an · Nasdaq +8,6 %/an'],
  mom12_1: ['retenue', 'Or +8,4 %/an · Nasdaq +9,6 %/an'],
  dualmom: ['dispo', 'Or +4,2 %/an · Nasdaq +3,0 %/an'],
  sma200: ['retenue', 'Or +7,7 %/an · Nasdaq +7,0 %/an'],
  macro: ['retenue', 'Nasdaq +8,8 %/an, pire baisse −21 %'],
  lowvol: ['retenue', 'Nasdaq +5,5 %/an'],
  vixcalm: ['retenue', 'Nasdaq +5,3 %/an'],
  halloween: ['retenue', 'Nasdaq +5,1 %/an'],
  rates: ['retenue', 'Nasdaq +4,4 %/an, pire baisse −20 %'],
  macd_long: ['retenue', 'Nasdaq +3,6 %/an'],
  sox: ['dispo', 'Nasdaq +3,5 %/an'],
  dollarweak: ['rejet', 'Nasdaq +1,2 %/an'],
  ibs: ['dispo', 'Nasdaq +6,2 %/an, pas assez solide sur la période de choix'],
  cumrsi: ['dispo', 'Nasdaq +3,4 %/an'],
  ema_long: ['dispo', 'Nasdaq +3,3 %/an'],
  tom: ['dispo', 'Nasdaq +3,1 %/an'],
  double7: ['dispo', 'Nasdaq +3,1 %/an'],
  down3: ['dispo', 'Nasdaq +2,9 %/an'],
  dip5: ['dispo', 'Nasdaq +1,6 %/an'],
  vixspike: ['dispo', 'Nasdaq +1,4 %/an'],
  tuesday: ['rejet', 'Nasdaq 0 %/an'],
  pctb: ['rejet', 'Nasdaq −0,9 %/an'],
  sweep: ['essai', '+2,25 R en moyenne, mais 4 trades seulement'],
  orb15: ['rejet', '≈ 0 avant frais'],
  vwappb: ['rejet', 'perdante'],
  s_emavwap: ['rejet', 'perd même avant frais'],
  s_vwaprev: ['rejet', 'avantage trop petit face aux frais'],
  s_bbrsi: ['rejet', 'avantage disparu en vérification'],
  s_orb: ['rejet', 'perd même avant frais'],
  s_stoch: ['rejet', 'perd même avant frais'],
  s_burst: ['rejet', 'perd même avant frais'],
  x_rsi2: ['retenue', 'Or 5 min : 2,7 trades/jour, 64 % gagnants, positive chaque année 2020–2026 (frais 0,004 %) ; nulle en 1 min et sur le Nasdaq'],
  x_trendpb: ['rejet', 'perdante en 5 min ; ≈ 0 en 1 min après frais'],
  x_vwapbounce: ['rejet', 'trop rare, perdante'],
  x_rangesweep: ['rejet', 'perdante (5 % de gagnants en 1 min)'],
  x_pdsweep: ['rejet', '≈ 0 après frais'],
  x_orb5: ['essai', 'Nasdaq 5 min : 75 % de challenges FTMO réussis sur 2025–2026 mais perdante en 2024–2025 → à l’essai en direct ; perdante sur l’or'],
  x_lasthalf: ['essai', 'Nasdaq 5 min : 75 % de challenges FTMO réussis sur 2025–2026 mais perdante en 2024–2025 → à l’essai en direct ; perdante sur l’or'],
  x_squeeze: ['rejet', 'perdante'],
  x_break20: ['rejet', 'perdante sur l’or ; Nasdaq 1 min retenue au choix puis perdante en vérification'],
  f_pullback: ['rejet', 'or 1 h −0,07 R/trade, Nasdaq 1 h ≈ 0'],
  f_pdbreak: ['rejet', 'or 1 h −0,07 R/trade (choix), Nasdaq 1 h perdante en vérification'],
  f_nightbreak: ['rejet', 'or 1 h −0,10 R/trade (choix), Nasdaq 1 h ≈ 0'],
  f_insideday: ['rejet', 'or 1 jour +0,02 R/trade, Nasdaq perdante'],
  f_nr7: ['rejet', 'or et Nasdaq ≈ 0 ou perdante en vérification'],
  f_weekbreak: ['rejet', 'or 1 jour +0,08 R/trade (trop faible), Nasdaq perdante en vérification'],
  m_bb: ['retenue', 'Or 5 min : challenge FTMO réussi 73 % (récent 53 %), 34 trades/mois'],
  m_ibs: ['retenue', 'Or 15 min : challenge FTMO réussi 71 % (récent 48 %), 38 trades/mois'],
  m_rsi2x: ['retenue', 'Or 15 min : retenue au test, mais challenge FTMO réussi 35 % seulement'],
  m_vwap: ['dispo', 'Or 5 min : réussite FTMO 51 % (récent 61 %) mais pas retenue sur la période de choix'],
  m_down3: ['essai', 'Nasdaq 15 min : 83–96 % de challenges FTMO réussis sur 2025–2026 mais perdante en 2024–2025 → à l’essai en direct ; or ≈ 0'],
  m_wr: ['retenue', 'Or 5 min : challenge FTMO réussi 67 % en 27 jours médians (récent 48 %), 67 trades/mois'],
  m_keltner: ['retenue', 'Or 5 min : 21 % seule mais monte le portefeuille FTMO récent de 53 à 59 %'],
  m_cci: ['rejet', 'Or : espérance trop faible sur la période de choix (+0,08 R)'],
  m_stoch: ['rejet', 'Or : perdante sur la période de choix'],
  m_2ll: ['rejet', 'Or : ≈ 0 en vérification'],
  n_overnight: ['retenue', 'QQQ 2 ans : +8,9 % puis +3,9 % après frais et financement CFD (+13,8 % / +8,5 % sans) ; la nuit fait +9,6 %/an sur 25 ans de ^NDX'],
  n_preholiday: ['retenue', '^NDX : +12,8 % cumulés 1985–2009, +16,3 % 2010–2026, 57 % gagnants (petit effet, régulier)'],
  n_gapfill: ['rejet', 'QQQ : +2,6 % la 1re année, −9,5 % la 2e'],
  n_firsthour: ['rejet', 'QQQ : perdante les 2 années'],
  hold: ['ref', 'Or +10,8 %/an (pire baisse −44 %) · Nasdaq +17,0 %/an (−36 %)'],
};

/** Liste complète, avec les marchés où chaque stratégie est active selon la configuration. */
function catalog(cfg) {
  const sel = {
    gold: selectStrategies(cfg.goldEnabled ? cfg.goldStrategies : []),
    nas100: selectStrategies(cfg.nasEnabled ? cfg.nasStrategies : []),
  };
  const famOf = new Map(FAMILIES.flatMap(([f, ids]) => ids.map((id) => [id, f])));
  return STRATEGIES.map((s) => {
    const [verdict, note] = VERDICT[s.id] || ['dispo', ''];
    // Version active (ex. « macd@1d ») : on affiche son unité de temps et on teste celle-là
    const live = [...sel.gold, ...sel.nas100].find((x) => x.id.split('@')[0] === s.id);
    const tf = tfOf(live || s);
    return {
      id: s.id,
      testId: live ? live.id : s.id,
      name: s.name,
      desc: s.desc,
      tf,
      family: famOf.get(s.id) || 'Autres',
      markets: s.markets || ['gold', 'nas100'],
      active: ['gold', 'nas100'].filter((m) => sel[m].some((x) => x.id.split('@')[0] === s.id)),
      verdict,
      note,
      testable: tf === '1d' && !s.scalp && !s.intraday,
    };
  });
}

module.exports = { catalog, FAMILIES, VERDICT };
