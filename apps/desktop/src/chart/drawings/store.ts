import { picksProfile, type DrawingPoint, type PlaceKind } from '@tessera/chart';
import type { DrawingKind } from '@tessera/protocol';
import * as Schemas from '@tessera/protocol/schemas';
import { z } from 'zod';
import { defaultStorage, patch, makeStore, type Persist, type Store, useStore } from '../../app/store.ts';
import type { ChartRef } from '../settings/store.ts';
import { TOOL_GROUPS, TOOLS, toolOf, type NewDrawingLook, type ToolGroupId } from './model.ts';

export interface DrawingRef extends ChartRef {
  id: string;
}

export type NoteEdit = (ChartRef & { id: string; point?: undefined }) | (ChartRef & { id: null; point: DrawingPoint });

export interface DrawingUiState {
  tool: PlaceKind | null;
  sticky: boolean;
  magnet: boolean;
  collapsed: boolean;
  lastInGroup: Partial<Record<ToolGroupId, PlaceKind>>;
  styleByKind: Partial<Record<DrawingKind, NewDrawingLook>>;
  selected: DrawingRef | null;
  note: NoteEdit | null;
}

const DEFAULT_DRAWING_UI: DrawingUiState = {
  tool: null,
  sticky: false,
  magnet: false,
  collapsed: false,
  lastInGroup: {},
  styleByKind: {},
  selected: null,
  note: null,
};

const NewDrawingLookSchema = z.object({
  color: z.string().optional(),
  width: z.number().optional(),
  line: Schemas.LineDash.optional(),
  extend: Schemas.DrawingExtend.optional(),
  label: Schemas.DrawingLabel.optional(),
  levels: z.array(z.number()).optional(),
});

const knownKeys = <K extends string, V>(keys: readonly K[], value: z.ZodType<V>) =>
  z.object(Object.fromEntries(keys.map((k) => [k, value.optional()]))) as unknown as z.ZodType<Partial<Record<K, V>>>;

const PERSISTED: Persist<DrawingUiState>['fields'] = {
  magnet: z.boolean(),
  collapsed: z.boolean(),
  lastInGroup: knownKeys(
    TOOL_GROUPS.map((g) => g.id),
    z.enum(TOOLS.map((t) => t.kind) as [PlaceKind, ...PlaceKind[]]),
  ),
  styleByKind: knownKeys(
    TOOLS.flatMap((t) => (picksProfile(t.kind) ? [] : [t.kind])),
    NewDrawingLookSchema,
  ),
};

export function makeDrawingStore(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = defaultStorage(),
): Store<DrawingUiState> {
  return makeStore(DEFAULT_DRAWING_UI, { persist: { key: 'tessera.drawing', version: 1, fields: PERSISTED, storage } });
}

export const drawingStore = makeDrawingStore();

export function useDrawingUi<T>(selector: (s: DrawingUiState) => T): T {
  return useStore(drawingStore, selector);
}

export const setTool = (kind: PlaceKind | null, sticky = false) =>
  patch(drawingStore, (s) => ({
    tool: kind,
    sticky: kind ? sticky : false,
    lastInGroup: kind ? { ...s.lastInGroup, [toolOf(kind).group]: kind } : s.lastInGroup,
    selected: kind ? null : s.selected,
  }));
export const setMagnet = (magnet: boolean) => patch(drawingStore, { magnet });
export const setCollapsed = (collapsed: boolean) => patch(drawingStore, { collapsed });
export const rememberStyle = (kind: DrawingKind, style: NewDrawingLook) =>
  patch(drawingStore, (s) => ({ styleByKind: { ...s.styleByKind, [kind]: { ...s.styleByKind[kind], ...style } } }));

export function setNewLook(kind: DrawingKind, look: NewDrawingLook | null): void {
  patch(drawingStore, (s) => {
    const { [kind]: _was, ...others } = s.styleByKind;
    return { styleByKind: look ? { ...others, [kind]: look } : others };
  });
}

export const selectDrawing = (selected: DrawingRef | null) => patch(drawingStore, { selected });
export const editNote = (note: NoteEdit | null) => patch(drawingStore, { note });

export function groupTool(lastInGroup: DrawingUiState['lastInGroup'], group: ToolGroupId): PlaceKind {
  return lastInGroup[group] ?? TOOL_GROUPS.find((g) => g.id === group)!.kinds[0]!;
}

export function onChart(ref: ChartRef | null, chart: ChartRef): boolean {
  return ref !== null && ref.layoutId === chart.layoutId && ref.tileId === chart.tileId;
}
