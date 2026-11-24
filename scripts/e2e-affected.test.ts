import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_FREE, e2eAffected, SPEC_DIR, SPEC_SOURCES, specsOn } from './e2e-affected.ts';
import { rustReads } from './rust-affected.ts';

const repo = join(import.meta.dirname, '..');
const reads = rustReads(repo);
const specs = specsOn(repo);
const affected = (changed: string[]) => e2eAffected(changed, repo, reads);
const recordings = readdirSync(join(repo, '.e2e/cache')).map((name) => `.e2e/cache/${name}`);
const recordingOf = (spec: string) =>
  recordings.find((path) => readFileSync(join(repo, path), 'utf8').includes(`"testId": "${SPEC_DIR}/${spec}::`));

describe('the spec map', () => {
  it('names every spec in e2e/agent, and only those', () => {
    expect(Object.keys(SPEC_SOURCES).sort()).toEqual(specs);
  });

  it('claims only sources that exist, as a directory when it ends in / and a file otherwise', () => {
    for (const [spec, sources] of Object.entries(SPEC_SOURCES)) {
      for (const source of sources) {
        const path = join(repo, source);
        expect(existsSync(path), `${spec}: ${source} is gone`).toBe(true);
        expect(statSync(path).isDirectory(), `${spec}: ${source}`).toBe(source.endsWith('/'));
      }
    }
  });

  it('claims no source an earlier rule already decides', () => {
    for (const [spec, sources] of Object.entries(SPEC_SOURCES)) {
      for (const source of sources) {
        expect(
          E2E_FREE.some((free) => free.test(source)),
          `${spec}: ${source} is e2e-free`,
        ).toBe(false);
        expect(reads.files.has(source) || reads.dirs.some((dir) => source.startsWith(dir)), `${spec}: ${source}`).toBe(
          false,
        );
      }
    }
  });

  it('knows the spec of every committed recording', () => {
    for (const path of recordings) {
      const { specs: picked } = affected([path]);
      expect(picked, path).not.toBe('all');
      expect(picked, path).toHaveLength(1);
    }
  });
});

describe('e2eAffected', () => {
  it('runs only chart.e2e.ts for a chart-only change, and says why and what it skipped', () => {
    const recording = recordingOf('chart.e2e.ts');
    expect(recording).toBeDefined();
    const changed = [
      'apps/desktop/src/chart/ChartView.tsx',
      'packages/chart/src/index.ts',
      'e2e/agent/chart.e2e.ts',
      recording!,
      'apps/desktop/test/chart-view.test.tsx',
      'docs/dev.md',
    ];
    const { specs: picked, log } = affected(changed);
    expect(picked).toEqual(['e2e/agent/chart.e2e.ts']);
    expect(log[0]).toBe(`e2e: 1 of ${String(specs.length)} specs`);
    expect(log[1]).toBe(
      `  chart.e2e.ts ← apps/desktop/src/chart/ChartView.tsx, packages/chart/src/index.ts, e2e/agent/chart.e2e.ts, ${recording!}`,
    );
    expect(log[2]).toContain('skipped, none of their sources changed: areas.e2e.ts,');
    expect(log[2]).not.toContain('chart.e2e.ts');
  });

  it('runs every spec that claims a file', () => {
    expect(affected(['apps/desktop/src/chart/drawings/DrawingToolbar.tsx']).specs).toEqual([
      'e2e/agent/chart.e2e.ts',
      'e2e/agent/colour-picker.e2e.ts',
    ]);
    expect(affected(['e2e/agent/shell.e2e.ts', 'apps/desktop/src/areas/copy/CopyPage.tsx']).specs).toEqual(
      expect.arrayContaining(['e2e/agent/shell.e2e.ts', 'e2e/agent/trade-copier.e2e.ts']),
    );
  });

  it('runs everything for a shared file, and names it', () => {
    for (const path of [
      'e2e/agent/support/launch.ts',
      'e2e/agent/support/fixtures.ts',
      'e2e.config.ts',
      'scripts/e2e-agent.ts',
      'scripts/e2e-affected.ts',
      'package.json',
      'bun.lock',
      '.github/workflows/ci.yml',
      'apps/desktop/src/app/services.ts',
      'apps/desktop/src/shell/Shell.tsx',
      'apps/desktop/src/areas/AreaRail.tsx',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/src/lib.rs',
      'apps/desktop/src/chart/templates/orderFlow.ts',
      'packages/ui/src/components/Button.tsx',
      'packages/protocol/src/runtimeClient.ts',
      'crates/tessera-testkit/src/lib.rs',
      'apps/desktop/src/brand-new-area/Page.tsx',
    ]) {
      const { specs: picked, log } = affected(['apps/desktop/src/chart/ChartView.tsx', path]);
      expect(picked, path).toBe('all');
      expect(log[0]).toBe(`e2e: all ${String(specs.length)} specs, because of`);
      expect(log.slice(1).join('\n'), path).toContain(path);
    }
    expect(affected(['e2e/agent/support/launch.ts']).log[1]).toBe(
      '  e2e/agent/support/launch.ts (shared: no spec claims it)',
    );
  });

  it('runs everything for a file the Rust code reads, even in docs', () => {
    const { specs: picked, log } = affected(['docs/indicators.md']);
    expect(picked).toBe('all');
    expect(log[1]).toBe('  docs/indicators.md (the Rust code reads it)');
  });

  it('runs everything when the changed files are unknown or a recording names no spec', () => {
    expect(affected(['unknown']).specs).toBe('all');
    expect(affected(['.e2e/cache/0000000000000000000000000000000000000000000000000000000000000000.json']).log[1]).toBe(
      '  .e2e/cache/0000000000000000000000000000000000000000000000000000000000000000.json (a recording whose spec cannot be read)',
    );
  });

  it('runs no spec when nothing the app under test is built from changed', () => {
    for (const changed of [
      [],
      ['docs/dev.md', 'README.md', 'apps/site/src/pages/index.astro', '.agents/skills/e2e/SKILL.md'],
      ['apps/desktop/src/chart/feed.test.ts', 'apps/desktop/test/loading-desk.test.tsx', 'e2e/tauri/popout.tauri.ts'],
      ['scripts/kept-comments.json', 'design/tokens/notes.txt'],
      ['e2e/agent/removed.e2e.ts'],
    ]) {
      expect(affected(changed), changed.join(' ')).toEqual({
        specs: [],
        log: ['e2e: no spec, nothing the app under test is built from changed'],
      });
    }
  });

  it('answers on stdout for the workflow and logs on stderr', () => {
    const run = (input: string) => {
      const out = execFileSync(process.execPath, [join(import.meta.dirname, 'e2e-affected.ts')], {
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return out.trim();
    };
    expect(run('apps/desktop/src/chart/ChartView.tsx\n')).toBe('e2e/agent/chart.e2e.ts');
    expect(run('e2e/agent/support/launch.ts\n')).toBe('all');
    expect(run('docs/dev.md\n')).toBe('none');
  });
});
