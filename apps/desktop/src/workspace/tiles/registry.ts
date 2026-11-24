import { PrivateHost, PrivateScope, type IconName } from '@tessera/ui';
import type {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
} from 'dockview-react';
import { createElement, type FunctionComponent } from 'react';
import { ErrorBoundary } from '../../app/ErrorBoundary.tsx';
import { TileTurn } from './TileTurn.tsx';
import type { DockArea } from '../dock/edges.ts';
import type { TabEntry } from '../dock/tabMenu.ts';

export interface TileDefinition {
  kind: string;
  title: string;
  component: FunctionComponent<IDockviewPanelProps>;
  home: DockArea;
  singleton: boolean;
  icon: IconName;
  shortcut?: string;
  order: number;
  linkable: boolean;
  aliases: readonly string[];
  keywords: readonly string[];
  tab?: FunctionComponent<IDockviewPanelHeaderProps>;
  scope?: FunctionComponent<TileScopeProps>;
  badge?: FunctionComponent<IDockviewPanelHeaderProps>;
  menu?: (panel: IDockviewPanel) => TabEntry[];
  room?: number;
  minWidth?: number;
  settings?: TileSettingsDef;
  add?: TileAdd;
  private: boolean;
}

export interface TileScopeProps {
  panel: IDockviewPanel;
}

export interface TileSettingsProps {
  panel: IDockviewPanel;
}

export interface TileSettingsDef {
  component: FunctionComponent<TileSettingsProps>;
  summary?: (params: Readonly<Record<string, unknown>>) => string | null;
}

export type TileAdd = (
  api: DockviewApi,
  opts: {
    beside: string | null;
    into?: DockviewGroupPanel | null;
    taken?: ReadonlySet<string>;
    params?: Readonly<Record<string, unknown>>;
  },
) => string | null;

export interface TileRegistration<P extends object> {
  kind: string;
  title: string;
  component: FunctionComponent<IDockviewPanelProps<P>>;
  home?: DockArea;
  singleton?: boolean;
  icon: IconName;
  shortcut?: string;
  order?: number;
  linkable?: boolean;
  aliases?: readonly string[];
  keywords?: readonly string[];
  tab?: FunctionComponent<IDockviewPanelHeaderProps<P>>;
  scope?: FunctionComponent<TileScopeProps>;
  badge?: FunctionComponent<IDockviewPanelHeaderProps<P>>;
  menu?: (panel: IDockviewPanel) => TabEntry[];
  room?: number;
  minWidth?: number;
  settings?: TileSettingsDef;
  add?: TileAdd;
  private?: boolean;
}

export const UNKNOWN_TILE = 'unknown-tile';

export interface UnknownTileParams {
  originalComponent: string;
  originalParams?: unknown;
}

const tiles = new Map<string, TileDefinition>();
const aliasOf = new Map<string, string>();
const singletonIds = new Map<string, string>();

export function registerTile<P extends object>(reg: TileRegistration<P>): void {
  const def: TileDefinition = {
    kind: reg.kind,
    title: reg.title,
    component: reg.component as FunctionComponent<IDockviewPanelProps>,
    home: reg.home ?? 'centre',
    singleton: reg.singleton ?? false,
    icon: reg.icon,
    order: reg.order ?? 0,
    linkable: reg.linkable ?? false,
    aliases: reg.aliases ?? [],
    keywords: reg.keywords ?? [],
    private: reg.private ?? false,
    ...(reg.shortcut ? { shortcut: reg.shortcut } : {}),
    ...(reg.tab ? { tab: reg.tab as FunctionComponent<IDockviewPanelHeaderProps> } : {}),
    ...(reg.scope ? { scope: reg.scope } : {}),
    ...(reg.badge ? { badge: reg.badge as FunctionComponent<IDockviewPanelHeaderProps> } : {}),
    ...(reg.menu ? { menu: reg.menu } : {}),
    ...(reg.room ? { room: reg.room } : {}),
    ...(reg.minWidth ? { minWidth: reg.minWidth } : {}),
    ...(reg.settings ? { settings: reg.settings } : {}),
    ...(reg.add ? { add: reg.add } : {}),
  };
  tiles.set(def.kind, def);
  for (const a of def.aliases) aliasOf.set(a, def.kind);
  if (def.singleton) singletonIds.set(def.kind, def.kind);
}

export function resolveTileKind(kind: string): string {
  return tiles.has(kind) ? kind : (aliasOf.get(kind) ?? kind);
}

export function tileDefinition(kind: string): TileDefinition | null {
  return tiles.get(resolveTileKind(kind)) ?? null;
}

export function registeredTileKinds(): string[] {
  return [...tiles.keys()].sort();
}

export function tileDefinitions(): TileDefinition[] {
  return registeredTileKinds()
    .filter((k) => k !== UNKNOWN_TILE)
    .map((k) => tiles.get(k)!);
}

