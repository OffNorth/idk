const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function setup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftmo-'));
  const cfg = { ...require('../src/config'), dataDir: dir, ftmoEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoFeeNas: 0, ftmoProgram: '2step', ...extra };
  const { Store } = require('../src/store');
  return { cfg, store: new Store(dir) };
}
const market = { id: 'gold', name: 'Or' };
const strategy = { id: 'x_rsi2', name: 'Scalp RSI 2' };
const DAY = 86400;
const T0 = Date.UTC(2026, 10, 16, 10) / 1000; // lundi 10 h UTC

test('simulateur : réussite d’un challenge et échec sur la perte maximale', () => {
  const { runPhase, rMultiple } = require('../src/ftmo');
  // Stop à 1 % du prix, gain de 2 % → +2 R ; risque 1 % → +2 % du compte par trade
  const win = (k) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct: 2 });
  assert.strictEqual(rMultiple(win(0)), 2);
  const p = runPhase([0, 1, 2, 3, 4].map(win), { riskPct: 1, target: 10 });
  assert.strictEqual(p.outcome, 'target');
  assert.ok(p.days >= 4);
  const lose = (k) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct: -1 });
  assert.strictEqual(runPhase(Array.from({ length: 12 }, (_, k) => lose(k)), { riskPct: 1 }).outcome, 'maxloss');
});

test('compte FTMO en direct : taille au risque, étape 1 réussie, puis échec sur la perte du jour', () => {
  const { cfg, store } = setup();
  const { createFtmo } = require('../src/ftmoAccount');
  const f = createFtmo({ cfg, store });
  const trade = (k, exit, t = T0 + k * DAY) => {
    const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t }; // stop à 1 %
    f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, t);
    return f.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit, exitT: t + 1800, entryT: t, reason: 'signal' } }], { gold: exit }, t + 1800);
  };
  // Taille : 1 % de 100 000 $ / 1 % de distance → 100 000 $ engagés ; +3 % → +3 000 $
  trade(0, 4120);
  assert.strictEqual(Math.round(f.load().balance), 103000);
  trade(1, 4120);
  trade(2, 4120);
  const msgs = trade(3, 4040); // +1 % → total ≥ +10 % en 4 jours
  assert.ok(msgs.some((m) => m.type === 'pass' && m.phase === 1), 'étape 1 réussie');
  assert.strictEqual(f.load().phase, 2);
  // Étape 2 : une perte de 6 % dans la journée → échec (perte du jour 5 %), nouveau challenge
  const t = T0 + 10 * DAY;
  const pos = { side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: t };
  f.onCycle([{ type: 'open', market, strategy, pos }], { gold: 4000 }, t);
  const out = f.onCycle([], { gold: 3760 }, t + 600); // −6 % en latent
  assert.ok(out.some((m) => m.type === 'fail' && /jour/.test(m.why)));
  assert.strictEqual(f.load().attempt, 2);
  assert.strictEqual(f.load().phase, 1);
});

test('image et vue du panneau FTMO', async () => {
  const { cfg, store } = setup();
  const { render } = require('../src/interactive');
  const out = await render(cfg, store, 'f', 'gold');
  assert.strictEqual(out.png.subarray(1, 4).toString(), 'PNG');
  assert.match(out.caption, /Compte FTMO simulé/);
});

