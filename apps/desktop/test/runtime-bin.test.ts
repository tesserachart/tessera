// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRuntimeBuild,
  claimTargetDir,
  prebuiltRuntime,
  resolveRuntimeBinary,
  RUNTIME,
  runtimeExecutableFromCargoMessages,
  TARGET_DIR_OWNER,
  TEST_RUNTIME,
} from '../dev/runtime-bin.ts';

function withDir(fn: (dir: string) => void): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tessera-bin-')));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkout(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\n');
  return dir;
}

const artifact = (name: string, kind: string[], executable: string | null, fresh = true) =>
  JSON.stringify({ reason: 'compiler-artifact', target: { name, kind }, executable, fresh });

describe('runtime binary resolution', () => {
  it('runs the executable cargo reports, wherever the target directory is', () => {
    const stdout = [
      JSON.stringify({ reason: 'build-script-executed', package_id: 'x' }),
      artifact('tessera_runtime', ['lib'], null),
      artifact('tessera-gen', ['bin'], '/tmp/tessera-fix-target/debug/tessera-gen'),
      artifact('tessera-runtime', ['bin'], '/tmp/tessera-fix-target/debug/tessera-runtime'),
      JSON.stringify({ reason: 'build-finished', success: true }),
      '',
    ].join('\n');
    expect(runtimeExecutableFromCargoMessages(stdout)).toBe('/tmp/tessera-fix-target/debug/tessera-runtime');
  });

  it("finds the test runtime's executable by its own name", () => {
    const stdout = [
      artifact('tessera-runtime', ['bin'], '/t/debug/tessera-runtime'),
      artifact('tessera-test-runtime', ['bin'], '/t/debug/tessera-test-runtime'),
    ].join('\n');
    expect(runtimeExecutableFromCargoMessages(stdout, TEST_RUNTIME.bin)).toBe('/t/debug/tessera-test-runtime');
    expect(runtimeExecutableFromCargoMessages(stdout)).toBe('/t/debug/tessera-runtime');
  });

  it('finds nothing when cargo built no runtime executable', () => {
    expect(runtimeExecutableFromCargoMessages('')).toBeNull();
    expect(
      runtimeExecutableFromCargoMessages(`${artifact('tessera-gen', ['bin'], '/t/tessera-gen')}\nnot json`),
    ).toBeNull();
  });

  it('uses TESSERA_RUNTIME_BIN as given, and refuses one that does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-bin-'));
    try {
      const bin = join(dir, 'tessera-runtime');
      writeFileSync(bin, '');
      expect(resolveRuntimeBinary('/nowhere', { env: { TESSERA_RUNTIME_BIN: bin } })).toEqual({
        path: bin,
        source: 'env',
      });
      expect(resolveRuntimeBinary(dir, { env: { TESSERA_RUNTIME_BIN: 'tessera-runtime' } }).path).toBe(bin);
      expect(() => resolveRuntimeBinary(dir, { env: { TESSERA_RUNTIME_BIN: join(dir, 'missing') } })).toThrow(
        /does not exist/,
      );
      const test = join(dir, 'tessera-test-runtime');
      writeFileSync(test, '');
      expect(resolveRuntimeBinary(dir, { env: { TESSERA_TEST_RUNTIME_BIN: test }, target: TEST_RUNTIME }).path).toBe(
        test,
      );
      expect(() =>
        resolveRuntimeBinary(dir, {
          env: { TESSERA_RUNTIME_BIN: bin, TESSERA_TEST_RUNTIME_BIN: join(dir, 'missing') },
          target: TEST_RUNTIME,
        }),
      ).toThrow(/TESSERA_TEST_RUNTIME_BIN=.* does not exist/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs main's prebuilt runtime when nothing the Rust code reads changed since its commit", () => {
    withDir((dir) => {
      const prebuilt = join(dir, 'bin');
      mkdirSync(prebuilt);
      writeFileSync(join(prebuilt, 'tessera-test-runtime'), '');
      writeFileSync(join(prebuilt, 'main.sha'), 'abc123\n');
      const env = { TESSERA_PREBUILT_DIR: prebuilt };
      const repo = join(import.meta.dirname, '../../..');
      const since = (files: string[] | null) => (_repo: string, commit: string) => {
        expect(commit).toBe('abc123');
        return files;
      };
      const uiOnly = since(['apps/desktop/src/desk/Desk.tsx', 'packages/chart/src/engine.ts']);
      expect(prebuiltRuntime(repo, TEST_RUNTIME, env, uiOnly)).toBe(join(prebuilt, 'tessera-test-runtime'));
      expect(prebuiltRuntime(repo, TEST_RUNTIME, env, since([]))).toBe(join(prebuilt, 'tessera-test-runtime'));
      expect(prebuiltRuntime(repo, TEST_RUNTIME, env, since(['crates/tessera-core/src/lib.rs']))).toBeNull();
      expect(prebuiltRuntime(repo, TEST_RUNTIME, env, since(['apps/desktop/src/state/layouts.ts']))).toBeNull();
      expect(prebuiltRuntime(repo, TEST_RUNTIME, env, since(null))).toBeNull();
      expect(prebuiltRuntime(repo, RUNTIME, env, uiOnly)).toBeNull();
      expect(prebuiltRuntime(repo, TEST_RUNTIME, { TESSERA_PREBUILT_DIR: '' }, uiOnly)).toBeNull();
      expect(prebuiltRuntime(repo, TEST_RUNTIME, { TESSERA_PREBUILT_DIR: join(dir, 'none') }, uiOnly)).toBeNull();
    });
  });

  it('claims a target directory for one checkout and refuses it to another', () => {
    withDir((dir) => {
      const [main, feature] = [checkout(dir, 'main'), checkout(dir, 'feature')];
      const target = join(dir, 'shared-target');
      claimTargetDir(main, target);
      expect(readFileSync(join(target, TARGET_DIR_OWNER), 'utf8').trim()).toBe(main);
      claimTargetDir(main, target);
      expect(() => {
        claimTargetDir(feature, target);
      }).toThrow(/is also used by the checkout .*\/main\b.*CARGO_TARGET_DIR/s);
      expect(readFileSync(join(target, TARGET_DIR_OWNER), 'utf8').trim()).toBe(main);
      rmSync(main, { recursive: true });
      claimTargetDir(feature, target);
      expect(readFileSync(join(target, TARGET_DIR_OWNER), 'utf8').trim()).toBe(feature);
    });
  });

  it('refuses a runtime binary that another checkout built', () => {
    withDir((dir) => {
      const [main, feature] = [checkout(dir, 'main'), checkout(dir, 'feature')];
      const fake = (name: string, script: string) => {
        const bin = join(dir, name);
        writeFileSync(bin, `#!/bin/sh\n${script}\n`);
        chmodSync(bin, 0o755);
        return bin;
      };
      let n = 0;
      const info = (checkouts: string[]) =>
        fake(`rt-${String(++n)}`, `echo '${JSON.stringify({ version: '0.1.0', checkouts })}'`);
      checkRuntimeBuild(info([main]), main);
      checkRuntimeBuild(info([`${main}/crates/..`]), main);
      expect(() => {
        checkRuntimeBuild(info([feature]), main);
      }).toThrow(/built from the checkout .*\/feature, not from .*\/main\b.*CARGO_TARGET_DIR/s);
      expect(() => {
        checkRuntimeBuild(info([main, feature]), main);
      }).toThrow(/feature/);
      expect(() => {
        checkRuntimeBuild(fake('old', 'echo "error: unrecognized subcommand" >&2; exit 2'), main);
      }).toThrow(/does not answer `build-info`/);
    });
  });
});