export function tileRoom(kind: string): number {
  return tileDefinition(kind)?.room ?? 0;
}

export function tileMinWidth(kind: string): number {
  return tileDefinition(kind)?.minWidth ?? 0;
}

export function singletonPanelId(kind: string): string | null {
  return singletonIds.get(resolveTileKind(kind)) ?? null;
}

export function tileComponents(): Record<string, FunctionComponent<IDockviewPanelProps>> {
  const out: Record<string, FunctionComponent<IDockviewPanelProps>> = {};
  for (const def of tiles.values()) {
    const Inner = def.component;
    const first = def.kind === 'chart';
    const Bounded: FunctionComponent<IDockviewPanelProps> = (props) => {
      const tile = createElement(Inner, props);
      return createElement(TileTurn, {
        first,
        children: createElement(ErrorBoundary, {
          name: def.title,
          children: def.private ? createElement(PrivateScope, null, tile, createElement(PrivateHost)) : tile,
        }),
      });
    };
    Bounded.displayName = `Tile(${def.kind})`;
    out[def.kind] = Bounded;
    for (const a of def.aliases) if (!tiles.has(a)) out[a] = Bounded;
  }
  return out;
}

type DockJson = Record<string, unknown>;
type PanelJson = { contentComponent?: unknown; params?: unknown } & Record<string, unknown>;

function panelsOf(dock: unknown): Record<string, PanelJson> | null {
  if (!dock || typeof dock !== 'object' || Array.isArray(dock)) return null;
  const panels = (dock as DockJson).panels;
  return panels && typeof panels === 'object' && !Array.isArray(panels) ? (panels as Record<string, PanelJson>) : null;
}

const RETIRED_TILES: ReadonlySet<string> = new Set(['markets', 'watchlist', 'research']);

export function adoptUnknownTiles(dock: unknown): { dock: unknown; unknown: string[] } {
  const panels = panelsOf(dock);
  if (!panels) return { dock, unknown: [] };
  const unknown: string[] = [];
  const retired = new Set<string>();
  const next: Record<string, PanelJson> = {};
  for (const [id, panel] of Object.entries(panels)) {
    const kind = typeof panel.contentComponent === 'string' ? panel.contentComponent : null;
    if (kind && RETIRED_TILES.has(kind)) {
      retired.add(id);
    } else if (kind && kind !== UNKNOWN_TILE && !tiles.has(resolveTileKind(kind))) {
      unknown.push(kind);
      const params: UnknownTileParams = { originalComponent: kind, originalParams: panel.params };
      next[id] = { ...panel, contentComponent: UNKNOWN_TILE, params };
    } else if (kind && resolveTileKind(kind) !== kind) {
      next[id] = { ...panel, contentComponent: resolveTileKind(kind) };
    } else {
      next[id] = panel;
    }
  }
  const adopted: DockJson = { ...(dock as DockJson), panels: next };
  return { dock: retired.size > 0 ? withoutViews(adopted, retired) : adopted, unknown };
}

type GridNode = { type?: unknown; data?: unknown } & Record<string, unknown>;

function leafWithout(node: GridNode, gone: ReadonlySet<string>): GridNode | null {
  if (node.type === 'leaf' && node.data && typeof node.data === 'object') {
    const data = node.data as { views?: unknown; activeView?: unknown };
    const views: unknown[] = Array.isArray(data.views)
      ? (data.views as unknown[]).filter((v) => !gone.has(String(v)))
      : [];
    if (views.length === 0) return null;
    const activeView = typeof data.activeView === 'string' && gone.has(data.activeView) ? views[0] : data.activeView;
    return { ...node, data: { ...data, views, activeView } };
  }
  if (node.type === 'branch' && Array.isArray(node.data)) {
    const data = (node.data as GridNode[]).flatMap((c) => leafWithout(c, gone) ?? []);
    return data.length > 0 ? { ...node, data } : null;
  }
  return node;
}

function withoutViews(dock: DockJson, gone: ReadonlySet<string>): DockJson {
  const grid = dock.grid as { root?: GridNode } | undefined;
  if (!grid?.root) return dock;
  const root = leafWithout(grid.root, gone);
  return root ? { ...dock, grid: { ...grid, root } } : dock;
}

export function restoreUnknownTiles(dock: unknown): unknown {
  const panels = panelsOf(dock);
  if (!panels) return dock;
  const next: Record<string, PanelJson> = {};
  for (const [id, panel] of Object.entries(panels)) {
    const p = panel.params as Partial<UnknownTileParams> | undefined;
    if (panel.contentComponent === UNKNOWN_TILE && typeof p?.originalComponent === 'string') {
      const restored: PanelJson = { ...panel, contentComponent: p.originalComponent };
      if (p.originalParams === undefined) delete restored.params;
      else restored.params = p.originalParams;
      next[id] = restored;
    } else {
      next[id] = panel;
    }
  }
  return { ...(dock as DockJson), panels: next };
}
