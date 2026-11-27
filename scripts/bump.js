#!/usr/bin/env node
// npm run bump → version mineure suivante (v1.3 → v1.4) ; npm run bump major → v2.0
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const [maj, min] = pkg.version.split('.').map(Number);
pkg.version = process.argv[2] === 'major' ? `${maj + 1}.0.0` : `${maj}.${min + 1}.0`;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`v${pkg.version.replace(/\.0$/, '')}`);
