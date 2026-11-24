import {
  type ChartLayer,
  type CustomIndicator,
  type IndicatorDetail,
  type IndicatorSeries,
  type IndicatorSpec,
  type Timeframe,
} from '@tessera/protocol';
import { patch, read, makeStore, useStore } from '../../app/store.ts';
import { catalogGroups } from '../../chart/settings/catalog.ts';
import { customRef, putCustom, setCatalog, customStore } from '../../indicators/custom.ts';
import { runTool, toolCode, toolDetails, toolReason } from '../../app/tools.ts';

export type Selection = { kind: 'builtin'; key: string } | { kind: 'custom'; id: string } | { kind: 'new' } | null;

export interface CodeProblem {
  message: string;
  line: number | null;
  column: number | null;
  kind: string | null;
}

export interface RunState {
  code: string;
  status: 'running' | 'ok' | 'error';
  series: IndicatorSeries | null;
  problem: CodeProblem | null;
  logs: string;
  at: number;
}

interface PageState {
  selection: Selection;
  drafts: Readonly<Record<string, string>>;
  runs: Readonly<Record<string, RunState>>;
  inputs: Readonly<Record<string, Readonly<Record<string, number | string | boolean>>>>;
  busy: Readonly<Record<string, 'saving' | 'deleting' | 'duplicating'>>;
  saveProblems: Readonly<Record<string, CodeProblem>>;
  saved: Readonly<Record<string, { version: number; code: string; detail: IndicatorDetail }>>;
}

export const pageStore = makeStore<PageState>({
  selection: null,
  drafts: {},
  runs: {},
  inputs: {},
  busy: {},
  saveProblems: {},
  saved: {},
});

export function usePage<T>(pick: (s: PageState) => T): T {
  return useStore(pageStore, pick);
}

export function keyOf(selection: Selection): string | null {
  if (!selection) return null;
  if (selection.kind === 'new') return 'new';
  if (selection.kind === 'custom') return selection.id;
  return null;
}

function setEntry<K extends keyof PageState>(
  field: K,
  key: string,
  value: PageState[K][keyof PageState[K]] | null,
): void {
  const current = read(pageStore)[field] as Record<string, unknown>;
  const next = Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
  if (value !== null) next[key] = value;
  patch(pageStore, { [field]: next });
}

export function firstSelection(custom: readonly CustomIndicator[]): Exclude<Selection, null> {
  const last = custom[custom.length - 1];
  if (last) return { kind: 'custom', id: last.id };
  const first = catalogGroups().find((g) => g.group !== 'custom')?.specs[0];
  return { kind: 'builtin', key: first?.kind ?? 'sma' };
}

export function select(selection: Selection): void {
  patch(pageStore, { selection });
}

export const NEW_INDICATOR_CODE = `/** What it measures, in a sentence. */
export const indicator = {
  title: 'My indicator',
  placement: 'pane', // or 'overlay' to draw on the price
  inputs: {
    length: { type: 'int', default: 20, min: 2, max: 500 },
    source: 'close',
  },
  plots: [
    { name: 'value', label: 'Value', color: 'mist' },
    { name: 'zero', kind: 'hline', value: 0 },
  ],
};

export function compute(bars, inputs) {
  const src = inputs.source; // the price series the input names
  const mean = ta.sma(src, inputs.length);
  return { value: src.map((x, i) => x - mean[i]) };
}
`;
export function codeOf(s: PageState, key: string): string {
  return s.drafts[key] ?? s.saved[key]?.code ?? (key === 'new' ? NEW_INDICATOR_CODE : '');
}

export function isDirty(s: PageState, key: string): boolean {
  if (key === 'new') return true;
  const d = s.drafts[key];
  return d !== undefined && d !== s.saved[key]?.code;
}

export function edit(key: string, code: string): void {
  const s = read(pageStore);
  setEntry('drafts', key, key !== 'new' && code === s.saved[key]?.code ? null : code);
  setEntry('saveProblems', key, null);
}

export function setPreviewInput(key: string, input: string, value: number | string | boolean): void {
  const s = read(pageStore);
  setEntry('inputs', key, { ...(s.inputs[key] ?? {}), [input]: value });
}

function problemOf(e: unknown): CodeProblem {
  if (toolCode(e) !== null) {
    const d = (toolDetails(e) ?? {}) as { line?: number | null; column?: number | null; kind?: string | null };
    return {
      message: toolReason(e),
      line: typeof d.line === 'number' ? d.line : null,
      column: typeof d.column === 'number' ? d.column : null,
      kind: typeof d.kind === 'string' ? d.kind : null,
    };
  }
  return { message: e instanceof Error ? e.message : String(e), line: null, column: null, kind: null };
}

function logsOf(e: unknown): string {
  if (toolCode(e) !== null) {
    const logs = (toolDetails(e) as { logs?: unknown } | null)?.logs;
    return typeof logs === 'string' ? logs : '';
  }
  return '';
}

export const PREVIEW_BARS = 500;

