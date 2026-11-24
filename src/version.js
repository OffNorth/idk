/** Version déployée : commit git (7 caractères) si le dossier .git est là, sinon « inconnue ». */
const fs = require('fs');
const path = require('path');

function version() {
  try {
    const git = path.join(__dirname, '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const file = path.join(git, ref);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().slice(0, 7);
    // Références « empaquetées » (après un git gc / clone)
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : 'inconnue';
  } catch {
    return 'inconnue';
  }
}

module.exports = { version };
