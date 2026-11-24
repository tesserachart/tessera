import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MAX_WAIT_SECONDS } from './runner-dropped.ts';

const HOSTED_JOB_LIMIT_MINUTES = 360;

const execFileAsync = promisify(execFile);
const repo = join(import.meta.dirname, '..');
const dir = join(repo, '.github/workflows');
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
const workflow = (name: string) => workflows.find((w) => w.name === name)!.text;
const actionsDir = join(repo, '.github/actions');
const actions = readdirSync(actionsDir).map((name) => ({
  name: `${name}/action.yml`,
  text: readFileSync(join(actionsDir, name, 'action.yml'), 'utf8'),
}));
const action = (name: string) => actions.find((a) => a.name === `${name}/action.yml`)!.text;

const steps = (text: string) => text.split(/\n(?=\s+- )/);

function job(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  const end = text.slice(start + 1).search(/\n {2}\S/);
  return end < 0 ? text.slice(start) : text.slice(start, start + 1 + end);
}

const jobNames = (text: string) =>
  [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]!);

const REPOSITORY = 'owner/tessera';
const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/;

interface Situation {
  vars: Record<string, string>;
  event: 'push' | 'pull_request';
  from?: string;
  platform?: string;
}

const EXPRESSION_FUNCTIONS: Record<string, (argument: unknown) => unknown> = {
  fromJSON: (argument) => JSON.parse(String(argument)) as unknown,
};

function evaluateExpression(expression: string, context: Record<string, unknown>): unknown {
  const tokens = expression.match(/'[^']*'|==|!=|&&|\|\||[()!]|[\w.]+/g) ?? [];
  let at = 0;
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected !== undefined && token !== expected))
      throw new Error(`expected ${expected ?? 'more'} in ${expression}`);
    return token;
  };
  const lookup = (path: string) =>
    path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | null)?.[key] ?? null, context);
  const primary = (): unknown => {
    const token = take();
    if (token === '(') {
      const value = either();
      take(')');
      return value;
    }
    if (token === '!') return !primary();
    if (token.startsWith("'")) return token.slice(1, -1);
    if (tokens[at] !== '(') return lookup(token);
    take('(');
    const argument = either();
    take(')');
    const call = EXPRESSION_FUNCTIONS[token];
    if (!call) throw new Error(`no function ${token} in ${expression}`);
    return call(argument);
  };
  const comparison = (): unknown => {
    let value = primary();
    while (tokens[at] === '==' || tokens[at] === '!=') {
      const equal = take() === '==';
      const other = primary();
      value = equal ? value === other : value !== other;
    }
    return value;
  };
  const both = (): unknown => {
    let value = comparison();
    while (tokens[at] === '&&') {
      take();
      const other = comparison();
      value = value ? other : value;
    }
    return value;
  };
  const either = (): unknown => {
    const operands = [both()];
    while (tokens[at] === '||') {
      take();
      operands.push(both());
    }
    return operands.find(Boolean) ?? operands.at(-1);
  };
  const value = either();
  if (at !== tokens.length) throw new Error(`unread ${tokens.slice(at).join(' ')} in ${expression}`);
  return value;
}

function runner(jobText: string, at: Situation): unknown {
  const runsOn = /^ {4}runs-on: (.+)$/m.exec(jobText)?.[1];
  if (runsOn === undefined) return undefined;
  const expression = /^\$\{\{ (.+) \}\}$/.exec(runsOn)?.[1];
  if (expression === undefined) return runsOn;
  return evaluateExpression(expression, {
    vars: at.vars,
    matrix: { platform: at.platform },
    github: {
      event_name: at.event,
      repository: REPOSITORY,
      event: { pull_request: { head: { repo: { full_name: at.from ?? REPOSITORY } } } },
    },
  });
}

function runners(at: Situation): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  for (const { name, text } of workflows) {
    for (const jobName of jobNames(text)) {
      const jobText = job(text, jobName);
      if (jobText.includes('matrix.platform')) {
        for (const platform of ['linux', 'mac', 'windows'])
          all[`${name} ${jobName} ${platform}`] = runner(jobText, { ...at, platform });
      } else {
        const label = runner(jobText, at);
        if (label !== undefined) all[`${name} ${jobName}`] = label;
      }
    }
  }
  return all;
}

