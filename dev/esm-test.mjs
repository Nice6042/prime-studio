import { spawnSync } from 'node:child_process';
const r = spawnSync('cmd', ['/c','echo x']);
console.log('ESM import sees patched fn:', spawnSync.name === 'spawnSync' ? 'name-same' : spawnSync.name);
console.log('PATCH_MARKER visible:', typeof globalThis.__PRIME_HIDE_PATCH__);
