import type {
  DockOp,
  DockRequest,
  JsonValue,
  Layout,
  OpenTileKind,
  TilePlace,
  TileRequest,
  WorkspacePreset,
} from '@tessera/protocol';
import { DOCK_VIEW_KEY } from '../state/layouts.ts';

const KNOWN_KINDS: Record<OpenTileKind, true> = {
  chart: true,
  trade: true,
  analyst: true,
  markets: true,
  positions: true,
  accounts: true,
  alerts: true,
  dom: true,
  tape: true,
  journal: true,
  indicators: true,
  copy: true,
};
const KINDS = Object.keys(KNOWN_KINDS) as OpenTileKind[];
const OPS: readonly DockOp[] = [
  'close',
  'focus',
  'move',
  'view',
  'preset',
  'settings',
  'maximize',
  'viewport',
  'drawings',
  'trade',
];
const MOVE_TO: readonly TilePlace[] = ['left', 'right', 'bottom', 'centre', 'floating'];
const PRESETS: readonly WorkspacePreset[] = [
  '1',
  '2h',
  '2v',
  '3',
  '4',
  '6',
  'trade',
  'scalp',
  'analyse',
  'review',
  'reset',
];

type JsonObject = { [k: string]: JsonValue };
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);

function viewList(dock: JsonValue | undefined, list: 'open' | 'ops'): unknown[] {
  if (!isObject(dock)) return [];
  const view = dock[DOCK_VIEW_KEY];
  if (!isObject(view)) return [];
  const entries = view[list];
  return Array.isArray(entries) ? entries : [];
}

export function tileRequestsOf(dock: JsonValue | undefined): TileRequest[] {
  const out: TileRequest[] = [];
  for (const r of viewList(dock, 'open')) {
    if (!isObject(r)) continue;
    const { id, kind, params } = r;
    if (typeof id !== 'string' || !KINDS.includes(kind as OpenTileKind)) continue;
    const p = isObject(params) ? params : {};
    const settings = isObject(p.settings) ? p.settings : null;
    const placement = p.placement === 'tab' || p.placement === 'split' ? p.placement : null;
    out.push({
      id,
      kind: kind as OpenTileKind,
      params: {
        instrument: typeof p.instrument === 'string' ? p.instrument : null,
        link: typeof p.link === 'string' ? p.link : null,
        ...(settings ? { settings } : {}),
        ...(placement ? { placement } : {}),
        ...(typeof p.beside === 'string' ? { beside: p.beside } : {}),
      },
    });
  }
  return out;
}

export function dockOpsOf(dock: JsonValue | undefined): DockRequest[] {
  const out: DockRequest[] = [];
  for (const r of viewList(dock, 'ops')) {
    if (!isObject(r)) continue;
    const { id, op, tileId, kind, preset, settings, place } = r;
    if (typeof id !== 'string' || !OPS.includes(op as DockOp)) continue;
    out.push({
      id,
      op: op as DockOp,
      tileId: typeof tileId === 'string' ? tileId : null,
      kind: KINDS.includes(kind as OpenTileKind) ? (kind as OpenTileKind) : null,
      preset: PRESETS.includes(preset as WorkspacePreset) ? (preset as WorkspacePreset) : null,
      settings: isObject(settings) ? settings : null,
      place: MOVE_TO.includes(place as TilePlace) ? (place as TilePlace) : null,
    });
  }
  return out;
}

export type OpenParams = TileRequest['params'];

export interface TileTarget {
  tileId: string | null;
  kind: OpenTileKind | null;
}

export interface DeskRequestHandlers {
  open?: (kind: OpenTileKind, params: OpenParams) => unknown;
  close?: (target: TileTarget) => unknown;
  focus?: (target: TileTarget) => unknown;
  move?: (target: TileTarget, to: TilePlace) => unknown;
  view?: (view: DeskView) => unknown;
  preset?: (preset: WorkspacePreset) => unknown;
  settings?: (tileId: string, settings: JsonObject) => unknown;
  maximize?: (target: TileTarget, restore: boolean) => unknown;
  viewport?: (tileId: string, view: ViewportRequest) => unknown;
  drawings?: (tileId: string, action: 'undo' | 'redo') => unknown;
  trade?: (tileId: string, patch: JsonObject) => unknown;
}

