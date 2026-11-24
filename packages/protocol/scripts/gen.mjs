#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const check = process.argv.includes('--check');
const args = ['run', '--quiet', '-p', 'tessera-runtime', '--bin', 'tessera-gen', '--', ...(check ? ['--check'] : [])];
const sccache = spawnSync('sccache', ['--version'], { stdio: 'ignore' }).status === 0;
const env = { ...process.env, RUSTC_WRAPPER: process.env.RUSTC_WRAPPER ?? (sccache ? 'sccache' : '') };
const res = spawnSync('cargo', args, { cwd: repo, env, stdio: 'inherit' });
if (res.error) {
  console.error(`bun run gen: could not run cargo (${res.error.message}). Install Rust: see docs/dev.md.`);
  process.exit(1);
}
if (res.status !== 0) process.exit(res.status ?? 1);
if (check) process.exit(0);
const schemas = spawnSync(process.execPath, [resolve(repo, 'packages/protocol/scripts/schemas.ts')], {
  stdio: 'inherit',
});
process.exit(schemas.status ?? 1);
