/** Tauri expects each `bundle.externalBin` at `src-tauri/binaries/<name>-<host triple>`. */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildRuntime } from '../dev/runtime-bin.ts';
import { withRithmicDirectory } from '../dev/runtime-env.ts';
import { uploadRuntimeSymbols } from './symbols.ts';

const repo = resolve(import.meta.dirname, '../../..');
const ext = process.platform === 'win32' ? '.exe' : '';

const host = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
if (!host) throw new Error('could not determine the rustc host triple');

const tauriDir = resolve(import.meta.dirname, '../src-tauri');
const names = new Set<string>();
for (const file of readdirSync(tauriDir).filter((f) => /^tauri\..*conf\.json$/.test(f))) {
  const conf = JSON.parse(readFileSync(resolve(tauriDir, file), 'utf8')) as { bundle?: { externalBin?: string[] } };
  for (const bin of conf.bundle?.externalBin ?? []) names.add(basename(bin));
}

const env = withRithmicDirectory(process.env);
if (!env.TESSERA_RITHMIC_DIRECTORY?.trim())
  console.warn(
    'prepare-sidecar: no TESSERA_RITHMIC_DIRECTORY: this build asks for a gateway address until a first login works',
  );
if (!env.TESSERA_CLOUD_URL?.trim()) console.info('prepare-sidecar: no TESSERA_CLOUD_URL: this build has no accounts');
if (!env.TESSERA_POSTHOG_KEY?.trim())
  console.info('prepare-sidecar: no TESSERA_POSTHOG_KEY: this build asks nothing and sends no usage or crash reports');
const from = buildRuntime(repo, { release: true, env });
uploadRuntimeSymbols(from);
const outDir = resolve(tauriDir, 'binaries');
mkdirSync(outDir, { recursive: true });
for (const name of names) {
  const to = resolve(outDir, `${name}-${host}${ext}`);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
  console.info(`prepare-sidecar: ${from} → ${to}`);
}
