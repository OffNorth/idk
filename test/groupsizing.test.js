const test = require('node:test');
const assert = require('node:assert');
const { ruleFor } = require('../src/sizing');

test('taille selon la corrélation : FTMO réduit si le même groupe est ouvert ou à 3 positions ; Lucid inchangé', () => {
  const cfg = { ftmoSizing: 'plusieurs positions → moins', ftmoGroupSizing: true };
  const f = ruleFor(cfg, 'FTMO');
  const st = (markets) => ({ balance: 1e5, capital: 1e5, dayStart: 1e5, target: 10, open: markets.length, openTrades: markets.map((market) => ({ market })) });
  assert.strictEqual(f({ market: 'spx' }, st(['nas100'])), 0.5, 'S&P avec un Nasdaq ouvert');
  assert.strictEqual(f({ market: 'gold' }, st(['nas100'])), 1, 'or avec un Nasdaq ouvert : groupes différents');
  assert.strictEqual(f({ market: 'gold' }, st(['nas100', 'eurusd'])), 1, '2 positions d’autres groupes : taille normale');
  assert.strictEqual(f({ market: 'silver' }, st(['gold', 'nas100', 'eurusd'])), 0.25, 'même groupe et 3 positions');
  assert.strictEqual(ruleFor(cfg, 'Lucid')({ market: 'gold' }, st(['nas100', 'eurusd'])), 0.5, 'Lucid : ancienne règle (2 positions)');
  assert.strictEqual(ruleFor({ ...cfg, ftmoGroupSizing: false }, 'FTMO')({ market: 'spx' }, st(['nas100'])), 1, 'FTMO_GROUP_SIZING=0');
});

test('compte financé : risque selon la marge restante avant la perte max (FUNDED_CUSHION)', () => {
  const { cushionMul } = require('../src/sizing');
  assert.strictEqual(cushionMul(1), 1);
  assert.strictEqual(cushionMul(0.5), 0.5);
  assert.strictEqual(cushionMul(0.1), 0.25, 'au plus bas × 0,25');
  assert.strictEqual(cushionMul(3), 1, 'jamais plus que le risque normal');
  // Compte FTMO financé à mi-chemin de la perte max : taille divisée par 2
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const T0 = Date.UTC(2026, 10, 16, 10) / 1000;
  const notionalAt = (balance, cushion) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cushion-'));
    const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, ftmoEnabled: true,
      ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '2step', ftmoSizing: 'fixe', ftmoAi: 'off', lucidEnabled: false, fundedCushion: cushion };
    const { Store } = require('../src/store'); const store = new Store(dir);
    const { createFtmo } = require('../src/ftmoAccount');
    const f = createFtmo({ cfg, store, account: 'gold' });
    f.forceFunded(T0 - 86400);
    store.saveJson('ftmo.json', { ...f.load(), balance, dayStart: balance, peak: 100000 });
    f.onCycle([{ type: 'open', market: { id: 'gold', name: 'Gold' }, strategy: { id: 'x_rsi2', name: 'Scalp' }, pos: { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 } }], { gold: 2000 }, T0);
    return Object.values(f.load().open)[0]?.notional;
  };
  const full = notionalAt(100000, true), half = notionalAt(95000, true), off = notionalAt(95000, false);
  assert.ok(full > 0 && Math.abs(half / (off) - 0.5) < 0.01, `${full} / ${half} / ${off}`);
});

