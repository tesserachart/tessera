import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UNIT_HASH = /-([0-9a-f]{16})(?=\.|$)/;

interface CargoMessage {
  reason?: string;
  filenames?: string[];
}

export function unitHash(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? '';
  return UNIT_HASH.exec(name)?.[1];
}

export function liveUnits(cargoJson: string): Set<string> {
  const live = new Set<string>();
  for (const line of cargoJson.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line) as CargoMessage;
    if (message.reason !== 'compiler-artifact') continue;
    for (const file of message.filenames ?? []) {
      const hash = unitHash(file);
      if (hash) live.add(hash);
    }
  }
  return live;
}

export function prune(deps: string, live: ReadonlySet<string>): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const name of readdirSync(deps)) {
    const hash = unitHash(name);
    if (!hash || live.has(hash)) continue;
    const path = join(deps, name);
    bytes += statSync(path).size;
    rmSync(path, { recursive: true, force: true });
    removed++;
  }
  return { removed, bytes };
}

if (import.meta.main) {
  const deps = process.argv[2];
  if (!deps) {
    console.error('usage: <cargo --message-format=json output> | bun scripts/prune-target.ts <target>/debug/deps');
    process.exit(2);
  }
  const live = liveUnits(readFileSync(0, 'utf8'));
  if (live.size === 0) {
    console.error('prune-target: cargo reported no artifacts, so none is known to be live: nothing pruned');
    process.exit(1);
  }
  const { removed, bytes } = prune(deps, live);
  console.info(
    `prune-target: kept the ${String(live.size)} units this run built, removed ${String(removed)} files of others (${(bytes / 2 ** 30).toFixed(1)} GB)`,
  );
}
