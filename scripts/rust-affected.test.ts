import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rustAffected, rustReads } from './rust-affected.ts';

const repo = join(import.meta.dirname, '..');
const reads = rustReads(repo);

describe('rustAffected', () => {
  it('skips the Rust half for a change only to the desk, the site, the UI packages, e2e or docs', () => {
    expect(
      rustAffected(
        [
          'apps/desktop/src/desk/Desk.tsx',
          'apps/site/src/pages/index.astro',
          'packages/chart/src/engine.ts',
          'packages/ui/src/Button.tsx',
          'e2e/agent/desk.test.ts',
          'docs/dev.md',
          'README.md',
        ],
        reads,
      ),
    ).toBe(false);
  });

  it('runs it for Rust, the bindings, the launchers, the build and the workflows', () => {
    for (const path of [
      'crates/tessera-core/src/lib.rs',
      'apps/desktop/src-tauri/src/lib.rs',
      'packages/protocol/src/gen/Bar.ts',
      'apps/desktop/dev/runtime-bin.ts',
      'scripts/release-smoke.ts',
      'Cargo.lock',
      'package.json',
      '.github/workflows/ci.yml',
      'fixtures/orderflow/aggregate.json',
    ]) {
      expect(rustAffected(['docs/dev.md', path], reads), path).toBe(true);
    }
  });

  it('runs it for a desk, UI or docs file the Rust code compiles in or reads', () => {
    for (const path of [
      'apps/desktop/src/state/layouts.ts',
      'packages/ui/src/styles/tokens.css',
      'packages/ui/brand/mark.svg',
      'apps/cloud/test/desktop-sign-in.json',
      'docs/indicators.md',
    ]) {
      expect(rustAffected([path], reads), path).toBe(true);
    }
  });

  it('runs it when the changed files are unknown, and not when nothing changed', () => {
    expect(rustAffected(['unknown'], reads)).toBe(true);
    expect(rustAffected([], reads)).toBe(false);
  });

  it('answers on stdout for the workflow', () => {
    const run = (input: string) =>
      execFileSync(process.execPath, [join(import.meta.dirname, 'rust-affected.ts')], {
        input,
        encoding: 'utf8',
      }).trim();
    expect(run('apps/desktop/src/desk/Desk.tsx\n')).toBe('false');
    expect(run('crates/tessera-core/src/lib.rs\n')).toBe('true');
  });
});
