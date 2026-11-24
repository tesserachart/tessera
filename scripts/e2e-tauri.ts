import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  resolveRuntimeBinary,
  runtimeExecutableFromCargoMessages,
  rustcWrapper,
  TEST_RUNTIME,
} from '../apps/desktop/dev/runtime-bin.ts';

const repo = resolve(import.meta.dirname, '..');
const desktop = join(repo, 'apps/desktop');
const TOOLS = [
  'Xvfb',
  'openbox',
  'dbus-run-session',
  'WebKitWebDriver',
  'tauri-driver',
  'xprop',
  'xwininfo',
  'xdotool',
  'wmctrl',
  'ffmpeg',
];

function fail(message: string): never {
  console.error(`e2e:tauri: ${message}`);
  process.exit(2);
}

function run(what: string, command: string, args: string[], options: SpawnSyncOptions = {}): string {
  const res = spawnSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });
  if (res.status !== 0) fail(`${what} failed (${res.signal ?? `exit ${String(res.status)}`})`);
  return String(res.stdout);
}

if (process.platform !== 'linux') {
  fail('the Tauri window tests drive WebKitGTK through tauri-driver, which runs on Linux only (docs/dev.md §9)');
}
const missing = TOOLS.filter((tool) => spawnSync('which', [tool], { stdio: 'ignore' }).status !== 0);
if (missing.length > 0) fail(`missing ${missing.join(', ')}: install them as docs/dev.md §9 says`);

console.info('▶ the UI (vite build)');
run('vite build', process.execPath, ['x', 'vite', 'build', '--logLevel', 'warn'], { cwd: desktop, stdio: 'inherit' });
run('the symbol list', process.execPath, ['scripts/symbols.ts'], { cwd: desktop, stdio: 'inherit' });

console.info('▶ the Tauri shell, with the UI built in');
const cargo = run(
  'cargo build of the shell',
  'cargo',
  [
    'build',
    '--manifest-path',
    join(desktop, 'src-tauri/Cargo.toml'),
    '--features',
    'tauri/custom-protocol',
    '--message-format=json-render-diagnostics',
  ],
  { cwd: repo, env: { ...process.env, RUSTC_WRAPPER: rustcWrapper(process.env) }, maxBuffer: 256 * 1024 * 1024 },
);
const shell = runtimeExecutableFromCargoMessages(cargo, 'tessera-desktop') ?? fail('cargo built no tessera-desktop');

const runtime = resolveRuntimeBinary(repo, { target: TEST_RUNTIME, quiet: true });
console.info(`▶ the test runtime: ${runtime.path} (${runtime.source})`);

const args = process.argv.slice(2).filter((a) => a !== '--');
const tests = spawnSync(process.execPath, ['x', 'vitest', 'run', '--config', 'e2e/tauri/vitest.config.ts', ...args], {
  cwd: repo,
  stdio: 'inherit',
  env: { ...process.env, TESSERA_TAURI_SHELL: shell, TESSERA_TEST_RUNTIME_BIN: runtime.path },
});
console.info('\nScreenshots and app logs: .e2e/tauri/');
process.exit(tests.status ?? 1);