test('2e compte FTMO (Nasdaq) : indépendant du compte or', async () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoNasEnabled: true, ftmoNasStrategies: ['nas100:x_orb5'], ftmoNasRisk: 0.5 });
  const { createFtmo, ftmoAccounts } = require('../src/ftmoAccount');
  assert.deepStrictEqual(ftmoAccounts(cfg).map((a) => a.id), ['nas100', 'gold']);
  const nas = createFtmo({ cfg, store, account: 'nas100' });
  const gold = createFtmo({ cfg, store, account: 'gold' });
  const nasMarket = { id: 'nas100', name: 'Nasdaq 100' };
  const pos = { side: 'long', entry: 20000, sl: 19900, initSl: 19900, entryT: T0 }; // stop 0,5 %
  const evs = [{ type: 'open', market: nasMarket, strategy: { id: 'x_orb5', name: 'ORB' }, pos }];
  nas.onCycle(evs, { nas100: 20000 }, T0);
  gold.onCycle(evs, { nas100: 20000 }, T0);
  nas.onCycle([{ type: 'close', market: nasMarket, strategy: { id: 'x_orb5' }, trade: { ...pos, exit: 20200, exitT: T0 + 600, reason: 'objectif' } }], { nas100: 20200 }, T0 + 600);
  // risque 0,5 % de 100 000 $ sur un stop de 0,5 % → 100 000 $ engagés ; +1 % → +1 000 $
  assert.strictEqual(Math.round(nas.load().balance), 101000);
  assert.strictEqual(gold.load().balance, 100000, 'le compte or ne suit pas le Nasdaq');
  assert.ok(fs.existsSync(path.join(cfg.dataDir, 'ftmo-nas.json')));
  const { render } = require('../src/interactive');
  const out = await render(cfg, store, 'f', 'nas100');
  assert.match(out.caption, /FTMO simulé 🇺🇸 Nasdaq/);
});

test('compte FTMO unique or + Nasdaq : un risque par marché', () => {
  const { cfg, store } = setup({ ftmoCombined: true, ftmoNasEnabled: true, ftmoStrategies: ['gold:x_rsi2'], ftmoNasStrategies: ['nas100:x_orb5'], ftmoRisk: 0.5, ftmoComboNasRisk: 1 });
  const { createFtmo, ftmoAccounts } = require('../src/ftmoAccount');
  assert.deepStrictEqual(ftmoAccounts(cfg).map((a) => a.id), ['gold']);
  const acct = createFtmo({ cfg, store, account: 'gold' });
  const nasMarket = { id: 'nas100', name: 'Nasdaq 100' };
  const pos = { side: 'long', entry: 20000, sl: 19800, initSl: 19800, entryT: T0 }; // stop 1 %
  acct.onCycle([{ type: 'open', market: nasMarket, strategy: { id: 'x_orb5', name: 'ORB' }, pos }], { nas100: 20000 }, T0);
  acct.onCycle([{ type: 'close', market: nasMarket, strategy: { id: 'x_orb5' }, trade: { ...pos, exit: 20200, exitT: T0 + 600, reason: 'objectif' } }], { nas100: 20200 }, T0 + 600);
  // risque Nasdaq 1 % de 100 000 $ sur un stop de 1 % → 100 000 $ engagés ; +1 % → +1 000 $ (moins les frais)
  assert.ok(Math.abs(acct.load().balance - 101000) < 20, String(acct.load().balance));
});

test('levier dynamique : risque divisé par 2 dès 2 positions ouvertes', () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoSizing: 'plusieurs positions → moins' });
  const { createFtmo } = require('../src/ftmoAccount');
  const acct = createFtmo({ cfg, store, account: 'gold' });
  const mk = (k) => ({ type: 'open', market, strategy: { id: 'x_rsi2', name: 'Scalp' }, pos: { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 + k } });
  acct.onCycle([mk(0), mk(1), mk(2)], { gold: 2000 }, T0 + 2);
  const n = Object.values(acct.load().open).map((p) => Math.round(p.notional));
  // risque 1 % sur un stop de 1 % → 100 000 $ ; la 3e position (2 déjà ouvertes) → 50 000 $
  assert.deepStrictEqual(n, [100000, 100000, 50000]);
});

