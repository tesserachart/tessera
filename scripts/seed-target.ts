import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface ThirdParty {
  packages: Set<string>;
  crates: Set<string>;
}

interface Metadata {
  packages: { name: string; source: string | null; targets: { name: string }[] }[];
}

const UNIT = /^(.+)-([0-9a-f]{16})$/;
const DEP_FILE = /^(.+)-([0-9a-f]{16})(\.[a-z]+)$/;
const SHARED_ARTIFACT = new Set(['.rlib', '.rmeta', '.so', '.a', '.dylib']);

export function thirdParty(manifestPath: string): ThirdParty {
  const res = spawnSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', manifestPath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`cargo metadata failed: ${res.stderr.trim()}`);
  const metadata = JSON.parse(res.stdout) as Metadata;
  const fromRegistryOrGit = metadata.packages.filter((p) => p.source !== null);
  return {
    packages: new Set(fromRegistryOrGit.map((p) => p.name)),
    crates: new Set(fromRegistryOrGit.flatMap((p) => p.targets.map((t) => t.name.replaceAll('-', '_')))),
  };
}

export interface Seeded {
  linked: number;
  copied: number;
}

function place(from: string, to: string, link: boolean, seeded: Seeded): void {
  if (existsSync(to)) return;
  const stat = statSync(from);
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) place(join(from, name), join(to, name), link, seeded);
    utimesSync(to, stat.atime, stat.mtime);
  } else if (link) {
    linkSync(from, to);
    seeded.linked++;
  } else {
    copyFileSync(from, to);
    utimesSync(to, stat.atime, stat.mtime);
    seeded.copied++;
  }
}

function placeBuildScript(from: string, to: string, seeded: Seeded): void {
  if (existsSync(to)) return;
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) place(join(from, name), join(to, name), name === 'out', seeded);
  const stat = statSync(from);
  utimesSync(to, stat.atime, stat.mtime);
}

function textNaming(dir: string, path: Buffer): boolean {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    if (statSync(entry).isDirectory()) {
      if (textNaming(entry, path)) return true;
      continue;
    }
    const bytes = readFileSync(entry);
    if (!bytes.includes(0) && bytes.includes(path)) return true;
  }
  return false;
}

function pinnedToGolden(build: string, golden: string): Set<string> {
  const pinned = new Set<string>();
  if (!existsSync(build)) return pinned;
  const path = Buffer.from(golden);
  for (const unit of readdirSync(build)) {
    const out = join(build, unit, 'out');
    if (existsSync(out) && textNaming(out, path)) pinned.add(unit);
  }
  return pinned;
}

export function seedTarget(golden: string, target: string, deps: ThirdParty): Seeded {
  const seeded: Seeded = { linked: 0, copied: 0 };
  if (!existsSync(golden)) return seeded;
  for (const profile of readdirSync(golden)) {
    const from = join(golden, profile);
    if (!existsSync(join(from, '.fingerprint'))) continue;
    const to = join(target, profile);
    const pinned = pinnedToGolden(join(from, 'build'), golden);
    for (const dir of ['.fingerprint', 'build', 'deps']) mkdirSync(join(to, dir), { recursive: true });
    for (const unit of readdirSync(join(from, '.fingerprint'))) {
      const name = UNIT.exec(unit)?.[1];
      if (name !== undefined && deps.packages.has(name) && !pinned.has(unit)) {
        place(join(from, '.fingerprint', unit), join(to, '.fingerprint', unit), false, seeded);
      }
    }
    if (existsSync(join(from, 'build'))) {
      for (const unit of readdirSync(join(from, 'build'))) {
        const name = UNIT.exec(unit)?.[1];
        if (name !== undefined && deps.packages.has(name) && !pinned.has(unit)) {
          placeBuildScript(join(from, 'build', unit), join(to, 'build', unit), seeded);
        }
      }
    }
    for (const file of readdirSync(join(from, 'deps'))) {
      const match = DEP_FILE.exec(file);
      const stem = match?.[1];
      if (match && stem !== undefined && (deps.crates.has(stem) || deps.crates.has(stem.replace(/^lib/, '')))) {
        place(join(from, 'deps', file), join(to, 'deps', file), SHARED_ARTIFACT.has(match[3]!), seeded);
      }
    }
  }
  return seeded;
}

if (import.meta.main) {
  const [golden, target, manifest] = process.argv.slice(2);
  if (!golden || !target || !manifest) {
    console.error('usage: bun scripts/seed-target.ts <golden target dir> <target dir> <Cargo.toml>');
    process.exit(2);
  }
  const started = Date.now();
  const seeded = seedTarget(resolve(golden), resolve(target), thirdParty(resolve(manifest)));
  console.info(
    `seed-target: ${String(seeded.linked)} linked, ${String(seeded.copied)} copied into ${target} in ${String(Date.now() - started)} ms`,
  );
}
