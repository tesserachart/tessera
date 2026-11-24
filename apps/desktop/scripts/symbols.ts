import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const CLI = '@posthog/cli@0.18.12';
const HOST = 'https://eu.posthog.com';
const desktop = resolve(import.meta.dirname, '..');

export function releaseVersion(): string {
  const conf = JSON.parse(readFileSync(resolve(desktop, 'src-tauri/tauri.conf.json'), 'utf8')) as { version: string };
  return conf.version;
}

function uploading(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.POSTHOG_CLI_API_KEY?.trim() && env.POSTHOG_CLI_PROJECT_ID?.trim()) return true;
  console.info('symbols: no POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID: nothing is uploaded to PostHog');
  return false;
}

function posthog(args: string[]): void {
  execFileSync('bunx', [CLI, '--host', HOST, ...args], { stdio: 'inherit' });
}

export function uploadWindowSourcemaps(dist = resolve(desktop, 'dist')): void {
  if (!uploading()) return;
  posthog([
    'sourcemap',
    'process',
    '--directory',
    dist,
    '--release-name',
    'tessera-desktop',
    '--release-version',
    releaseVersion(),
  ]);
}

export function runtimeSymbolFiles(exe: string, platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === 'win32') return null;
  return platform === 'darwin' ? [`${exe}.dSYM`] : [exe];
}

export function uploadRuntimeSymbols(exe: string): void {
  if (!uploading()) return;
  const files = runtimeSymbolFiles(exe);
  if (!files) {
    console.info('symbols: PostHog takes no Windows PDBs, so the runtime is not uploaded');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'tessera-symbols-'));
  try {
    for (const file of files) {
      if (!existsSync(file)) throw new Error(`symbols: ${file} is missing: build with debug info to upload it`);
      cpSync(file, join(dir, basename(file)), { recursive: true });
    }
    posthog([
      'symbol-sets',
      'upload',
      '--directory',
      dir,
      '--release-name',
      'tessera-runtime',
      '--release-version',
      releaseVersion(),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) uploadWindowSourcemaps();
