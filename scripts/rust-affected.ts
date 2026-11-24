import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const RUST_ROOTS = ['crates', 'apps/desktop/src-tauri'];

const RUST_FREE = [
  /^apps\/desktop\/(src|public|test)\//,
  /^apps\/(site|cloud)\//,
  /^packages\/(bridge|chart|ui)\//,
  /^(e2e|\.e2e|design|docs|\.agents|\.claude)\//,
  /\.md$/,
];

const PATH_LITERAL = /"\/?((?:\.\.\/)+[^"\\\s]*|(?:apps|packages|fixtures|docs)\/[^"\\\s]+)"/g;

export interface RustReads {
  files: Set<string>;
  dirs: string[];
}

function rustSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'target' && entry.name !== 'node_modules' && entry.name !== 'gen')
        found.push(...rustSources(path));
    } else if (entry.name.endsWith('.rs')) {
      found.push(path);
    }
  }
  return found;
}

function crateRoot(file: string): string {
  let dir = dirname(file);
  while (!existsSync(join(dir, 'Cargo.toml'))) dir = dirname(dir);
  return dir;
}

export function rustReads(repo: string): RustReads {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const root of RUST_ROOTS) {
    for (const source of rustSources(join(repo, root))) {
      const bases = [dirname(source), crateRoot(source), repo];
      for (const [, literal] of readFileSync(source, 'utf8').matchAll(PATH_LITERAL)) {
        for (const base of bases) {
          const path = resolve(base, literal!);
          const inRepo = relative(repo, path);
          if (inRepo === '' || inRepo.startsWith('..') || !existsSync(path)) continue;
          const posix = inRepo.split(sep).join('/');
          if (!statSync(path).isDirectory()) files.add(posix);
          else if (!source.startsWith(path + sep)) dirs.add(`${posix}/`);
        }
      }
    }
  }
  return { files, dirs: [...dirs] };
}

export function rustAffected(changed: readonly string[], reads: RustReads): boolean {
  return changed.some(
    (path) =>
      !RUST_FREE.some((free) => free.test(path)) ||
      reads.files.has(path) ||
      reads.dirs.some((dir) => path.startsWith(dir)),
  );
}

if (import.meta.main) {
  const repo = resolve(import.meta.dirname, '..');
  const changed = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  console.info(rustAffected(changed, rustReads(repo)) ? 'true' : 'false');
}
