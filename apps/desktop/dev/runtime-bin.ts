import { spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { rustAffected, rustReads } from '../../../scripts/rust-affected.ts';

export const TARGET_DIR_OWNER = 'tessera-checkout';

export const EXPECT_CHECKOUT_ENV = 'TESSERA_EXPECT_CHECKOUT';

export function realDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function rustcWrapper(
  env: NodeJS.ProcessEnv,
  installed = () => spawnSync('sccache', ['--version'], { stdio: 'ignore' }).status === 0,
): string {
  return env.RUSTC_WRAPPER ?? (installed() ? 'sccache' : '');
}

export function cargoTargetDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const res = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run cargo: ${res.error.message}`);
  let dir: unknown = null;
  try {
    dir = (JSON.parse(res.stdout) as { target_directory?: unknown }).target_directory;
  } catch {}
  if (res.status !== 0 || typeof dir !== 'string') {
    throw new Error(`cargo metadata failed (${res.signal ?? `exit ${String(res.status)}`}): ${res.stderr.trim()}`);
  }
  return dir;
}

export function claimTargetDir(repoRoot: string, targetDir: string): void {
  const me = realDir(repoRoot);
  const marker = join(targetDir, TARGET_DIR_OWNER);
  let owner: string | null = null;
  try {
    owner = readFileSync(marker, 'utf8').trim() || null;
  } catch {}
  if (owner === me) return;
  if (owner && existsSync(join(owner, 'Cargo.toml'))) {
    throw new Error(
      `the cargo target directory ${targetDir} is also used by the checkout ${owner}. cargo keys builds ` +
        'by their path inside the checkout, so checkouts sharing a target directory run each other’s ' +
        `builds. Give this checkout its own (unset CARGO_TARGET_DIR, or set one per checkout, e.g. ` +
        `CARGO_TARGET_DIR=${join(me, 'target')}), or hand this one over with \`cargo clean --target-dir ${targetDir}\`.`,
    );
  }
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(marker, `${me}\n`);
}

export function checkRuntimeBuild(bin: string, repoRoot: string): void {
  const res = spawnSync(bin, ['build-info'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 });
  let checkouts: string[] | null = null;
  if (res.status === 0) {
    try {
      const v = JSON.parse(res.stdout) as { checkouts?: unknown };
      const list: unknown = v.checkouts;
      if (Array.isArray(list)) checkouts = list.filter((c): c is string => typeof c === 'string');
    } catch {}
  }
  const remedy =
    'A cargo target directory (CARGO_TARGET_DIR) shared with another checkout makes cargo reuse that ' +
    'checkout’s build: give each checkout its own (unset CARGO_TARGET_DIR, or set one per checkout), or ' +
    'empty this one with `cargo clean`, then build again.';
  if (!checkouts?.length) {
    throw new Error(`${bin} is not this checkout’s build: it does not answer \`build-info\`. ${remedy}`);
  }
  const me = realDir(repoRoot);
  const other = checkouts.find((c) => realDir(c) !== me);
  if (other !== undefined) {
    throw new Error(`${bin} was built from the checkout ${other}, not from ${me}. ${remedy}`);
  }
}

export function askRuntimeToExit(runtime: ChildProcess): void {
  runtime.stdin?.end();
}

export interface BuildRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  release?: boolean;
  quiet?: boolean;
  target?: RuntimeTarget;
}

export interface RuntimeTarget {
  package: string;
  bin: string;
  binEnv: string;
}

export const RUNTIME: RuntimeTarget = {
  package: 'tessera-runtime',
  bin: 'tessera-runtime',
  binEnv: 'TESSERA_RUNTIME_BIN',
};

export const TEST_RUNTIME: RuntimeTarget = {
  package: 'tessera-testkit',
  bin: 'tessera-test-runtime',
  binEnv: 'TESSERA_TEST_RUNTIME_BIN',
};

interface CargoMessage {
  reason?: string;
  target?: { name?: string; kind?: string[] };
  executable?: string | null;
}

export function runtimeExecutableFromCargoMessages(stdout: string, bin = RUNTIME.bin): string | null {
  let found: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let msg: CargoMessage;
    try {
      msg = JSON.parse(line) as CargoMessage;
    } catch {
      continue;
    }
    if (
      msg.reason === 'compiler-artifact' &&
      msg.target?.name === bin &&
      msg.target.kind?.includes('bin') &&
      typeof msg.executable === 'string'
    ) {
      found = msg.executable;
    }
  }
  return found;
}

export function buildRuntime(repoRoot: string, options: BuildRuntimeOptions = {}): string {
  const base = options.env ?? process.env;
  const env = { ...base, RUSTC_WRAPPER: rustcWrapper(base) };
  const target = options.target ?? RUNTIME;
  claimTargetDir(repoRoot, cargoTargetDir(repoRoot, env));
  const args = [
    'build',
    '-p',
    target.package,
    '--bin',
    target.bin,
    '--message-format=json-render-diagnostics',
    ...(options.release ? ['--release'] : []),
    ...(options.quiet ? ['--quiet'] : []),
  ];
  const res = spawnSync('cargo', args, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw new Error(`could not run cargo: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`cargo build -p ${target.package} failed (${res.signal ?? `exit ${String(res.status)}`})`);
  }
  const exe = runtimeExecutableFromCargoMessages(res.stdout, target.bin);
  if (!exe) throw new Error(`cargo build -p ${target.package} reported no ${target.bin} executable`);
  checkRuntimeBuild(exe, repoRoot);
  return exe;
}

export interface RuntimeBinary {
  path: string;
  source: 'env' | 'prebuilt' | 'cargo';
}

const PREBUILT_DIR_ENV = 'TESSERA_PREBUILT_DIR';

export type ChangedSince = (repoRoot: string, commit: string) => string[] | null;

function changedSince(repoRoot: string, commit: string): string[] | null {
  const git = (...args: string[]) => spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  const tracked = git('diff', '--name-only', commit);
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (tracked.status !== 0 || untracked.status !== 0) return null;
  return [...tracked.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean);
}

export function prebuiltRuntime(
  repoRoot: string,
  target: RuntimeTarget,
  env: NodeJS.ProcessEnv,
  changed: ChangedSince = changedSince,
): string | null {
  const dir = env[PREBUILT_DIR_ENV] ?? join(homedir(), '.cache', 'tessera', 'bin');
  if (dir === '') return null;
  const path = join(dir, process.platform === 'win32' ? `${target.bin}.exe` : target.bin);
  let commit: string;
  try {
    commit = readFileSync(join(dir, 'main.sha'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!existsSync(path)) return null;
  const files = changed(repoRoot, commit);
  if (files === null || rustAffected(files, rustReads(repoRoot))) return null;
  return path;
}

export function resolveRuntimeBinary(repoRoot: string, options: BuildRuntimeOptions = {}): RuntimeBinary {
  const env = options.env ?? process.env;
  const binEnv = (options.target ?? RUNTIME).binEnv;
  const given = env[binEnv];
  if (given) {
    const path = isAbsolute(given) ? given : resolve(repoRoot, given);
    if (!existsSync(path)) throw new Error(`${binEnv}=${given} does not exist`);
    return { path, source: 'env' };
  }
  const prebuilt = options.release ? null : prebuiltRuntime(repoRoot, options.target ?? RUNTIME, env);
  if (prebuilt !== null) return { path: prebuilt, source: 'prebuilt' };
  return { path: buildRuntime(repoRoot, options), source: 'cargo' };
}
