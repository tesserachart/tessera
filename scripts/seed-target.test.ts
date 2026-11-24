import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { seedTarget, type ThirdParty } from './seed-target.ts';

const HASH = '0123456789abcdef';
const OLD = new Date('2026-10-01T00:00:00Z');
const deps: ThirdParty = {
  packages: new Set(['serde', 'aws-lc-sys', 'libc']),
  crates: new Set(['serde', 'aws_lc_sys', 'libc']),
};

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function golden(files: string[]): string {
  dir = mkdtempSync(join(tmpdir(), 'seed-target-'));
  const root = join(dir, 'golden');
  for (const file of files) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file);
    utimesSync(path, OLD, OLD);
  }
  return root;
}

const inode = (path: string) => statSync(path).ino;

describe('seedTarget', () => {
  const files = [
    `debug/.fingerprint/serde-${HASH}/lib-serde`,
    `debug/.fingerprint/tessera-core-${HASH}/lib-tessera_core`,
    `debug/build/aws-lc-sys-${HASH}/out/crypto.o`,
    `debug/build/aws-lc-sys-${HASH}/output`,
    `debug/build/tessera-runtime-${HASH}/output`,
    `debug/deps/libserde-${HASH}.rlib`,
    `debug/deps/libserde-${HASH}.rmeta`,
    `debug/deps/serde-${HASH}.d`,
    `debug/deps/liblibc-${HASH}.rlib`,
    `debug/deps/libc-${HASH}.d`,
    `debug/deps/libtessera_core-${HASH}.rlib`,
    `debug/deps/tessera_core-${HASH}.d`,
    'debug/incremental/tessera_core-1/s-1/dep-graph.bin',
    'debug/tessera-runtime',
  ];

  it('links the registry crates’ libraries and build output and copies their metadata, with its times', () => {
    const from = golden(files);
    const to = join(dir, 'target');
    const seeded = seedTarget(from, to, deps);
    for (const file of [`deps/libserde-${HASH}.rlib`, `deps/libserde-${HASH}.rmeta`, `deps/liblibc-${HASH}.rlib`]) {
      expect(inode(join(to, 'debug', file)), file).toBe(inode(join(from, 'debug', file)));
    }
    expect(inode(join(to, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`))).toBe(
      inode(join(from, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`)),
    );
    for (const file of [
      `.fingerprint/serde-${HASH}/lib-serde`,
      `build/aws-lc-sys-${HASH}/output`,
      `deps/serde-${HASH}.d`,
      `deps/libc-${HASH}.d`,
    ]) {
      const path = join(to, 'debug', file);
      expect(inode(path), file).not.toBe(inode(join(from, 'debug', file)));
      expect(readFileSync(path, 'utf8')).toBe(`debug/${file}`);
      expect(statSync(path).mtime).toEqual(OLD);
    }
    expect(seeded).toEqual({ linked: 4, copied: 4 });
  });

  it('never seeds the workspace’s own crates, their build scripts, incremental state or binaries', () => {
    const from = golden(files);
    const to = join(dir, 'target');
    seedTarget(from, to, deps);
    for (const file of [
      `.fingerprint/tessera-core-${HASH}`,
      `build/tessera-runtime-${HASH}`,
      `deps/libtessera_core-${HASH}.rlib`,
      `deps/tessera_core-${HASH}.d`,
      'incremental',
      'tessera-runtime',
    ]) {
      expect(existsSync(join(to, 'debug', file)), file).toBe(false);
    }
  });

  it('leaves out a build script whose output names the golden directory, fingerprint and all', () => {
    const from = golden([...files, `debug/.fingerprint/libc-${HASH}/run-build-script-build-script-build`]);
    const out = join(from, `debug/build/libc-${HASH}/out`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'permission-files'), JSON.stringify([join(out, 'permissions/app.toml')]));
    const to = join(dir, 'target');
    seedTarget(from, to, deps);
    expect(existsSync(join(to, `debug/build/libc-${HASH}`))).toBe(false);
    expect(existsSync(join(to, `debug/.fingerprint/libc-${HASH}`))).toBe(false);
    expect(existsSync(join(to, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`))).toBe(true);
    expect(existsSync(join(to, `debug/deps/liblibc-${HASH}.rlib`))).toBe(true);
  });

  it('still seeds a build script whose compiled objects carry the golden directory in their debug info', () => {
    const from = golden(files);
    writeFileSync(
      join(from, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`),
      Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]), Buffer.from(from)]),
    );
    const to = join(dir, 'target');
    seedTarget(from, to, deps);
    expect(inode(join(to, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`))).toBe(
      inode(join(from, `debug/build/aws-lc-sys-${HASH}/out/crypto.o`)),
    );
  });

  it('keeps what the target already has and adds nothing the second time', () => {
    const from = golden(files);
    const to = join(dir, 'target');
    const own = join(to, `debug/deps/serde-${HASH}.d`);
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, 'built here');
    expect(seedTarget(from, to, deps)).toEqual({ linked: 4, copied: 3 });
    expect(readFileSync(own, 'utf8')).toBe('built here');
    expect(seedTarget(from, to, deps)).toEqual({ linked: 0, copied: 0 });
  });

  it('does nothing without a golden target', () => {
    dir = mkdtempSync(join(tmpdir(), 'seed-target-'));
    expect(seedTarget(join(dir, 'missing'), join(dir, 'target'), deps)).toEqual({ linked: 0, copied: 0 });
    expect(existsSync(join(dir, 'target'))).toBe(false);
  });
});
