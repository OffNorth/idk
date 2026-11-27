/**
 * Version du bot : numéro lisible tiré de package.json (« 1.3.0 » → « v1.3 »), monté à chaque mise à jour
 * (npm run bump : v1.3 → v1.4 ; npm run bump major : v1.4 → v2.0). Le commit git (7 caractères) reste disponible
 * pour le détail (/version).
 */
const fs = require('fs');
const path = require('path');

function version() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '';
    const [maj, min, patch] = v.split('.').map(Number);
    return Number.isFinite(maj) ? `v${maj}.${min || 0}${patch ? `.${patch}` : ''}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Commit git déployé (7 caractères) si le dossier .git est là, sinon « unknown ». */
function commit() {
  try {
    const git = path.join(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const file = path.join(git, ref);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().slice(0, 7);
    // Références « empaquetées » (après un git gc / clone)
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = { version, commit };
