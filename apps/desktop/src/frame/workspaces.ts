import type { JsonValue, Layout, Timeframe } from '@tessera/protocol';
import { read } from '../app/store.ts';
import { displaySymbol } from '../market/instruments.ts';
import { layoutsStore } from '../state/layouts.ts';
import { uiStore } from '../state/ui.ts';
import { workspaceStore } from '../state/workspace.ts';

export function chartsBrief(charts: readonly { instrument: string; timeframe: Timeframe }[]): string {
  return charts.map((c) => `${displaySymbol(c.instrument)} ${c.timeframe}`).join(' · ');
}

export function retargetDock(dock: JsonValue, from: string, to: string): JsonValue {
  if (!dock || typeof dock !== 'object' || Array.isArray(dock)) return dock;
  const panels = (dock as Record<string, JsonValue>).panels;
  if (!panels || typeof panels !== 'object' || Array.isArray(panels)) return dock;
  const next: Record<string, JsonValue> = {};
  for (const [id, panel] of Object.entries(panels)) {
    const p = panel as Record<string, JsonValue> | null;
    const params = p?.params as Record<string, JsonValue> | undefined;
    next[id] = p && params?.layoutId === from ? { ...p, params: { ...params, layoutId: to } } : panel;
  }
  return { ...(dock as Record<string, JsonValue>), panels: next };
}

export function preferredInstrument(
  opts: {
    chosen?: unknown;
    active?: { layoutId: string; tileId: string } | null;
    recent?: readonly string[];
    layouts?: Readonly<Record<string, Layout>>;
  } = {},
): string | null {
  const chosen = typeof opts.chosen === 'string' ? opts.chosen.trim() : '';
  if (chosen) return chosen;
  const layouts = opts.layouts ?? read(layoutsStore).layouts;
  const active = opts.active === undefined ? read(workspaceStore).activeChart : opts.active;
  const current = active ? layouts[active.layoutId]?.charts[active.tileId]?.instrument : null;
  if (current) return current;
  const recent = opts.recent ?? read(uiStore).recentSymbols;
  if (recent[0]) return recent[0];
  const newest = Object.values(layouts)
    .filter((l) => Object.keys(l.charts).length > 0)
    .reduce<Layout | null>((last, l) => (!last || l.updatedAt > last.updatedAt ? l : last), null);
  const chart = newest
    ? ((newest.activeChartId ? newest.charts[newest.activeChartId] : undefined) ?? Object.values(newest.charts)[0])
    : undefined;
  return chart?.instrument ?? null;
}

export function newWorkspaceId(nowMs: number): string {
  return `ws-${Math.floor(nowMs).toString(36)}`;
}

export function nextWorkspaceName(names: readonly string[]): string {
  const taken = new Set(names);
  for (let n = names.length + 1; ; n++) {
    const name = `Workspace ${String(n)}`;
    if (!taken.has(name)) return name;
  }
}

export function copyName(name: string, names: readonly string[]): string {
  const taken = new Set(names);
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base} ${String(n)}`;
    if (!taken.has(next)) return next;
  }
}