test('deux évaluations Lucid (LUCID_SPLIT) : intraday seulement / journalières seulement ; le compte financé prend tout', () => {
  const cfg = { ...require('../src/config'), ftmoEnabled: true, lucidEnabled: true, lucidSplit: true, lucidParallel: true };
  const { accountOf, ftmoAccounts } = require('../src/ftmoAccount');
  const { selectStrategies } = require('../src/strategies');
  const intra = selectStrategies(['n_mom10_t05'])[0], daily = selectStrategies(['double7'])[0];
  const a = accountOf(cfg, 'lucid'), b = accountOf(cfg, 'lucid2'), f = accountOf(cfg, 'lucidf');
  assert.ok(a.riskOf('nas100', intra, 'eval') > 0 && a.riskOf('spx', daily, 'eval') === 0, 'lucid : intraday seulement');
  assert.ok(b.riskOf('spx', daily, 'eval') > 0 && b.riskOf('nas100', intra, 'eval') === 0, 'lucid2 : journalières seulement');
  assert.ok(f.riskOf('nas100', intra, 'funded') === 0 && f.riskOf('spx', daily, 'funded') > 0, 'financé : journalières seulement (LUCID_FUNDED_DAILY_ONLY)');
  const fAll = accountOf({ ...cfg, lucidFundedDailyOnly: false }, 'lucidf');
  assert.ok(fAll.riskOf('nas100', intra, 'funded') > 0 && fAll.riskOf('spx', daily, 'funded') > 0, 'LUCID_FUNDED_DAILY_ONLY=0 : tout');
  assert.strictEqual(b.dayMgmt, false, 'lucid2 : pas de gestion de la journée');
  assert.strictEqual(accountOf({ ...cfg, lucidDailyDayMgmt: true }, 'lucid2').dayMgmt, true);
  assert.notStrictEqual(a.dayMgmt, false, 'lucid intraday : gestion de la journée gardée');
  assert.deepStrictEqual([a.file, b.file, f.file], ['lucid.json', 'lucid2.json', 'lucid-funded.json']);
  assert.ok(ftmoAccounts(cfg).some((x) => x.id === 'lucid2'));
  const c = accountOf(cfg, 'lucid3');
  assert.ok(c.enabled && c.file === 'lucid3.json' && c.tag === 'combined', 'lucid3 : évaluation fusionnée');
  assert.ok(c.riskOf('nas100', intra, 'eval') > 0 && c.riskOf('spx', daily, 'eval') > 0, 'lucid3 : intraday + journalières');
  assert.notStrictEqual(c.dayMgmt, false, 'lucid3 : gestion de la journée gardée');
  assert.ok(ftmoAccounts(cfg).some((x) => x.id === 'lucid3'));
  assert.ok(!ftmoAccounts({ ...cfg, lucidCombined: false }).some((x) => x.id === 'lucid3'), 'LUCID_COMBINED=0');
  assert.ok(!ftmoAccounts({ ...cfg, lucidSplit: false }).some((x) => x.id === 'lucid3'), 'LUCID_SPLIT=0 : lucid est déjà fusionné');
  assert.ok(!ftmoAccounts({ ...cfg, lucidSplit: false }).some((x) => x.id === 'lucid2'), 'LUCID_SPLIT=0 : une seule évaluation');
  assert.ok(accountOf({ ...cfg, lucidSplit: false }, 'lucid').riskOf('spx', daily, 'eval') > 0);
});

test('Lucid financé : règles du financé (pas de régularité, scaling des contrats, perte max bloquée dès le 1er retrait, 5 retraits)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucidf-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, lucidEnabled: true, lucidSplit: true, lucidParallel: true, lucidFundedDirect: true, fundedCushion: false, ftmoAi: 'off', lucidAi: 'off' };
  const { Store } = require('../src/store'); const store = new Store(dir);
  const { createFtmo } = require('../src/ftmoAccount');
  const f = createFtmo({ cfg, store, account: 'lucidf' });
  const T0 = Date.UTC(2026, 10, 16, 15) / 1000;
  f.onCycle([], { gold: 2000 }, T0); // démarrage direct du compte financé
  const st = f.status({});
  assert.strictEqual(st.s.phase, 'funded');
  assert.strictEqual(st.program.label, 'LucidFlex funded');
  assert.strictEqual(st.program.bestDay, 0, 'pas de règle de régularité');
  assert.strictEqual(st.maxContracts, 20, '20 micros au départ (50K)');
  store.saveJson('lucid-funded.json', { ...f.load(), balance: 51500, dayStart: 51500, eodPeak: 51500 });
  assert.strictEqual(f.status({}).maxContracts, 30, '30 micros dès +1 000 $');
  assert.strictEqual(f.status({}).floor, 49500, 'perte max suiveuse avant le 1er retrait');
  store.saveJson('lucid-funded.json', { ...f.load(), funded: { since: T0, payouts: [{ t: T0, amount: 600, trader: 540 }] } });
  assert.strictEqual(f.status({}).floor, 50100, 'bloquée à capital + 100 $ dès le 1er retrait');
});

test('Lucid financé : risque × LUCID_FUNDED_RISK_MUL (2 par défaut), évaluation inchangée', () => {
  const cfg = { ...require('../src/config'), ftmoEnabled: true, lucidEnabled: true, lucidSplit: false, lucidParallel: true, lucidFundedRiskMul: 2, lucidFundedDailyOnly: false };
  const { accountOf } = require('../src/ftmoAccount');
  const { selectStrategies } = require('../src/strategies');
  const daily = selectStrategies(['double7'])[0], intra = selectStrategies(['n_mom10_t05'])[0];
  const f = accountOf(cfg, 'lucidf'), e = accountOf({ ...cfg, lucidFundedRiskMul: 1 }, 'lucidf');
  assert.ok(Math.abs(f.riskOf('spx', daily, 'funded') - 2 * e.riskOf('spx', daily, 'funded')) < 1e-9);
  assert.ok(Math.abs(f.riskOf('nas100', intra, 'funded') - 2 * e.riskOf('nas100', intra, 'funded')) < 1e-9);
  assert.strictEqual(f.riskOf('spx', daily, 'eval'), e.riskOf('spx', daily, 'eval'), 'évaluation inchangée');
});

