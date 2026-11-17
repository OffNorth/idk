/**
 * Persistance JSON simple dans le dossier data/ (positions de l'or, date du dernier bilan…).
 */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.metaFile = path.join(dir, 'meta.json');
    this.meta = load(this.metaFile);
  }

  /** Lecture / écriture d'un fichier JSON du dossier data (ex : gold.json). */
  loadJson(name, fallback) {
    const data = load(path.join(this.dir, name));
    return Object.keys(data).length ? data : fallback;
  }

  saveJson(name, data) {
    save(path.join(this.dir, name), data);
  }

  getMeta(key) {
    return this.meta[key];
  }

  setMeta(key, value) {
    this.meta[key] = value;
    save(this.metaFile, this.meta);
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
