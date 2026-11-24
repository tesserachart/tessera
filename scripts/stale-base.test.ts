import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'stale-base.ts');
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

let root: string;
let work: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();

function commits(n: number, label: string) {
  for (let i = 0; i < n; i++) git('commit', '-q', '--allow-empty', '-m', `${label} ${String(i + 1)}`);
}

function branch(name: string, from: string, own: number) {
  git('checkout', '-q', '-b', name, from);
  commits(own, name);
  git('push', '-q', 'origin', name);
}

function advanceMain(n: number) {
  git('checkout', '-q', 'main');
  commits(n, 'main');
  git('push', '-q', 'origin', 'main');
}

function check(name: string, labels: string[] = []) {
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '--detach', `origin/${name}`);
  const run = spawnSync(process.execPath, [script, '--max-behind', '5', '--labels', labels.join('\n')], {
    cwd: work,
    env,
    encoding: 'utf8',
  });
  return { status: run.status, out: run.stdout + run.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stale-base-'));
  work = root;
  git('init', '-q', '--bare', '-b', 'main', 'origin.git');
  git('init', '-q', '-b', 'main', 'work');
  work = join(root, 'work');
  git('remote', 'add', 'origin', join(root, 'origin.git'));
  commits(1, 'main');
  git('push', '-q', 'origin', 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the stale-base check', () => {
  it('passes a branch at most five commits behind main', () => {
    branch('fresh', 'main', 2);
    advanceMain(5);
    const { status, out } = check('fresh');
    expect(status).toBe(0);
    expect(out).toContain('Fresh base: 5 commits behind origin/main (at most 5).');
  });

  it('fails a branch six commits behind main and says to rebase on origin/main', () => {
    branch('stale', 'main', 2);
    advanceMain(6);
    const { status, out } = check('stale');
    expect(status).toBe(1);
    expect(out).toContain('6 commits behind origin/main (at most 5)');
    expect(out).toContain('git fetch origin main\n  git rebase origin/main\n  git push --force-with-lease');
  });

  it('passes a stale branch labelled stack', () => {
    branch('stacked', 'main', 2);
    advanceMain(30);
    const { status, out } = check('stacked', ['ci', 'stack']);
    expect(status).toBe(0);
    expect(out).toContain('Labelled stack, so a stacked base passes: 30 commits behind origin/main');
  });

  it('fails a branch built on another unmerged branch and rebases its own commits alone', () => {
    branch('other', 'main', 3);
    const otherTip = git('rev-parse', 'HEAD');
    branch('rider', 'other', 2);
    const { status, out } = check('rider');
    expect(status).toBe(1);
    expect(out).toContain('carries 3 commits from other, a branch main does not have');
    expect(out).toContain(`git rebase --onto origin/main ${otherTip.slice(0, 12)}`);

    git('rebase', '-q', '--onto', 'origin/main', otherTip);
    git('push', '-q', '--force', 'origin', 'HEAD:rider');
    expect(check('rider').status).toBe(0);
  });

  it('does not blame the base of a stack for the branch stacked on it', () => {
    branch('base', 'main', 2);
    branch('on-top', 'base', 1);
    expect(check('base')).toEqual({ status: 0, out: 'Fresh base: 0 commits behind origin/main (at most 5).\n' });
    expect(check('on-top').status).toBe(1);
    expect(check('on-top', ['stack']).status).toBe(0);
  });

  it('passes a branch whose other branches main merged with a merge commit', () => {
    branch('merged', 'main', 2);
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'merged');
    git('push', '-q', 'origin', 'main');
    branch('after', 'main', 1);
    expect(check('after').status).toBe(0);
  });
});