test('Lucid financé : × LUCID_FUNDED_RISK_MUL jusqu\'au 1er retrait, puis × LUCID_FUNDED_RISK_MUL_AFTER', () => {
  const cfg = require('../src/config');
  const { lucidAfterPayoutMul } = require('../src/ftmoAccount');
  assert.strictEqual(cfg.lucidFundedRiskMul, 3);
  assert.strictEqual(cfg.lucidFundedRiskMulAfter, 1);
  assert.ok(Math.abs(lucidAfterPayoutMul(cfg) - 1 / 3) < 1e-9, 'après le 1er retrait : × 1 au lieu de × 3');
  assert.strictEqual(lucidAfterPayoutMul({ lucidFundedRiskMul: 2, lucidFundedRiskMulAfter: 2 }), 1);
  // Simulateur : le multiplicateur dépend du nombre de retraits vus par la règle de taille
  const { runPhase } = require('../src/ftmo');
  const seen = [];
  const t0 = Date.UTC(2025, 0, 6, 15) / 1000;
  const trades = [0, 1, 2].map((k) => ({ entryT: t0 + k * 86400, exitT: t0 + k * 86400 + 3600, entry: 100, initSl: 99, pnlPct: 2, riskPct: 1 }));
  runPhase(trades, { capital: 50_000, target: Infinity, dailyPct: Infinity, maxLossUsd: 2000, minDays: 0, sizer: (t, st) => { seen.push(st.paid); return 1; },
    payout: ({ balance, capital }) => (balance - capital > 500 ? 600 : 0) });
  assert.deepStrictEqual(seen, [0, 1, 2], 'nombre de retraits transmis à la règle de taille');
});

test('Lucid : pas de position inverse d\'un compte Lucid à l\'autre (LUCID_NO_CROSS_HEDGE)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Store } = require('../src/store');
  const { createFtmo } = require('../src/ftmoAccount');
  const { selectStrategies } = require('../src/strategies');
  const T0 = Date.UTC(2026, 10, 17, 15) / 1000;
  const strategy = selectStrategies(['n_mom10_t05'])[0];
  const market = { id: 'nas100', name: 'Nasdaq 100' };
  const run = (cross) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhedge-'));
    const store = new Store(dir);
    const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, lucidEnabled: true, lucidSplit: true, lucidParallel: true, lucidFundedDirect: false,
      ftmoAi: 'off', lucidAi: 'off', autoAdapt: false, lucidNoCrossHedge: cross };
    // L'évaluation journalière tient un achat Nasdaq
    const d = createFtmo({ cfg, store, account: 'lucid2' });
    const s2 = d.load();
    s2.open = { 'nas100:rsi2:1': { market: 'nas100', sid: 'rsi2', side: 'long', entry: 26000, sl: 25500, initSl: 25500, entryT: T0 - 86400, n: 2, notional: 104000 } };
    store.saveJson('lucid2.json', s2);
    // L'évaluation intraday reçoit une vente Nasdaq
    const l = createFtmo({ cfg, store, account: 'lucid' });
    const out = l.onCycle([{ type: 'open', market, strategy, pos: { side: 'short', entry: 26000, sl: 26100, initSl: 26100, entryT: T0 } }], { nas100: 26000 }, T0);
    return { opened: out.some((x) => x.type === 'open'), s: l.load() };
  };
  const on = run(true);
  assert.strictEqual(on.opened, false, 'vente refusée : achat ouvert sur un autre compte Lucid');
  assert.strictEqual(on.s.skippedCross, 1);
  assert.strictEqual(run(false).opened, true, 'LUCID_NO_CROSS_HEDGE=0 : la vente passe');
});

test('Lucid : LUCID_FUNDED_STRATEGIES (russell:rsi2) sur le compte financé seulement', () => {
  const cfg = { ...require('../src/config'), ftmoEnabled: true, lucidEnabled: true };
  const { accountOf } = require('../src/ftmoAccount');
  assert.ok(accountOf(cfg, 'lucidf').strategies.includes('russell:rsi2'));
  for (const id of ['lucid', 'lucid2', 'lucid3']) assert.ok(!accountOf(cfg, id).strategies.includes('russell:rsi2'), `${id} : pas de russell:rsi2`);
  assert.ok(cfg.russellStrategies.includes('rsi2'), 'suivie en paper');
});