test('challenge 1 étape : perte du jour 3 %, perte max suiveuse, réussite directe vers le compte financé', () => {
  const { createFtmo } = require('../src/ftmoAccount');
  const mk = (k, entry, sl) => ({ type: 'open', market, strategy, pos: { side: 'long', entry, sl, initSl: sl, entryT: T0 + k * DAY } });
  const cl = (k, entry, exit) => ({ type: 'close', market, strategy, trade: { side: 'long', entry, exit, exitT: T0 + k * DAY + 60, entryT: T0 + k * DAY, reason: 'test' } });
  // Réussite : +11 % répartis sur 4 jours (aucun jour > 50 % du gain) → compte financé en une étape
  {
    const { cfg, store } = setup({ ftmoProgram: '1step', ftmoRisk: 1, ftmoCombined: false });
    const a = createFtmo({ cfg, store, account: 'gold' });
    let res = [];
    for (let k = 0; k < 4; k++) {
      a.onCycle([mk(k, 2000, 1980)], { gold: 2000 }, T0 + k * DAY);
      // stop 1 %, risque 1 % → 100 000 $ engagés ; +2,75 % → +2 750 $
      res = a.onCycle([cl(k, 2000, 2055)], { gold: 2055 }, T0 + k * DAY + 60);
    }
    assert.ok(res.some((m) => m.type === 'pass'), 'réussite');
    assert.strictEqual(a.load().phase, 'funded');
  }
  // Perte max suiveuse : +5 % puis −10,5 % depuis le plus haut → échec (alors que le solde reste au-dessus de 90 000 $)
  {
    const { cfg, store } = setup({ ftmoProgram: '1step', ftmoRisk: 1, ftmoCombined: false });
    const a = createFtmo({ cfg, store, account: 'gold' });
    a.onCycle([mk(0, 2000, 1980)], { gold: 2000 }, T0);
    a.onCycle([cl(0, 2000, 2100)], { gold: 2100 }, T0 + 60); // +5 000 $
    let failed = false;
    for (let k = 1; k <= 4 && !failed; k++) {
      a.onCycle([mk(k, 2000, 1980)], { gold: 2000 }, T0 + k * DAY);
      const r = a.onCycle([cl(k, 2000, 1945)], { gold: 1945 }, T0 + k * DAY + 60); // −2 750 $ par jour (< 3 %)
      failed = r.some((m) => m.type === 'fail' && /perte maximale/.test(m.why));
    }
    assert.ok(failed, 'échec sur la perte max suiveuse');
  }
});

test('compte FTMO : chaque trade est annoncé (ouverture puis clôture)', () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoRisk: 1 });
  const { createFtmo } = require('../src/ftmoAccount');
  const { ftmoTradeMessage } = require('../src/cycle');
  const a = createFtmo({ cfg, store, account: 'gold' });
  const pos = { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 };
  const o = a.onCycle([{ type: 'open', market, strategy, pos }], { gold: 2000 }, T0);
  assert.deepStrictEqual(o.map((m) => m.type), ['open']);
  assert.strictEqual(Math.round(o[0].p.risk), 1000); // risque 1 % de 100 000 $
  const t1 = ftmoTradeMessage(o[0], a.status({ gold: 2000 }), { id: 'gold', name: 'Or', emoji: '🥇' });
  assert.match(t1, /ACHAT/);
  assert.match(t1, /\$1,000 \(1\.00 % du compte\)/);
  const c = a.onCycle([{ type: 'close', market, strategy, trade: { ...pos, exit: 2020, exitT: T0 + 600, reason: 'objectif' } }], { gold: 2020 }, T0 + 600);
  assert.deepStrictEqual(c.map((m) => m.type), ['trade']);
  const t2 = ftmoTradeMessage(c[0], a.status({ gold: 2020 }), { id: 'gold', name: 'Or', emoji: '🥇' });
  assert.match(t2, /🟢 clôture/);
  assert.match(t2, /\+\$1,000/);
});

test('compte FTMO : jamais acheteur et vendeur du même marché en même temps ; latent / réalisé', () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoRisk: 1, ftmoNoHedge: true, ftmoStrategies: ['gold:x_rsi2', 'gold:g_mom8'] });
  const { createFtmo } = require('../src/ftmoAccount');
  const a = createFtmo({ cfg, store, account: 'gold' });
  const s2 = { id: 'g_mom8', name: 'Momentum' };
  const long = { type: 'open', market, strategy, pos: { side: 'long', entry: 2000, sl: 1980, initSl: 1980, entryT: T0 } };
  const short = { type: 'open', market, strategy: s2, pos: { side: 'short', entry: 2000, sl: 2020, initSl: 2020, entryT: T0 + 60 } };
  const out = a.onCycle([long, short], { gold: 2000 }, T0 + 60);
  assert.deepStrictEqual(out.map((m) => m.type), ['open'], 'la vente opposée est ignorée');
  assert.strictEqual(Object.keys(a.load().open).length, 1);
  assert.strictEqual(a.load().skipped, 1);
  // +1 % sur 100 000 $ engagés → +1 000 $ latents, rien de réalisé
  const st = a.status({ gold: 2020 });
  assert.strictEqual(Math.round(st.unrealized), 1000);
  assert.strictEqual(Math.round(st.realized), 0);
  assert.strictEqual(Math.round(st.openPnl(Object.values(st.s.open)[0])), 1000);
});

