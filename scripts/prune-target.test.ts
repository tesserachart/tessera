import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveUnits, prune, unitHash } from './prune-target.ts';

const LIVE = '0123456789abcdef';
const STALE = 'fedcba9876543210';

const artifact = (filenames: string[]) => JSON.stringify({ reason: 'compiler-artifact', fresh: true, filenames });

let deps: string;

beforeEach(() => {
  deps = mkdtempSync(join(tmpdir(), 'prune-target-'));
});

afterEach(() => {
  rmSync(deps, { recursive: true, force: true });
});

describe('pruning a kept target directory', () => {
  it('reads the unit hash of every kind of file cargo writes to deps, on Windows and Unix paths', () => {
    for (const name of [
      `libserde-${LIVE}.rlib`,
      `libserde-${LIVE}.rmeta`,
      `tessera_runtime-${LIVE}.exe`,
      `tessera_runtime-${LIVE}.pdb`,
      `tessera_runtime-${LIVE}.d`,
      `windows_sys-${LIVE}.dll.lib`,
      `hub-${LIVE}`,
    ]) {
      expect(unitHash(`C:\\ci\\target\\debug\\deps\\${name}`)).toBe(LIVE);
      expect(unitHash(`/ci/target/debug/deps/${name}`)).toBe(LIVE);
    }
    expect(unitHash('tessera-runtime.exe')).toBeUndefined();
  });

  it('keeps every unit cargo reported, fresh or rebuilt, and nothing else', () => {
    const live = liveUnits(
      [
        artifact([`C:\\t\\debug\\deps\\libserde-${LIVE}.rlib`, `C:\\t\\debug\\deps\\libserde-${LIVE}.rmeta`]),
        JSON.stringify({ reason: 'build-script-executed', out_dir: `C:\\t\\debug\\build\\x-${STALE}\\out` }),
        JSON.stringify({ reason: 'build-finished', success: true }),
        'warning: a line cargo did not write as JSON',
      ].join('\n'),
    );
    expect([...live]).toEqual([LIVE]);

    for (const name of [
      `libserde-${LIVE}.rlib`,
      `libserde-${LIVE}.d`,
      `libserde-${STALE}.rlib`,
      `hub-${STALE}.exe`,
      'notes.txt',
    ])
      writeFileSync(join(deps, name), 'x'.repeat(10));
    expect(prune(deps, live)).toEqual({ removed: 2, bytes: 20 });
    expect(readdirSync(deps).sort()).toEqual([`libserde-${LIVE}.d`, `libserde-${LIVE}.rlib`, 'notes.txt']);
  });
});
