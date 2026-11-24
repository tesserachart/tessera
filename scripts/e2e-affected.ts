import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rustReads, type RustReads } from './rust-affected.ts';

export const SPEC_DIR = 'e2e/agent';
const RECORDINGS = /^\.e2e\/cache\/[^/]+\.json$/;
const SPEC = /^e2e\/agent\/([^/]+\.e2e\.ts)$/;

export const E2E_FREE = [
  /^(docs|design|\.agents|\.claude)\//,
  /^apps\/(site|cloud|video)\//,
  /^apps\/desktop\/test\//,
  /^packages\/[^/]+\/test\//,
  /^e2e\/tauri\//,
  /\.(test|perf)\.tsx?$/,
  /^[^/]+\.md$/,
  /^scripts\/kept-comments\.json$/,
];

export const SPEC_SOURCES: Record<string, readonly string[]> = {
  'areas.e2e.ts': [
    'apps/desktop/src/areas/research/',
    'apps/desktop/src/areas/journal/',
    'apps/desktop/src/areas/settings/',
    'apps/desktop/src/analyst/',
  ],
  'chart.e2e.ts': [
    'apps/desktop/src/chart/',
    'packages/chart/',
    'apps/desktop/src/shell/CommandPalette.tsx',
    'apps/desktop/src/shell/palette.ts',
  ],
  'colour-picker.e2e.ts': ['apps/desktop/src/chart/drawings/', 'packages/ui/src/components/ColorPicker.tsx'],
  'connections.e2e.ts': [
    'apps/desktop/src/accounts/',
    'apps/desktop/src/areas/settings/',
    'apps/desktop/src/shell/ConnectionStatus.tsx',
    'apps/desktop/src/shell/RithmicMarks.tsx',
    'apps/desktop/src/shell/marks.ts',
  ],
  'design-corrections.e2e.ts': [
    'apps/desktop/src/areas/research/',
    'apps/desktop/src/areas/journal/',
    'apps/desktop/src/shell/ApprovalCard.tsx',
    'apps/desktop/src/shell/approval.ts',
  ],
  'design-system.e2e.ts': [
    'apps/desktop/src/areas/markets/',
    'apps/desktop/src/areas/journal/',
    'apps/desktop/src/areas/settings/',
    'apps/desktop/src/shell/ApprovalCard.tsx',
    'apps/desktop/src/shell/approval.ts',
  ],
  'desk-steady.e2e.ts': [
    'apps/desktop/src/chart/ticket/',
    'apps/desktop/src/workspace/tiles/PositionsTile.tsx',
    'apps/desktop/src/shell/ticket.ts',
    'apps/desktop/src/shell/orderEntry.ts',
  ],
  'panel-header.e2e.ts': ['apps/desktop/src/workspace/dock/'],
  'persistence.e2e.ts': ['apps/desktop/src/workspace/layouts.ts', 'apps/desktop/src/workspace/kept.ts'],
  'safety.e2e.ts': [
    'apps/desktop/src/analyst/',
    'apps/desktop/src/shell/analyst.ts',
    'apps/desktop/src/shell/composer.ts',
  ],
  'served.e2e.ts': [],
  'shell.e2e.ts': [],
  'trade-copier.e2e.ts': ['apps/desktop/src/areas/copy/'],
  'workspace-save.e2e.ts': [
    'apps/desktop/src/workspace/document.ts',
    'apps/desktop/src/workspace/controller.ts',
    'apps/desktop/src/workspace/Workspace.tsx',
    'apps/desktop/src/frame/',
  ],
};

type Picked =
  | { kind: 'spec'; spec: string }
  | { kind: 'sources'; specs: string[] }
  | { kind: 'free' }
  | { kind: 'all'; why: string };

export interface Selection {
  specs: 'all' | string[];
  log: string[];
}

export function specsOn(repo: string): string[] {
  return readdirSync(join(repo, SPEC_DIR))
    .filter((name) => name.endsWith('.e2e.ts'))
    .sort();
}

const covers = (source: string, path: string) => (source.endsWith('/') ? path.startsWith(source) : path === source);

function recordedSpec(repo: string, path: string): string | null {
  const file = join(repo, path);
  if (!existsSync(file)) return null;
  try {
    const recording = JSON.parse(readFileSync(file, 'utf8')) as { payload?: { recordedFor?: { testId?: string } } };
    const testFile = recording.payload?.recordedFor?.testId?.split('::')[0];
    return SPEC.exec(testFile ?? '')?.[1] ?? null;
  } catch {
    return null;
  }
}

export function pick(path: string, repo: string, reads: RustReads, specs: readonly string[]): Picked {
  if (path === 'unknown') return { kind: 'all', why: 'the changed files are unknown' };
  if (RECORDINGS.test(path)) {
    const spec = recordedSpec(repo, path);
    return spec && specs.includes(spec)
      ? { kind: 'spec', spec }
      : { kind: 'all', why: 'a recording whose spec cannot be read' };
  }
  const spec = SPEC.exec(path)?.[1];
  if (spec) return specs.includes(spec) ? { kind: 'spec', spec } : { kind: 'free' };
  if (reads.files.has(path) || reads.dirs.some((dir) => path.startsWith(dir)))
    return { kind: 'all', why: 'the Rust code reads it' };
  if (E2E_FREE.some((free) => free.test(path))) return { kind: 'free' };
  const claimed = specs.filter((s) => SPEC_SOURCES[s]?.some((source) => covers(source, path)));
  if (claimed.length > 0) return { kind: 'sources', specs: claimed };
  return { kind: 'all', why: 'shared: no spec claims it' };
}

export function e2eAffected(
  changed: readonly string[],
  repo: string,
  reads: RustReads,
  specs: readonly string[] = specsOn(repo),
): Selection {
  const picked = changed.map((path) => ({ path, picked: pick(path, repo, reads, specs) }));
  const shared = picked.flatMap(({ path, picked: p }) => (p.kind === 'all' ? [`${path} (${p.why})`] : []));
  if (shared.length > 0) {
    return {
      specs: 'all',
      log: [`e2e: all ${String(specs.length)} specs, because of`, ...shared.map((line) => `  ${line}`)],
    };
  }
  const because = new Map<string, string[]>();
  for (const { path, picked: p } of picked) {
    const hit = p.kind === 'spec' ? [p.spec] : p.kind === 'sources' ? p.specs : [];
    for (const spec of hit) because.set(spec, [...(because.get(spec) ?? []), path]);
  }
  const chosen = specs.filter((spec) => because.has(spec));
  if (chosen.length === 0) {
    return { specs: [], log: ['e2e: no spec, nothing the app under test is built from changed'] };
  }
  const skipped = specs.filter((spec) => !because.has(spec));
  return {
    specs: chosen.map((spec) => `${SPEC_DIR}/${spec}`),
    log: [
      `e2e: ${String(chosen.length)} of ${String(specs.length)} specs`,
      ...chosen.map((spec) => `  ${spec} ← ${because.get(spec)!.join(', ')}`),
      ...(skipped.length > 0 ? [`  skipped, none of their sources changed: ${skipped.join(', ')}`] : []),
    ],
  };
}

if (import.meta.main) {
  const repo = resolve(import.meta.dirname, '..');
  const changed = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const { specs, log } = e2eAffected(changed, repo, rustReads(repo));
  console.error(log.join('\n'));
  console.info(specs === 'all' ? 'all' : specs.length === 0 ? 'none' : specs.join(' '));
}
