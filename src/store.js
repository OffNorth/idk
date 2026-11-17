/**
 * Persistance JSON simple : tokens suivis (watchlist) et historique des alertes.
 */
const fs = require('fs');
const path = require('path');

const HOUR = 3_600_000;

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.watchFile = path.join(dir, 'watchlist.json');
    this.alertFile = path.join(dir, 'alerts.json');
    this.watch = load(this.watchFile); // key → { chain, address, sources, firstSeen }
    this.alerts = load(this.alertFile); // key → { at, score, marketCap }
    this.metaFile = path.join(dir, 'meta.json');
    this.meta = load(this.metaFile); // divers (date du dernier résumé…)
  }

  getMeta(key) {
    return this.meta[key];
  }

  setMeta(key, value) {
    this.meta[key] = value;
    save(this.metaFile, this.meta);
  }

  /** Ajoute les candidats découverts et oublie ceux suivis depuis trop longtemps. */
  track(candidates, watchHours) {
    const now = Date.now();
    for (const c of candidates) {
      const key = `${c.chain}:${c.address}`;
      const cur = this.watch[key];
      if (cur) cur.sources = [...new Set([...cur.sources, ...c.sources])];
      else this.watch[key] = { chain: c.chain, address: c.address, sources: c.sources, firstSeen: now };
    }
    this.watch = Object.fromEntries(
      Object.entries(this.watch).filter(([, v]) => now - v.firstSeen <= watchHours * HOUR),
    );
    save(this.watchFile, this.watch);
    return Object.values(this.watch);
  }

  canAlert(key, cooldownHours) {
    const a = this.alerts[key];
    return !a || Date.now() - a.at > cooldownHours * HOUR;
  }

  markAlerted(key, info) {
    const cutoff = Date.now() - 7 * 24 * HOUR; // historique gardé 7 jours
    this.alerts = Object.fromEntries(Object.entries(this.alerts).filter(([, v]) => v.at >= cutoff));
    this.alerts[key] = { at: Date.now(), ...info };
    save(this.alertFile, this.alerts);
  }
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function save(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

module.exports = { Store };