export async function run(key: string, instrument: string, tf: Timeframe): Promise<void> {
  const s = read(pageStore);
  const code = codeOf(s, key);
  const inputs = s.inputs[key] ?? {};
  const prev = s.runs[key];
  setEntry('runs', key, {
    code,
    status: 'running',
    series: prev?.series ?? null,
    problem: null,
    logs: prev?.logs ?? '',
    at: Date.now(),
  });
  try {
    const series = await runTool('indicators.preview', {
      code,
      inputs,
      instrument,
      tf,
      limit: PREVIEW_BARS,
    });
    if (read(pageStore).runs[key]?.code !== code) return;
    const known = new Set(series.spec.inputs.map((i) => i.key));
    const kept = Object.fromEntries(Object.entries(inputs).filter(([k]) => known.has(k)));
    if (Object.keys(kept).length !== Object.keys(inputs).length) setEntry('inputs', key, kept);
    setEntry('runs', key, { code, status: 'ok', series, problem: null, logs: series.logs, at: Date.now() });
  } catch (e) {
    if (read(pageStore).runs[key]?.code !== code) return;
    setEntry('runs', key, {
      code,
      status: 'error',
      series: prev?.series ?? null,
      problem: problemOf(e),
      logs: logsOf(e),
      at: Date.now(),
    });
  }
}

export async function load(id: string, version?: number): Promise<IndicatorDetail> {
  const detail = await runTool('indicators.get', { id, ...(version === undefined ? {} : { version }) });
  if (version === undefined && detail.custom && detail.code !== null) {
    setEntry('saved', id, { version: detail.custom.version, code: detail.code, detail });
  }
  return detail;
}

export async function save(key: string): Promise<string | null> {
  const s = read(pageStore);
  const code = codeOf(s, key);
  setEntry('busy', key, 'saving');
  setEntry('saveProblems', key, null);
  try {
    const detail =
      key === 'new'
        ? await runTool('indicators.create_custom', { code })
        : await runTool('indicators.update_custom', {
            id: key,
            code,
            ...(s.saved[key] ? { baseVersion: s.saved[key].version } : {}),
          });
    const c = detail.custom;
    if (!c) return null;
    putCustom(c);
    setEntry('saved', c.id, { version: c.version, code: detail.code ?? code, detail });
    if (key === 'new') {
      const st = read(pageStore);
      const r = st.runs.new;
      const inputs = st.inputs.new;
      if (r) setEntry('runs', c.id, r);
      if (inputs) setEntry('inputs', c.id, inputs);
      setEntry('drafts', 'new', null);
      setEntry('runs', 'new', null);
      setEntry('inputs', 'new', null);
      select({ kind: 'custom', id: c.id });
    } else {
      setEntry('drafts', key, null);
    }
    return c.id;
  } catch (e) {
    setEntry('saveProblems', key, problemOf(e));
    return null;
  } finally {
    setEntry('busy', key, null);
  }
}

export function retitle(code: string, title: string): string {
  const lit = `'${title.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const field = /(\btitle\s*:\s*)(["'`])(?:(?!\2)[^\\]|\\.)*\2/;
  if (field.test(code)) return code.replace(field, (_m, head: string) => `${head}${lit}`);
  const decl = /(export\s+const\s+indicator\s*=\s*\{)/;
  return decl.test(code) ? code.replace(decl, `$1\n  title: ${lit},`) : code;
}

export async function duplicate(c: CustomIndicator): Promise<void> {
  const s = read(pageStore);
  const known = codeOf(s, c.id);
  const code = known !== '' ? known : ((await load(c.id)).code ?? '');
  setEntry('busy', c.id, 'duplicating');
  try {
    const detail = await runTool('indicators.create_custom', {
      code: retitle(code, `${c.spec.title} copy`),
      note: `A copy of ${c.spec.title}`,
    });
    if (detail.custom) {
      putCustom(detail.custom);
      setEntry('saved', detail.custom.id, { version: detail.custom.version, code: detail.code ?? '', detail });
      select({ kind: 'custom', id: detail.custom.id });
    }
  } catch (e) {
    setEntry('saveProblems', c.id, problemOf(e));
  } finally {
    setEntry('busy', c.id, null);
  }
}

export async function remove(id: string): Promise<void> {
  setEntry('busy', id, 'deleting');
  try {
    await runTool('indicators.delete_custom', { id });
    const { list } = read(customStore);
    setCatalog(list.filter((c) => c.id !== id));
    for (const field of ['drafts', 'runs', 'inputs', 'saved', 'saveProblems'] as const) setEntry(field, id, null);
    const sel = read(pageStore).selection;
    if (sel?.kind === 'custom' && sel.id === id) select(null);
  } catch (e) {
    setEntry('saveProblems', id, problemOf(e));
  } finally {
    setEntry('busy', id, null);
  }
}

export async function restore(id: string, version: number): Promise<void> {
  const detail = await load(id, version);
  if (detail.code !== null) edit(id, detail.code);
}

export function byWords(createdBy: string): string {
  return createdBy === 'agent' ? 'the analyst' : createdBy === 'external' ? 'an outside tool' : 'you';
}

export function countOnChart(layers: readonly ChartLayer[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const l of layers) {
    const key = l.kind === 'custom' ? customRef(l.params) : l.kind;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function onChartWords(count: number): string {
  return count > 1 ? `${String(count)} on chart` : count === 1 ? 'on chart' : '';
}

export function chartWords(chart: { instrument: string; tf: string } | null): string {
  return chart ? `${chart.instrument} · ${chart.tf}` : '';
}

export function builtinSpec(specs: readonly IndicatorSpec[], key: string): IndicatorSpec | null {
  return specs.find((s) => s.kind === key) ?? null;
}
