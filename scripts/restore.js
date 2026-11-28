#!/usr/bin/env node
// Restauration de la sauvegarde des données du bot (src/backup.js), bot ARRÊTÉ de préférence.
//   npm run restore              → fichiers absents seulement (dernière sauvegarde)
//   npm run restore -- --force   → remplace tous les fichiers
//   npm run restore -- --previous → l'avant-dernière sauvegarde
const cfg = require('../src/config');
const args = process.argv.slice(2);
require('../src/backup').restoreBackup(cfg, { force: args.includes('--force'), which: args.includes('--previous') ? 'previous' : 'daily' })
  .then((r) => { console.log(r.ok ? `✅ ${r.restored} fichier(s) restauré(s) (sauvegarde du ${new Date(r.at).toISOString().slice(0, 16)}, ${r.version})` : `❌ ${r.error}`); process.exit(r.ok ? 0 : 1); });