interface DeskView {
  left?: boolean;
  right?: boolean;
  bottom?: boolean;
  shareInterval?: boolean;
  focus?: boolean;
}

export interface ViewportRequest {
  op?: string;
  from?: number;
  to?: number;
  lastBars?: number;
  fitAll?: boolean;
  priceMin?: number;
  priceMax?: number;
  autoScale?: boolean;
}

function viewOf(v: JsonObject): DeskView {
  const out: DeskView = {};
  for (const k of ['left', 'right', 'bottom', 'shareInterval', 'focus'] as const) {
    const b = v[k];
    if (typeof b === 'boolean') out[k] = b;
  }
  return out;
}

function viewportOf(v: JsonObject): ViewportRequest {
  const out: ViewportRequest = {};
  for (const k of ['from', 'to', 'lastBars', 'priceMin', 'priceMax'] as const) {
    const n = v[k];
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = n;
  }
  for (const k of ['fitAll', 'autoScale'] as const) if (v[k] === true) out[k] = true;
  return out;
}

const revisionOf = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? Number.NaN);

const handled = new Set<string>();

type Taken = { id: string; run: () => unknown };

export function takeDeskRequests(layout: Pick<Layout, 'id' | 'dock'>, handlers: DeskRequestHandlers): boolean {
  const queue: Taken[] = [];
  const { open, close, focus, move, view, preset, settings, maximize, viewport, drawings, trade } = handlers;
  if (open) for (const r of tileRequestsOf(layout.dock)) queue.push({ id: r.id, run: () => open(r.kind, r.params) });
  for (const r of dockOpsOf(layout.dock)) {
    const target = { tileId: r.tileId, kind: r.kind };
    const run =
      r.op === 'close' && close && (r.tileId || r.kind)
        ? () => close(target)
        : r.op === 'focus' && focus && (r.tileId || r.kind)
          ? () => focus(target)
          : r.op === 'move' && move && (r.tileId || r.kind) && r.place
            ? () => move(target, r.place!)
            : r.op === 'view' && view && r.settings
              ? () => view(viewOf(r.settings as JsonObject))
              : r.op === 'preset' && preset && r.preset
                ? () => preset(r.preset!)
                : r.op === 'settings' && settings && r.tileId && r.settings
                  ? () => settings(r.tileId!, r.settings as JsonObject)
                  : r.op === 'maximize' && maximize && (r.tileId || r.kind)
                    ? () => maximize(target, isObject(r.settings) && r.settings.restore === true)
                    : r.op === 'viewport' && viewport && r.tileId && isObject(r.settings)
                      ? () => viewport(r.tileId!, { ...viewportOf(r.settings as JsonObject), op: r.id })
                      : r.op === 'drawings' && drawings && r.tileId
                        ? () =>
                            drawings(r.tileId!, isObject(r.settings) && r.settings.action === 'redo' ? 'redo' : 'undo')
                        : r.op === 'trade' && trade && r.tileId && isObject(r.settings)
                          ? () => trade(r.tileId!, r.settings as JsonObject)
                          : null;
    if (run) queue.push({ id: r.id, run });
  }
  queue.sort((a, b) => revisionOf(a.id) - revisionOf(b.id));
  let took = false;
  for (const r of queue) {
    const key = `${layout.id}/${r.id}`;
    if (handled.has(key)) continue;
    handled.add(key);
    r.run();
    took = true;
  }
  return took;
}

export function openRequestedTiles(
  layout: Pick<Layout, 'id' | 'dock'>,
  open: (kind: OpenTileKind, params: OpenParams) => unknown,
): boolean {
  return takeDeskRequests(layout, { open });
}
