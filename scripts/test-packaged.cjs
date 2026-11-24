const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'node_modules', '@playwright', 'test', 'cli.js'), 'test'], {
  stdio: 'inherit',
  env: { ...process.env, DEMOSIM_PACKAGED: '1' }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