test('garde-fous FTMO : stop franchi, position orpheline réconciliée, /verif', () => {
  const { cfg, store } = setup({ ftmoCombined: false, ftmoRisk: 0.5, ftmoStrategies: ['gold:x_rsi2', 'gold:g_mom8'] });
  const { createFtmo } = require('../src/ftmoAccount');
  const { verify } = require('../src/verify');
  const a = createFtmo({ cfg, store, account: 'gold' });
  const mom = { id: 'g_mom8', name: 'Momentum' };
  // Cas de la capture du 19 nov. : achat g_mom8 à 3 717, stop 3 693 ; l'or tombe à 3 681
  const pos = { side: 'long', entry: 3717, sl: 3693, initSl: 3693, entryT: T0, size: 1000 };
  a.onCycle([{ type: 'open', market, strategy: mom, pos }], { gold: 3717 }, T0);
  store.saveJson('gold.json', { lastPrice: 3681, accounts: { g_mom8: { capital: 1000, closed: [], position: pos } } });
  const v = verify({ ...cfg, nasEnabled: false, spxEnabled: false, eurusdEnabled: false }, store);
  assert.ok(v.issues.some((x) => /franchi le stop/.test(x)), v.issues.join(' | '));
  const out = a.onCycle([], { gold: 3681 }, T0 + 3600);
  assert.ok(out.some((m) => m.type === 'trade' && /stop loss/.test(m.p.reason)));
  assert.strictEqual(Object.keys(a.load().open).length, 0);
  const n0 = a.load().closed.length;
  // Orpheline : la position paper a été clôturée (à 3 730) sans que le compte FTMO l'ait vu
  const pos2 = { side: 'long', entry: 3700, sl: 3680, initSl: 3680, entryT: T0 + 7200, size: 1000 };
  store.saveJson('gold.json', { lastPrice: 3700, accounts: { g_mom8: { capital: 1000, closed: [], position: pos2 } } }); // le paper enregistre avant le compte FTMO
  a.onCycle([{ type: 'open', market, strategy: mom, pos: pos2 }], { gold: 3700 }, T0 + 7200);
  store.saveJson('gold.json', { lastPrice: 3725, accounts: { g_mom8: { capital: 1000, position: null, closed: [{ ...pos2, exit: 3730, exitT: T0 + 9000, reason: 'signal de sortie', pnlPct: 0.8, pnlUsd: 8 }] } } });
  const out2 = a.onCycle([], { gold: 3725 }, T0 + 9600);
  const tr = out2.find((m) => m.type === 'trade');
  assert.ok(tr && tr.p.exit === 3730 && /réconciliation/.test(tr.p.reason), JSON.stringify(out2.map((m) => m.p?.reason)));
  assert.strictEqual(a.load().closed.length, n0 + 1);
});