describe('the workflows', () => {
  it('build each release with the PostHog project, and its symbols and sourcemaps uploaded', () => {
    const build = workflows.flatMap(({ text }) => steps(text).filter((s) => s.includes('run: bun run tauri:build')));
    expect(build).toHaveLength(1);
    for (const name of [
      'TESSERA_POSTHOG_KEY',
      'POSTHOG_CLI_API_KEY',
      'POSTHOG_CLI_PROJECT_ID',
      'CARGO_PROFILE_RELEASE_DEBUG',
    ]) {
      expect(build[0]).toMatch(new RegExp(`^\\s+${name}: \\S`, 'm'));
    }
  });

  it('pin every action to a full commit, unless it is one of this repository’s own', () => {
    for (const { name, text } of [...workflows, ...actions]) {
      for (const [, used] of text.matchAll(/^\s+(?:- )?uses: (\S+)/gm)) {
        expect(used, name).toMatch(
          /@[0-9a-f]{40}$|^\.\/\.github\/actions\/[a-z-]+$|^\.\/\.github\/workflows\/[a-z-]+\.yml$/,
        );
      }
    }
  });

  it('check out without leaving credentials in .git/config', () => {
    for (const { name, text } of [...workflows, ...actions]) {
      for (const step of steps(text).filter((s) => s.includes('uses: actions/checkout@'))) {
        expect(step, name).toMatch(/^\s+persist-credentials: false$/m);
      }
    }
  });

  it('run every step of bun run check that is not opt-in once, only the platform-independent ones on any runner', async () => {
    const listed = async (...args: string[]) =>
      (
        await execFileAsync(process.execPath, [join(import.meta.dirname, 'check.ts'), ...args, '--list'], {
          encoding: 'utf8',
        })
      ).stdout
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.includes('opt-in:'))
        .map((line) => line.split(/\s+/)[0]!);
    const runs = async (text: string) =>
      (
        await Promise.all([...text.matchAll(/^\s+run: bun run check (.+)$/gm)].map((m) => listed(...m[1]!.split(' '))))
      ).flat();
    const ci = workflow('ci.yml');
    expect(ci.slice(ci.indexOf('\njobs:\n')).match(/^ {2}[a-z-]+:$/gm)).toEqual(['  check:', '  windows:']);
    const linux = ['check'].map((name) => job(ci, name));
    const windows = job(ci, 'windows');
    const build = job(workflow('build.yml'), 'build');
    const perf = job(workflow('perf.yml'), 'perf');
    expect(linux[0]).toContain('name: Check\n');
    expect(build).toContain("if: runner.os == 'Linux'\n        run: bun run check --only tauri-windows");
    expect(await runs(windows)).toEqual([]);
    expect(await runs(perf)).toEqual(['perf']);
    const linuxRuns = (await Promise.all([...linux, perf].map(runs))).flat();
    expect(linuxRuns.sort()).toEqual((await listed()).sort());
  });

  it('skip the Rust jobs by one rule, the files the Rust code reads', () => {
    const ci = workflow('ci.yml');
    expect(job(ci, 'check')).toContain('- uses: ./.github/actions/changed\n        id: changed\n');
    expect(readFileSync(join(repo, '.github/actions/changed/action.yml'), 'utf8')).toContain(
      'bun scripts/rust-affected.ts',
    );
    const jobSteps = steps(job(ci, 'check')).filter((step) => step.trim().startsWith('- '));
    const gated = jobSteps.filter((step) =>
      /tauri-linux|actions\/rust\b|--only (rust-lint|bindings|cargo-test|shell|smoke)|actions\/nextest/.test(step),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const step of gated) expect(step).toContain("steps.changed.outputs.rust != 'false'");
  });

  it('log which e2e agent specs a pull request covers, all of them when the answer fails, in both paths of a move', () => {
    const changed = action('changed');
    expect(changed).toContain('e2e=$(bun scripts/e2e-affected.ts <<< "$changed") || e2e=all\n');
    expect(changed).toContain('git diff --name-only --no-renames HEAD^1 HEAD');
    expect(changed).toMatch(/^ {2}e2e:\n {4}value: \$\{\{ steps\.changed\.outputs\.e2e \}\}$/m);
    expect(changed).toMatch(/^\s+printf '.*e2e=%s\\n' .*"\$e2e" >> "\$GITHUB_OUTPUT"$/m);
  });

  it('start one metered sandbox per push, and only that one', () => {
    const today = runners({ vars: {}, event: 'push' });
    const metered = Object.entries(today).filter(([, label]) => label === 'boat' || label === 'boat-large');
    expect(metered).toEqual([['ci.yml check', 'boat-large']]);
    const ci = Object.entries(today).filter(([at]) => at.startsWith('ci.yml '));
    expect(ci.filter(([, label]) => Array.isArray(label) && label.includes('boat'))).toEqual([]);
  });

  it('run every job on our own runners until the HOSTED_RUNNERS variable is true', () => {
    expect(runners({ vars: {}, event: 'push' })).toEqual({
      'base.yml fresh': 'ubuntu-latest',
      'build.yml ci': 'tessera-vm',
      'build.yml build linux': 'tessera-vm',
      'build.yml build mac': 'macos-15',
      'build.yml build windows': 'tessera-win',
      'build.yml publish': 'tessera-vm',
      'ci.yml check': 'boat-large',
      'ci.yml windows': 'tessera-win',
      'cloud.yml deploy': 'tessera-vm',
      'keychain.yml macos': 'macos-15',
      'main-build.yml plan': 'tessera-vm',
      'perf.yml perf': ['self-hosted', 'boat'],
      'release.yml plan': 'tessera-vm',
      'rerun.yml rerun': 'ubuntu-latest',
      'site.yml deploy': 'tessera-vm',
    });
    expect(runners({ vars: {}, event: 'pull_request' })['ci.yml check']).toBe('boat-large');
  });

  it('run every job on GitHub-hosted runners once the HOSTED_RUNNERS variable is true', () => {
    for (const event of ['push', 'pull_request'] as const) {
      for (const [at, label] of Object.entries(runners({ vars: { HOSTED_RUNNERS: 'true' }, event }))) {
        expect(label, at).toMatch(HOSTED);
      }
    }
  });

  it('never run a pull request from a fork on our own runners, nor let it publish a status', () => {
    const fork = { vars: {}, event: 'pull_request' as const, from: 'stranger/tessera' };
    for (const { name, text } of workflows.filter((w) => /^ {2}pull_request:/m.test(w.text))) {
      for (const jobName of jobNames(text)) {
        const jobText = job(text, jobName);
        if (jobText.includes("\n    if: github.event_name != 'pull_request'\n")) continue;
        expect(runner(jobText, fork), `${name} ${jobName}`).toMatch(HOSTED);
      }
    }
    const sameRepository = 'github.event.pull_request.head.repo.full_name == github.repository';
    const fresh = steps(job(workflow('ci.yml'), 'check')).find((s) =>
      s.includes('uses: ./.github/actions/fresh-base'),
    )!;
    expect(fresh).toContain(sameRepository);
    expect(job(workflow('base.yml'), 'fresh')).toContain(sameRepository);
    expect(action('fresh-base')).toContain('select(.isCrossRepository | not)');
  });

  it('never run a step on a missing checkout, even past a failed one', () => {
    for (const { name, text } of workflows) {
      const jobNames = [...text.slice(text.indexOf('\njobs:\n')).matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]!);
      for (const jobName of jobNames) {
        const jobSteps = steps(job(text, jobName));
        const at = jobSteps.findIndex((s) => s.includes('uses: actions/checkout@'));
        if (at < 0) continue;
        const pastFailures = jobSteps
          .slice(at + 1)
          .filter((s) => /^\s+if: .*(!cancelled\(\)|always\(\))/m.test(s))
          .filter((s) => /uses: \.\/|\bbun (run|scripts)\b|node scripts\//.test(s));
        if (pastFailures.length === 0) continue;
        expect(jobSteps[at], `${name} ${jobName}`).toMatch(/^\s+id: checkout$/m);
        for (const step of pastFailures)
          expect(step, `${name} ${jobName}`).toContain("steps.checkout.outcome == 'success'");
      }
    }
    expect(job(workflow('ci.yml'), 'check')).toContain(
      "- uses: ./.github/actions/bun\n        if: ${{ !cancelled() && steps.checkout.outcome == 'success' }}",
    );
  });

  it('rerun on main what a runner refused or stopped, once it can start, and only while it is main’s head', () => {
    const rerun = workflow('rerun.yml');
    expect(rerun).toContain('workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]');
    const only = job(rerun, 'rerun');
    expect(only).toContain(
      "if: github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.event != 'pull_request'",
    );
    expect(only).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(only).toContain('bun scripts/runner-dropped.ts --run "$RUN_ID" --attempt "$ATTEMPT"');
    const again = steps(only).find((s) => s.includes('gh run rerun'))!;
    expect(again).toContain("if: steps.dropped.outputs.rerun == 'true'");
    expect(again).toContain('if [ "$head" != "$HEAD_SHA" ]; then');
    expect(again.indexOf('if [ "$head" != "$HEAD_SHA" ]')).toBeLessThan(again.indexOf('gh run rerun'));
    expect(again).toContain('gh run rerun "$RUN_ID" --failed');
    const timeoutMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(only)?.[1]);
    expect(timeoutMinutes * 60).toBeGreaterThan(MAX_WAIT_SECONDS);
    expect(timeoutMinutes).toBeLessThanOrEqual(HOSTED_JOB_LIMIT_MINUTES);
  });

  it('check every pull request’s base on each push, again when its stack label changes, and when main moves past it', () => {
    const ci = workflow('ci.yml');
    const base = workflow('base.yml');
    const fresh = action('fresh-base');
    expect(fresh).toMatch(/^ {2}max-behind:\n.*\n {4}default: '5'$/m);
    expect(ci + base).not.toContain('max-behind');
    expect(job(ci, 'check')).toContain('- uses: ./.github/actions/fresh-base');
    expect(job(ci, 'check')).toContain('pull-request: ${{ github.event.pull_request.number }}');
    expect(base).toContain('types: [labeled, unlabeled]');
    expect(job(base, 'fresh')).toContain("if: github.event.label.name == 'stack'");
    expect(job(base, 'fresh')).toContain('- uses: ./.github/actions/fresh-base');
    expect(fresh).toContain('bun scripts/stale-base.ts --max-behind "$MAX_BEHIND" --labels "$labels"');
    expect(fresh).toContain('[ "$behind" -gt "$MAX_BEHIND" ] || continue');
    expect(fresh).not.toContain('gh run rerun');
  });

  it('build every platform of the daily build and of a release in one workflow, on the same runners', () => {
    const build = workflow('build.yml');
    for (const name of ['main-build.yml', 'release.yml']) {
      const text = workflow(name);
      expect(job(text, 'build'), name).toContain('uses: ./.github/workflows/build.yml');
      expect(job(text, 'build'), name).toContain('secrets: inherit');
      expect(text, name).not.toContain('tauri:build');
    }
    expect(build).toContain('platform: ${{ fromJSON(inputs.platforms) }}');
  });

  it('run every Mac job on the one runner switch', () => {
    const mac = workflows.flatMap(({ name, text }) =>
      [...text.matchAll(/^ {4}runs-on: (.*mac.*)$/gm)].map((m) => ({ name, runsOn: m[1]! })),
    );
    expect(mac.map((m) => m.name).sort()).toEqual(['build.yml', 'keychain.yml']);
    for (const { name, runsOn } of mac) expect(runsOn, name).toContain("vars.MAC_RUNNER || 'macos-15'");
  });

  it('check Windows on every push to main and never on a pull request, the newest push first', () => {
    const windows = job(workflow('ci.yml'), 'windows');
    expect(windows).toContain("if: github.event_name != 'pull_request'");
    expect(windows).toMatch(
      /concurrency:\n {6}group: ci-windows-\$\{\{ github\.ref \}\}\n {6}cancel-in-progress: true/,
    );
    expect(windows).toContain('cargo clippy --workspace --all-targets --locked -- -D warnings');
    expect(windows).toContain(
      'cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --locked -- -D warnings',
    );
    expect(windows).toContain('cargo nextest run --workspace --locked');
    expect(windows).not.toContain('steps.changed');
  });

  it('build nothing until CI passed on the commit, and publish nothing CI checked only as a pull request', () => {
    const build = workflow('build.yml');
    const gate = job(build, 'ci');
    expect(gate).toContain('actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA');
    expect(gate).toContain('if [ "$status" = completed ] && [ "$conclusion" = success ]; then\n            exit 0');
    expect(gate).toContain(
      'if [ "$PUBLISH" = true ]; then runs=\'[.workflow_runs[] | select(.event != "pull_request")]\'; fi',
    );
    expect(job(build, 'build')).toContain('\n    needs: ci\n');
    expect(job(build, 'publish')).toContain('\n    needs: [ci, build]\n');
    expect(job(build, 'publish')).toContain("needs.ci.result == 'success'");
    expect(build).not.toMatch(/cargo (clippy|nextest)|actions\/nextest/);
    for (const name of ['main-build.yml', 'release.yml']) {
      expect(workflow(name), name).not.toContain('actions/workflows/ci.yml/runs');
    }
  });

  it('build the daily app only for the platforms main changed, and off main only as a dry run', () => {
    const plan = job(workflow('main-build.yml'), 'plan');
    expect(plan).toContain('for platform in linux mac windows; do');
    expect(plan).toMatch(/platforms=\(linux\)\n.*MAC.*platforms\+=\(mac\).*\n.*WINDOWS.*platforms\+=\(windows\)/);
    expect(plan.indexOf('publish=false')).toBeLessThan(plan.indexOf('publish=true'));
    expect(job(workflow('main-build.yml'), 'build')).toContain("if: needs.plan.outputs.platforms != '[]'");
  });

  it('smoke test every runtime a bundle ships before staging it, and publish only what was staged', () => {
    const build = job(workflow('build.yml'), 'build');
    const order = [
      'run: bun run tauri:build',
      'name: Smoke test',
      'name: Stage',
      'name: staged-${{ matrix.platform }}',
    ];
    const at = order.map((step) => build.indexOf(step));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const smoke = steps(build).find((s) => s.includes('name: Smoke test'))!;
    expect(smoke).toContain(
      'runtimes=("$RUNNER_TEMP/deb/usr/bin/tessera-runtime" "$RUNNER_TEMP/squashfs-root/usr/bin/tessera-runtime")',
    );
    expect(smoke).toContain('TESSERA_RUNTIME_BIN="$runtime" bun run smoke --release');
    const publish = job(workflow('build.yml'), 'publish');
    expect(publish).toContain("if: ${{ !cancelled() && needs.ci.result == 'success' }}");
    expect(publish).toContain('if [ -n "$TAG" ] && [ "$platforms" != "$planned" ]; then');
    expect(publish).toContain('publish --platforms "$PLATFORMS"');
    expect(publish).toContain('$([ "$PUBLISH" = true ] || echo --dry-run)');
    expect(publish.indexOf('name: AWS CLI')).toBeLessThan(publish.indexOf('name: The update'));
  });

  it('publish a release only once every platform has built, as a GitHub pre-release too', () => {
    const release = job(workflow('release.yml'), 'build');
    expect(release).toContain(`platforms: '["linux", "mac", "windows"]'`);
    expect(release).toContain('tag: ${{ needs.plan.outputs.tag }}');
    const publish = job(workflow('build.yml'), 'publish');
    const prerelease = publish.slice(publish.indexOf('name: The pre-release'), publish.indexOf('name: AWS CLI'));
    expect(prerelease).toContain("if: inputs.tag != ''");
    expect(prerelease).toContain('gh release create "$TAG"');
  });
});
