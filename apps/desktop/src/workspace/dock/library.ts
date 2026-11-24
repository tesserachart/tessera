import type { DockviewGroupPanel } from 'dockview-react';
import { showArea } from '../../areas/store.ts';
import { DEFAULT_VIEW, layoutsStore, type PopoutRecord } from '../../state/layouts.ts';
import { addChart, newChartTab } from '../addChart.ts';
import { workspaceContext } from '../controller.ts';
import { singletonPanelId, tileDefinitions, UNKNOWN_TILE, type TileDefinition } from '../tiles/registry.ts';
import { placeOf, syncEdgeChrome, type DockArea, type PanelPlace } from './edges.ts';
import { forgetClosedTile, openTile, panelKind, reservedPanelIds, revealTile, type Via } from './open.ts';
import { placeTile } from './railDrop.ts';
import { read } from '../../app/store.ts';

const WHERE_WORDS: Record<PanelPlace, string> = {
  left: 'Left side',
  right: 'Right side',
  bottom: 'Bottom',
  centre: 'Centre',
  floating: 'Floating',
  popout: 'Window',
};

const AREA_ORDER: readonly DockArea[] = ['centre', 'right', 'bottom', 'left'];

export function libraryKinds(): TileDefinition[] {
  return tileDefinitions()
    .filter((d) => d.kind !== UNKNOWN_TILE)
    .sort(
      (a, b) =>
        Number(b.kind === 'chart') - Number(a.kind === 'chart') ||
        AREA_ORDER.indexOf(a.home) - AREA_ORDER.indexOf(b.home) ||
        a.order - b.order,
    );
}

export function showTitle(def: Pick<TileDefinition, 'title'>): string {
  return `Show ${def.title}`;
}

interface OpenInstance {
  panelId: string;
  where: PanelPlace;
}

export interface LibraryRow {
  def: TileDefinition;
  open: readonly OpenInstance[];
}

interface PlacedPanel {
  id: string;
  kind: string;
  place: PanelPlace;
}

function libraryRows(docked: readonly PlacedPanel[], popouts: readonly PopoutRecord[]): LibraryRow[] {
  return libraryKinds().map((def) => ({
    def,
    open: [
      ...docked.filter((p) => p.kind === def.kind).map((p) => ({ panelId: p.id, where: p.place })),
      ...popouts.filter((p) => p.kind === def.kind).map((p) => ({ panelId: p.panelId, where: 'popout' as const })),
    ],
  }));
}

export function whereWords(row: LibraryRow): string | null {
  const first = row.open[0];
  if (!first) return null;
  if (row.def.singleton || row.open.length === 1) return WHERE_WORDS[first.where];
  return `${String(row.open.length)} open`;
}

export function deskRows(): LibraryRow[] {
  const ctx = workspaceContext();
  if (!ctx) return libraryRows([], []);
  const docked = ctx.api.panels.map((p) => ({ id: p.id, kind: panelKind(p), place: placeOf(p.group) }));
  return libraryRows(docked, (read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW).popouts);
}

export function whereNow(kind: string): string | null {
  const row = deskRows().find((r) => r.def.kind === kind);
  return row ? whereWords(row) : null;
}

function flashPanel(panelId: string): void {
  const el = workspaceContext()?.api.getPanel(panelId)?.group.element;
  if (!el) return;
  el.removeAttribute('data-flash');
  requestAnimationFrame(() => {
    el.setAttribute('data-flash', '');
    setTimeout(() => el.removeAttribute('data-flash'), 900);
  });
}

export type LibraryTarget = DockviewGroupPanel | 'centre' | null;

export function chooseFromLibrary(kind: string, into: LibraryTarget, via: Via = 'pointer'): void {
  showArea('desk');
  const ctx = workspaceContext();
  const def = libraryKinds().find((d) => d.kind === kind);
  if (!ctx || !def) return;
  const { api } = ctx;
  const group = into === 'centre' ? null : into;
  if (def.kind === 'chart') {
    const chartHere = group?.panels.find((p) => panelKind(p) === 'chart') ?? null;
    if (chartHere || !into) newChartTab(chartHere?.id ?? null);
    else void addChart({ placement: 'tab', into: group, activate: true });
    return;
  }
  if (def.singleton) {
    const id = singletonPanelId(def.kind) ?? def.kind;
    const there = api.getPanel(id);
    const away = (read(layoutsStore).views[ctx.layoutId] ?? DEFAULT_VIEW).popouts.some((p) => p.kind === def.kind);
    if (there || away || !into) {
      const shown = revealTile(def.kind, { via, focus: true });
      if (there && shown) flashPanel(shown);
      return;
    }
    const placed = placeTile(api, def.kind, group ? { group, position: 'center' } : { group: null, position: 'right' });
    if (!placed) return;
    forgetClosedTile(placed.id);
    revealTile(def.kind, { via, focus: true });
    return;
  }
  if (!into) {
    openTile(def.kind, { via, focus: true });
    return;
  }
  const id = def.add
    ? def.add(api, { beside: null, into: group, taken: reservedPanelIds(ctx.layoutId) })
    : placeTile(api, def.kind, group ? { group, position: 'center' } : { group: null, position: 'right' })?.id;
  const panel = id ? api.getPanel(id) : undefined;
  if (!panel) return;
  panel.api.setActive();
  syncEdgeChrome(api);
}
