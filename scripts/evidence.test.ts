import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { misplacedEvidence } from './evidence.ts';

const script = join(import.meta.dirname, 'evidence.ts');
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

function commit(label: string, ...paths: string[]) {
  for (const path of paths) {
    mkdirSync(dirname(join(work, path)), { recursive: true });
    writeFileSync(join(work, path), label);
  }
  git('add', '--all');
  git('commit', '-q', '--allow-empty', '-m', label);
}

function pullRequestMerge(branch: string, ...paths: string[]) {
  git('checkout', '-q', '-b', branch, 'main');
  commit(branch, ...paths);
  git('checkout', '-q', '--detach', 'main');
  git('merge', '-q', '--no-ff', '-m', `Merge ${branch} into main`, branch);
}

function check() {
  const run = spawnSync(process.execPath, [script], { cwd: work, env, encoding: 'utf8' });
  return { status: run.status, out: run.stdout + run.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evidence-'));
  work = root;
  git('init', '-q', '--bare', '-b', 'main', 'origin.git');
  git('init', '-q', '-b', 'main', 'work');
  work = join(root, 'work');
  commit('main', 'README.md', 'docs/pr/old/before.png');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('misplacedEvidence', () => {
  it('flags every file under a root pr-* folder, media or not', () => {
    expect(misplacedEvidence(['pr-999/x.png', 'pr-12/notes.md', 'PR-7/clip.mp4'])).toEqual([
      'pr-999/x.png',
      'pr-12/notes.md',
      'PR-7/clip.mp4',
    ]);
  });

  it('flags every file under docs/pr, media or not', () => {
    expect(misplacedEvidence(['docs/pr/412/after.png', 'docs/pr/412/notes.md', 'docs/PR/7/report.json'])).toEqual([
      'docs/pr/412/after.png',
      'docs/pr/412/notes.md',
      'docs/PR/7/report.json',
    ]);
  });

  it('flags screenshots, GIFs and videos outside the app’s asset folders', () => {
    expect(
      misplacedEvidence([
        'docs/pr/412/after.png',
        'shot.jpg',
        'e2e/agent/demo.gif',
        'apps/desktop/src/components/before.webp',
        'design/walkthrough.mov',
      ]),
    ).toHaveLength(5);
  });

  it('leaves the app’s own media, code, docs and nested pr-* names alone', () => {
    expect(
      misplacedEvidence([
        'apps/desktop/public/favicon-32.png',
        'apps/site/public/og.png',
        'apps/site/src/assets/shots/chart.webp',
        'apps/desktop/src/assets/rithmic/logo.png',
        'apps/desktop/src-tauri/icons/128x128.png',
        'apps/desktop/src-tauri/dmg/background.tiff',
        'packages/ui/brand/mark.png',
        'packages/ui/icons/app.png',
        'packages/ui/brand/mark.svg',
        'apps/desktop/src/sound/voice/packs/alice/alert.mp3',
        'docs/pr-workflow.md',
        'scripts/pr-tools/run.ts',
        'apps/desktop/src/pr-badge.tsx',
        '.e2e/cache/flow.json',
      ]),
    ).toEqual([]);
  });
});

describe('the evidence check', () => {
  it('fails a pull request that adds pr-999/x.png', () => {
    pullRequestMerge('evidence', 'pr-999/x.png');
    const { status, out } = check();
    expect(status).toBe(1);
    expect(out).toContain('  pr-999/x.png\n');
  });

  it('fails a pull request that adds anything under docs/pr', () => {
    pullRequestMerge('docs-pr', 'docs/pr/500/notes.md');
    const { status, out } = check();
    expect(status).toBe(1);
    expect(out).toContain('  docs/pr/500/notes.md\n');
  });

  it('passes a normal pull request, including one that ships an app icon', () => {
    pullRequestMerge('feature', 'apps/desktop/src/feature.ts', 'apps/desktop/public/icon.png', 'docs/feature.md');
    expect(check().status).toBe(0);
  });

  it('passes a pull request that deletes old evidence', () => {
    git('checkout', '-q', '-b', 'cleanup', 'main');
    git('rm', '-q', '-r', 'docs/pr');
    git('commit', '-q', '-m', 'cleanup');
    git('checkout', '-q', '--detach', 'main');
    git('merge', '-q', '--no-ff', '-m', 'Merge cleanup into main', 'cleanup');
    expect(check().status).toBe(0);
  });

  it('fails a file moved into a pr-* folder', () => {
    pullRequestMerge('move', 'notes/x.md');
    git('mv', 'notes', 'pr-5');
    git('commit', '-q', '-m', 'move');
    expect(check().status).toBe(1);
  });

  it('compares a local branch with where it left origin/main, staged files included', () => {
    git('remote', 'add', 'origin', join(root, 'origin.git'));
    git('push', '-q', 'origin', 'main');
    git('fetch', '-q', 'origin');
    git('checkout', '-q', '-b', 'local', 'origin/main');
    commit('one', 'src/a.ts');
    commit('two', 'src/b.ts');
    expect(check().status).toBe(0);
    mkdirSync(join(work, 'pr-1'));
    writeFileSync(join(work, 'pr-1/after.gif'), 'gif');
    git('add', 'pr-1/after.gif');
    const { status, out } = check();
    expect(status).toBe(1);
    expect(out).toContain('  pr-1/after.gif\n');
  });
});
