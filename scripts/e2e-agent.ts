/** An e2e retry never replays. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { RERECORD_HINT } from '../e2e/agent/support/replay-only.ts';

const repo = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const ci = argv.includes('--ci');
const passthrough = argv.filter((a) => a !== '--ci');
const env: NodeJS.ProcessEnv = { ...process.env, E2E_TELEMETRY_DISABLED: '1' };
if (ci) env.CI = '1';
else delete env.CI;

const build = spawnSync(process.execPath, ['run', 'build'], { cwd: repo, env, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('e2e:agent: bun run build failed');
  process.exit(build.status ?? 1);
}

const reportPath = resolve(repo, '.e2e/report.json');
const before = existsSync(reportPath) ? statSync(reportPath).mtimeMs : 0;
const args = [
  'x',
  '--no-install',
  'e2e',
  'run',
  '--reporter',
  'list,junit',
  ...(ci ? ['--retries', '0'] : []),
  ...passthrough,
];
console.info(`\n▶ ${ci ? 'CI=1 ' : ''}bun ${args.join(' ')}`);
const run = spawnSync(process.execPath, args, { cwd: repo, env, stdio: 'inherit' });
const exitCode = run.status ?? 1;

interface Step {
  kind: string;
  api: string;
  label: string;
  status: string;
  model?: { calls?: number };
  cache?: { mode: string; reason?: string };
  error?: { code?: string };
}
interface Report {
  run: {
    results: { testId: string; attempts: { steps: Step[] }[] }[];
    usage?: { modelTokens?: number };
    errors?: { code?: string; message?: string }[];
  };
}

if (existsSync(reportPath) && statSync(reportPath).mtimeMs > before) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const tally = { replayed: 0, 'handed off': 0, missed: 0, uncached: 0 };
  let modelCalls = 0;
  const notReplayed: string[] = [];
  for (const result of report.run.results) {
    for (const attempt of result.attempts) {
      for (const step of attempt.steps) {
        if (step.kind !== 'agent') continue;
        modelCalls += step.model?.calls ?? 0;
        if (step.api !== 'agent.act') continue;
        const mode = step.cache?.mode;
        if (mode === 'self-finalized') tally.replayed++;
        else if (mode === 'agent-concluded') tally['handed off']++;
        else if (mode === 'missed') tally.missed++;
        else tally.uncached++;
        if (mode !== 'self-finalized') {
          const why = step.error?.code ?? step.cache?.reason ?? mode ?? 'cache off';
          notReplayed.push(`${decodeURIComponent(result.testId)} › "${step.label}" (${why})`);
        }
      }
    }
  }
  const tokens = report.run.usage?.modelTokens ?? 0;
  console.info(
    `\ne2e:agent ${ci ? '(replay only)' : '(record and replay)'}: agent.act ${String(tally.replayed)} replayed · ` +
      `${String(tally['handed off'])} handed off · ${String(tally.missed)} missed` +
      `${tally.uncached > 0 ? ` · ${String(tally.uncached)} uncached` : ''}; ` +
      `${String(modelCalls)} model calls, ${String(tokens)} tokens`,
  );
  if (notReplayed.length > 0) {
    console.info(`  not replayed:\n${notReplayed.map((s) => `    ${s}`).join('\n')}`);
    if (ci) console.error(`\n${RERECORD_HINT}`);
    else console.info('  Review and commit the changed files under .e2e/cache (`git status .e2e/cache`).');
  }
} else if (exitCode !== 0) {
  console.error('\ne2e:agent: the run stopped before its tests (no new .e2e/report.json); see the output above.');
}
process.exit(exitCode);