test('simulateur Lucid : perte max suiveuse en fin de journée, bloquée, pas de perte du jour, contrats entiers', () => {
  const { runPhase } = require('../src/ftmo');
  // Trade d'une journée : stop à 1 % ; pnlPct = résultat en % du montant, worstPct = pire moment
  const tr = (k, pnlPct, worstPct = Math.min(0, pnlPct), extra = {}) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct, worstPct, ...extra });
  const base = { capital: 50_000, riskPct: 1, target: 100, minDays: 1, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, leverage: 1000 };
  // Pas de perte du jour : −3 % en un jour (3 trades de −1 R le même jour) ne fait pas échouer, la perte max (2 000 $) oui
  const sameDay = (j) => ({ entryT: T0 + j * 7200, exitT: T0 + j * 7200 + 3600, entry: 100, initSl: 99, pnlPct: -1, worstPct: -1 });
  assert.strictEqual(runPhase([sameDay(0)], base).outcome, 'open');
  assert.strictEqual(runPhase([0, 1, 2, 3, 4].map(sameDay), base).outcome, 'maxloss');
  // Le seuil suit le plus haut solde de CLÔTURE : +3 R (+1 500 $) le jour 0 puis −1 R × 2 le jour 1 → 51 500 − 1 000 > 49 500 ✔,
  // un 3e et un 4e trade perdant passent sous 49 500 + … ; avec le blocage à +100 $ le seuil ne dépasse pas 50 100
  const up = tr(0, 3, 0);
  const res = runPhase([up, tr(1, -1), tr(2, -1), tr(3, -1)], base);
  assert.strictEqual(res.outcome, 'open'); // 51 500 → 50 000 environ, seuil = min(51 500 − 2 000, 50 100) = 49 500
  // Gain réalisé dans la journée, chute dans la même journée : le seuil n'a pas encore monté
  const intra = [{ entryT: T0, exitT: T0 + 600, entry: 100, initSl: 99, pnlPct: 4, worstPct: 0 }, { entryT: T0 + 1200, exitT: T0 + 1800, entry: 100, initSl: 99, pnlPct: -4, worstPct: -4 }];
  assert.strictEqual(runPhase(intra, { ...base, lockAt: null }).outcome, 'open'); // 52 000 → 50 000 : au-dessus de 48 000
  assert.strictEqual(runPhase([intra[0], { ...intra[1], entryT: T0 + DAY, exitT: T0 + DAY + 600 }], { ...base, lockAt: null }).outcome, 'maxloss'); // le lendemain, seuil = 50 000
  // Contrats entiers : 500 $ de risque à 1 % de stop = 50 000 $ ; contrat de 30 000 $ → 1 contrat ; contrat de 60 000 $ → ignoré
  const one = runPhase([tr(0, 2, 0, { contractUsd: 30_000, contractFee: 0 })], { ...base, contracts: true });
  assert.ok(Math.abs(one.balance - 50_600) < 1e-6);
  const none = runPhase([tr(0, 2, 0, { contractUsd: 60_000, contractFee: 0 })], { ...base, contracts: true });
  assert.strictEqual(none.balance, 50_000);
  // Plafond de contrats et frais par contrat
  const capd = runPhase([tr(0, 2, 0, { contractUsd: 1000, contractFee: 2 })], { ...base, contracts: true, maxContracts: 10 });
  assert.ok(Math.abs(capd.balance - (50_000 + 10 * 1000 * 0.02 - 20)) < 1e-6);
});

test('simulateur : phase financée avec versements (FTMO tous les 14 jours, Lucid par cycle de jours gagnants)', () => {
  const { fundedRun } = require('../src/ftmo');
  const wins = Array.from({ length: 30 }, (_, k) => ({ entryT: T0 + k * DAY, exitT: T0 + k * DAY + 3600, entry: 100, initSl: 99, pnlPct: 0.5, worstPct: 0 }));
  const ftmo = fundedRun(wins, { capital: 100_000, riskPct: 1, minDays: 1, dailyPct: 3, maxPct: 10, trailingMax: true, funded: { rule: 'ftmo', every: 14, days: 40 } }, T0 - 1);
  assert.ok(ftmo.paid > 0 && !ftmo.lost);
  const lu = fundedRun(wins, { capital: 50_000, riskPct: 1, minDays: 1, dailyPct: Infinity, maxLossUsd: 2000, eodTrailing: true, lockAt: 100, funded: { rule: 'lucid', cycleDays: 5, minDay: 150, share: 0.5, cap: 2000, days: 40 } }, T0 - 1);
  // 250 $ par jour gagnant → versement tous les 5 jours ≈ la moitié du gain accumulé
  assert.ok(lu.paid > 0 && !lu.lost);
});
