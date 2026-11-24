import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

interface LockedPackage {
  name: string;
  version: string;
  dependencies: string[];
}

const locked: LockedPackage[] = read('Cargo.lock')
  .split('[[package]]')
  .slice(1)
  .map((block) => ({
    name: /^name = "([^"]+)"$/m.exec(block)![1]!,
    version: /^version = "([^"]+)"$/m.exec(block)![1]!,
    dependencies: [...block.matchAll(/^ "([^"]+)",$/gm)].map((m) => m[1]!),
  }));

const minor = (version: string) => version.split('.').slice(0, 2).join('.');

describe('Rust dependencies', () => {
  it('keep rithmic-rs and its WebSocket client in tessera-rithmic alone', () => {
    const manifests = [
      ...readdirSync(join(repo, 'crates')).map((crate) => `crates/${crate}/Cargo.toml`),
      'apps/desktop/src-tauri/Cargo.toml',
    ].filter((path) => existsSync(join(repo, path)));
    const users = manifests.filter((path) => /^(rithmic-rs|tokio-tungstenite-rithmic)\b/m.test(read(path)));
    expect(users).toEqual(['crates/tessera-rithmic/Cargo.toml']);
  });

  it('give tessera-rithmic the tokio-tungstenite rithmic-rs runs on, not another copy', () => {
    const alias = /^tokio-tungstenite-rithmic = \{ package = "tokio-tungstenite", version = "([^"]+)"/m.exec(
      read('Cargo.toml'),
    )![1]!;
    const copies = locked.filter((p) => p.name === 'tokio-tungstenite' && minor(p.version) === minor(alias));
    const used = locked
      .find((p) => p.name === 'rithmic-rs')!
      .dependencies.find((d) => d.startsWith('tokio-tungstenite'));
    expect(copies).toHaveLength(1);
    expect(['tokio-tungstenite', `tokio-tungstenite ${copies[0]!.version}`]).toContain(used);
  });
});

describe('Bun installs', () => {
  it('run no dependency’s install scripts', () => {
    const pkg = JSON.parse(read('package.json')) as { trustedDependencies?: unknown };
    expect(pkg.trustedDependencies).toEqual([]);
  });

  it('wait a day for every new version, with no package let through early', () => {
    expect(read('bunfig.toml')).toMatch(/^minimumReleaseAgeExcludes = \[\]$/m);
  });
});
