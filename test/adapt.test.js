const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ad = require('../src/adapt');
const { predict, originModel } = require('../src/aiFilter');

// Signaux synthétiques : la 2e caractéristique (intraday) décide du résultat — plus elle vaut 1, plus le trade gagne
function synth(n, origin, { flip = false, seed = 1 } = {}) {
  let r = seed;
  const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  return Array.from({ length: n }, (_, i) => {
    const x = origin.mu.map((m, j) => (j === 0 ? 1 : m + (rnd() - 0.5) * 2 * origin.sd[j]));
    x[1] = rnd() < 0.5 ? 1 : 0;
    const good = flip ? x[1] === 0 : x[1] === 1;
    const win = rnd() < (good ? 0.75 : 0.2);
    return { x, win, r: win ? 1.5 : -1, entryT: 1_700_000_000 + i * 3600, ok: true };
  });
}

test('IA : apprentissage prudent, adoption seulement si meilleur sur les signaux récents', () => {
  const origin = originModel();
  assert.ok(origin, 'src/aiModel.json');
  // Trop peu de signaux : rien ne change
  const few = ad.reviewAI(synth(50, origin), origin, origin, 1_800_000_000);
  assert.strictEqual(few.adopt, false);
  assert.match(few.why, /not enough/);
  // Beaucoup de signaux avec une règle nette : le modèle ré-appris fait mieux → adopté, et il a appris la règle
  const many = synth(1200, origin);
  const rv = ad.reviewAI(many, origin, origin, 1_800_000_000);
  assert.strictEqual(rv.adopt, true, rv.why);
  assert.ok(rv.after.loss < rv.before.loss);
  const a = [...origin.mu]; a[0] = 1; a[1] = 1;
  const b = [...origin.mu]; b[0] = 1; b[1] = 0;
  assert.ok(predict(rv.model, a) > predict(rv.model, b) + 0.1, 'règle apprise');
  assert.ok(Number.isFinite(rv.model.min));
  // Le même modèle face à des signaux où la règle s'inverse sur la partie récente : pas d'adoption aveugle
  const mixed = [...synth(900, origin), ...synth(300, origin, { flip: true, seed: 7 })].map((t, i) => ({ ...t, entryT: 1_700_000_000 + i * 3600 }));
  const rv2 = ad.reviewAI(mixed, rv.model, origin, 1_800_000_000);
  assert.strictEqual(rv2.adopt, false);
});

test('IA : sécurité — repasse en observation quand ses refus gagnent plus que ses trades gardés', () => {
  const mk = (ok, r) => ({ ok, r, win: r > 0 });
  assert.strictEqual(ad.aiSafety([...Array(10)].map(() => mk(false, 1))), null); // pas assez de recul
  const bad = [...Array(30)].map(() => mk(false, 0.5)).concat([...Array(30)].map(() => mk(true, -0.2)));
  assert.strictEqual(ad.aiSafety(bad).mode, 'observe');
  const good = [...Array(30)].map(() => mk(false, -0.5)).concat([...Array(30)].map(() => mk(true, 0.3)));
  assert.strictEqual(ad.aiSafety(good).mode, 'block');
});

test('stratégies : réduction, suspension, réintégration, plafonds et promotion d’une candidate', () => {
  const rs = (n, r) => Array(n).fill(r);
  const followed = ['gold:a', 'gold:b', 'gold:c', 'gold:d', 'gold:e', 'gold:f'];
  // Peu de trades : rien ne bouge, même s'ils perdent
  let rv = ad.reviewStrategies({ 'gold:a': rs(5, -1) }, followed, [], {});
  assert.strictEqual(rv.changes.length, 0);
  // 25 trades très perdants → suspendue ; 12 trades un peu perdants → réduite ; 25 très gagnants → renforcée
  rv = ad.reviewStrategies({ 'gold:a': rs(25, -0.8), 'gold:b': rs(12, -0.5), 'gold:c': rs(25, 0.6) }, followed, [], {});
  assert.strictEqual(rv.weights['gold:a'], 0);
  assert.strictEqual(rv.weights['gold:b'], 0.5);
  assert.strictEqual(rv.weights['gold:c'], 1.25);
  // Réintégration quand la note redevient positive
  const back = ad.reviewStrategies({ 'gold:a': [...rs(25, -0.8), ...rs(60, 0.6)] }, followed, [], rv);
  assert.strictEqual(back.weights['gold:a'], 1);
  assert.match(back.changes[0].why, /reinstated/);
  // Plafonds : au plus 3 changements, au plus un tiers suspendues (2 sur 6)
  const allBad = Object.fromEntries(followed.map((k) => [k, rs(30, -0.9)]));
  rv = ad.reviewStrategies(allBad, followed, [], {});
  assert.ok(rv.changes.length <= 3);
  rv = ad.reviewStrategies(allBad, followed, [], rv);
  rv = ad.reviewStrategies(allBad, followed, [], rv);
  assert.ok(Object.values(rv.weights).filter((w) => w === 0).length <= 2);
  // Candidate : promue (× 0,5) si ≥ 25 trades et meilleure que la moins bonne suivie
  rv = ad.reviewStrategies({ 'gold:a': rs(25, 0.1), 'nas100:z': rs(30, 0.5) }, followed, ['nas100:z'], {});
  assert.deepStrictEqual(rv.promoted, ['nas100:z']);
  assert.strictEqual(rv.weights['nas100:z'], 0.5);
});

