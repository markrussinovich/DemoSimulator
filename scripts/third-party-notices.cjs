const fs = require('node:fs');
const path = require('node:path');
const seen = new Set();
const notices = [];
function include(name, from) {
  let directory = path.dirname(require.resolve(name, { paths: [from] }));
  let pkg;
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest)) {
      const candidate = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (candidate.name === name) { pkg = candidate; break; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Missing package manifest: ${name}`);
    directory = parent;
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  const licenses = fs.readdirSync(directory).filter(file => /^(license|copying|notice)(\.|$)/i.test(file));
  if (!licenses.length) throw new Error(`Missing bundled dependency license: ${key}`);
  notices.push(`${key}\n${licenses.map(file => fs.readFileSync(path.join(directory, file), 'utf8')).join('\n')}`);
  for (const dependency of Object.keys(pkg.dependencies ?? {})) include(dependency, directory);
}
for (const name of ['react', 'react-dom', 'yauzl', 'yazl', 'zod']) include(name, process.cwd());
fs.writeFileSync(path.join('dist', 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n--------------------\n\n'));
