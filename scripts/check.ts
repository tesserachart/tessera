import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const JOBS = ['rust', 'ts', 'e2e'] as const;

interface Step {
  name: string;
  script: string;
  what: string;
  job: (typeof JOBS)[number];
  optIn?: string;
}

const STEPS: Step[] = [
  { name: 'prettier', job: 'ts', script: 'format:check', what: 'prettier --check (TS, CSS, JSON, docs)' },
  { name: 'comments', job: 'ts', script: 'comments', what: 'every comment is listed in scripts/kept-comments.json' },
  {
    name: 'evidence',
    job: 'ts',
    script: 'evidence',
    what: 'nothing under pr-*/ or docs/pr/, no screenshot, GIF or video added outside the app’s asset folders',
  },
  {
    name: 'rust-lint',
    job: 'rust',
    script: 'lint:rust',
    what: 'cargo fmt --check + clippy -D warnings (runtime and Tauri shell)',
  },
  { name: 'bindings', job: 'rust', script: 'gen:check', what: 'ts-rs bindings in packages/protocol/src/gen are fresh' },
  {
    name: 'schemas',
    job: 'ts',
    script: 'gen:schemas:check',
    what: 'zod schemas in packages/protocol/src/schemas.gen.ts match the ts-rs bindings',
  },
  { name: 'typecheck', job: 'ts', script: 'typecheck', what: 'tsc --noEmit for every package, root config and e2e' },
  { name: 'eslint', job: 'ts', script: 'lint', what: 'eslint --max-warnings=0, a worker thread per two cores' },
  {
    name: 'knip',
    job: 'ts',
    script: 'knip',
    what: 'knip: no unused file, export, type or dependency; entry points in knip.json',
  },
  { name: 'vitest', job: 'ts', script: 'test:ts', what: 'vitest (all TS packages)' },
  {
    name: 'perf',
    job: 'ts',
    script: 'test:perf',
    what: 'timing tests (*.perf.ts), one file at a time, nothing else running',
  },
  { name: 'cargo-test', job: 'rust', script: 'test:rust', what: 'cargo nextest run --workspace' },
  { name: 'shell', job: 'rust', script: 'test:shell', what: 'cargo test of the Tauri shell (sidecar supervision)' },
  {
    name: 'smoke',
    job: 'rust',
    script: 'smoke',
    what: 'release smoke: the runtime boots headless, a 1-lot is placed and flattened on paper (docs/release-smoke-test.md)',
  },
  {
    name: 'e2e-agent',
    job: 'e2e',
    script: 'e2e:agent:ci',
    what: 'e2e agent suite, replay only: committed .e2e/cache recordings, no model (CI=1); opt-in: TESSERA_CHECK_AGENT=1',
    optIn: 'TESSERA_CHECK_AGENT',
  },
  {
    name: 'tauri-windows',
    job: 'e2e',
    script: 'e2e:tauri',
    what: 'the real Tauri app on Linux, its pop-out windows driven through tauri-driver under Xvfb and openbox; opt-in: TESSERA_CHECK_TAURI=1',
    optIn: 'TESSERA_CHECK_TAURI',
  },
];

function listArg(flag: string): string[] | null {
  const args = process.argv.slice(2);
  const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return null;
  const value = args[i]!.includes('=') ? args[i]!.split('=')[1]! : (args[i + 1] ?? '');
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const only = listArg('--only');
const skip = listArg('--skip') ?? [];
const jobs = listArg('--job');
const unknown = [...(only ?? []), ...skip].filter((n) => !STEPS.some((s) => s.name === n));
const unknownJobs = (jobs ?? []).filter((j) => !(JOBS as readonly string[]).includes(j));
if (unknown.length > 0 || unknownJobs.length > 0) {
  const what = [...unknown.map((n) => `step ${n}`), ...unknownJobs.map((j) => `job ${j}`)].join(', ');
  console.error(`bun run check: unknown ${what} (see bun run check --list)`);
  process.exit(2);
}
const selected = (s: Step) =>
  (only ? only.includes(s.name) : true) && (jobs ? jobs.includes(s.job) : true) && !skip.includes(s.name);
const optedOut = (s: Step) => !!s.optIn && process.env[s.optIn] !== '1' && !only?.includes(s.name);
const steps = STEPS.filter((s) => selected(s) && !optedOut(s));
const skippedOptIn = STEPS.filter((s) => selected(s) && optedOut(s));

if (process.argv.includes('--list')) {
  for (const s of STEPS.filter(selected)) {
    console.info(`${s.name.padEnd(11)} ${s.job.padEnd(5)} bun run ${s.script.padEnd(13)} ${s.what}`);
  }
  process.exit(0);
}

const env = { ...process.env };
if (env.RUSTC_WRAPPER === undefined) {
  const sccache = spawnSync('sccache', ['--version'], { stdio: 'ignore' });
  env.RUSTC_WRAPPER = sccache.status === 0 ? 'sccache' : '';
}

const repo = resolve(import.meta.dirname, '..');
const heading = (step: Step) => `\n\x1b[1m▶ ${step.name}\x1b[0m  bun run ${step.script}  (${step.what})`;
const results: { step: Step; ok: boolean; seconds: number }[] = [];

function runBuffered(step: Step): Promise<{ step: Step; ok: boolean; seconds: number; output: Buffer[] }> {
  const started = Date.now();
  const output: Buffer[] = [];
  const child = spawn(process.execPath, ['run', step.script], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
  return new Promise((done) => {
    child.on('close', (code) => {
      done({ step, ok: code === 0, seconds: (Date.now() - started) / 1000, output });
    });
  });
}

if (process.argv.includes('--parallel')) {
  for (const { step, ok, seconds, output } of await Promise.all(steps.map(runBuffered))) {
    console.info(heading(step));
    process.stdout.write(Buffer.concat(output));
    results.push({ step, ok, seconds });
  }
} else {
  for (const step of steps) {
    console.info(heading(step));
    const started = Date.now();
    const res = spawnSync(process.execPath, ['run', step.script], { cwd: repo, env, stdio: 'inherit' });
    const ok = res.status === 0;
    results.push({ step, ok, seconds: (Date.now() - started) / 1000 });
    if (!ok) break;
  }
}

console.info('\n\x1b[1mbun run check\x1b[0m');
for (const { step, ok, seconds } of results) {
  console.info(`  ${ok ? '✓' : '✗'} ${step.name.padEnd(11)} ${seconds.toFixed(1).padStart(6)}s`);
}
const notRun = steps.slice(results.length);
for (const step of notRun) console.info(`  · ${step.name.padEnd(11)} not run`);
for (const step of skippedOptIn) console.info(`  · ${step.name.padEnd(11)} opt-in (${step.optIn ?? ''}=1)`);
const failed = results.find((r) => !r.ok);
if (failed) {
  console.error(`\nbun run check failed at ${failed.step.name}; rerun it alone with: bun run ${failed.step.script}`);
  process.exit(1);
}
console.info(`\nall ${String(results.length)} steps passed`);