test('en direct : signaux mémorisés, poids appliqué au compte, stratégie suspendue ignorée, AUTO_ADAPT=0 sans effet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapt-'));
  const { Store } = require('../src/store');
  const store = new Store(dir);
  const cfg = { ...require('../src/config'), ftmoRiskMul: 1, ftmoEvalIntradayMul: 1, ftmoFundedRiskMul: 1, ftmoDayProfitCapPct: 0, ftmoMaxLossesDay: 0, dataDir: dir, ftmoEnabled: true, ftmoCombined: false, ftmoStrategies: ['gold:x_rsi2'], ftmoCapital: 100000, ftmoRisk: 1, ftmoLeverage: 30, ftmoDayStop: 0, ftmoFeeGold: 0, ftmoProgram: '1step', ftmoSizing: 'fixe', ftmoAi: 'observe', lucidEnabled: false, autoAdapt: true, adaptStrategies: true };
  const { createFtmo } = require('../src/ftmoAccount');
  const market = { id: 'gold', name: 'Or' };
  const strategy = { id: 'x_rsi2', name: 'Scalp RSI 2', tf: '1d' };
  const T0 = Date.UTC(2026, 10, 16, 10) / 1000;
  const pos = (k) => ({ side: 'long', entry: 4000, sl: 3960, initSl: 3960, entryT: T0 + k * 86400 });
  store.saveJson('gold.json', { accounts: { x_rsi2: { closed: [], position: pos(0) } }, ctx: { daily: [], vix: null } });
  // Poids appris × 0,5 → risque divisé par 2 ; signal mémorisé pour l'IA
  store.saveJson('adapt.json', { weights: { 'gold:x_rsi2': 0.5 }, promoted: [] });
  const f = createFtmo({ cfg, store });
  const o = f.onCycle([{ type: 'open', market, strategy, pos: pos(0) }], { gold: 4000 }, T0).find((x) => x.type === 'open');
  assert.ok(Math.abs(o.p.risk - 500) < 1, String(o.p.risk));
  assert.strictEqual(store.loadJson('ai-samples.json', []).length, 1);
  // Étiquetage par le trade paper clôturé
  store.saveJson('gold.json', { accounts: { x_rsi2: { closed: [{ ...pos(0), exit: 4080, exitT: T0 + 3600, pnlPct: 2 }], position: null } } });
  const lab = ad.labelSamples(store);
  assert.strictEqual(lab.length, 1);
  assert.strictEqual(lab[0].win, true);
  assert.ok(Math.abs(lab[0].r - 2) < 1e-9);
  // Suspendue → signal ignoré
  store.saveJson('adapt.json', { weights: { 'gold:x_rsi2': 0 }, promoted: [] });
  const out = createFtmo({ cfg, store }).onCycle([{ type: 'open', market, strategy, pos: pos(2) }], { gold: 4000 }, T0 + 2 * 86400);
  assert.ok(!out.some((x) => x.type === 'open'));
  // AUTO_ADAPT=0 : poids ignoré
  const cfg0 = { ...cfg, autoAdapt: false };
  assert.strictEqual(ad.weightOf(cfg0, store, 'gold:x_rsi2'), 1);
  // Mode de l'IA forcé en observation par la sécurité
  store.saveJson('adapt.json', { weights: {}, promoted: [], aiMode: 'observe' });
  assert.strictEqual(ad.aiModeOf({ ...cfg, ftmoAi: 'block' }, store), 'observe');
  assert.strictEqual(ad.aiModeOf({ ...cfg, ftmoAi: 'block', autoAdapt: false }, store), 'block');
  // Revue hebdomadaire : due le dimanche seulement, message produit, état enregistré
  const sunday = Date.UTC(2026, 10, 22, 12);
  assert.strictEqual(ad.reviewDue(cfg, store, sunday), true);
  assert.strictEqual(ad.reviewDue(cfg, store, sunday - 86400_000), false);
  const { text } = ad.weeklyReview(cfg, store, sunday);
  assert.match(text, /Automatic weekly review/);
  assert.strictEqual(ad.reviewDue(cfg, store, sunday + 3600_000), false);
  assert.match(ad.summary(cfg, store), /Adaptation: AI v0/);
});
