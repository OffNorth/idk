#!/usr/bin/env node
/**
 * Scan unique en console, sans Telegram.
 *   npm run scan            → top 20
 *   npm run scan -- 50      → top 50
 */
const cfg = require('./src/config');
const { Store } = require('./src/store');
const { scan } = require('./src/scanner');
const { consoleRow } = require('./src/format');
const { fmtUsd } = require('./src/scoring');

(async () => {
  const limit = Number(process.argv[2]) || 20;
  console.log(`Scan ${cfg.chains.join(', ')} — MC ${fmtUsd(cfg.minMarketCap)} à ${fmtUsd(cfg.maxMarketCap)}…`);
  const t0 = Date.now();
  const res = await scan(cfg, new Store(cfg.dataDir));

  console.log(
    `${res.discovered} découverts · ${res.watched} suivis · ${res.priced} avec données · ` +
      `${res.inRange} dans la fourchette · ${res.ranked.length} retenus (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );
  const rej = Object.entries(res.rejected).sort((a, b) => b[1] - a[1]);
  if (rej.length) console.log(`Rejets : ${rej.map(([k, v]) => `${k} ×${v}`).join(' · ')}`);
  console.log();

  if (!res.ranked.length) {
    console.log('Aucun token ne passe les filtres pour le moment.');
    return;
  }
  console.log(' #  SCR  SYMBOLE            MC       LIQ   VOL24H     1H %      ÂGE  RUG      LIEN');
  res.ranked.slice(0, limit).forEach((x, i) => console.log(consoleRow(x, i)));
  console.log('\n⚠️  Score = activité / momentum, pas un conseil financier.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
