import type { DrawingPoint } from '@tessera/chart';
import type { ChartState, Drawing, DrawingKind, DrawingLabel, DrawingStyle } from '@tessera/protocol';
import { layoutsStore } from '../../state/layouts.ts';
import { updateChart } from '../../workspace/controller.ts';
import type { ChartRef } from '../settings/store.ts';
import {
  applyChanges,
  byInstrument,
  cleanLabelText,
  diffDrawings,
  DrawingHistory,
  labelLook,
  labelOf,
  makeDrawing,
  toAnchors,
  type DrawingChange,
} from './model.ts';
import { homeOf, shownDrawings } from './sources.ts';
import { drawingStore, selectDrawing, rememberStyle } from './store.ts';
import { read } from '../../app/store.ts';

interface HomedChange extends DrawingChange {
  home: string;
}

const history = new DrawingHistory<HomedChange>();
const keyOf = (ref: ChartRef, instrument: string) => `${ref.layoutId}/${ref.tileId}/${instrument}`;

function chartsOf(ref: ChartRef): Readonly<Record<string, ChartState>> {
  return read(layoutsStore).layouts[ref.layoutId]?.charts ?? {};
}

function chartOf(ref: ChartRef) {
  return chartsOf(ref)[ref.tileId];
}

function shownOn(ref: ChartRef): readonly Drawing[] {
  return shownDrawings(chartsOf(ref), ref.tileId);
}

function editOn(ref: ChartRef, home: string, fn: (drawings: readonly Drawing[]) => Drawing[], merge?: string): void {
  void updateChart(ref.layoutId, home, (c) => {
    const before = c.drawings ?? [];
    const after = fn(before);
    const changes = diffDrawings(before, after);
    if (changes.length === 0) return c;
    for (const [instrument, part] of byInstrument(changes))
      history.record(
        keyOf(ref, instrument),
        part.map((x) => ({ ...x, home })),
        merge,
      );
    return { ...c, drawings: after };
  });
}

export function editDrawing(ref: ChartRef, id: string, fn: (drawing: Drawing) => Drawing | null, merge?: string): void {
  const home = homeOf(chartsOf(ref), ref.tileId, id);
  if (!home) return;
  editOn(ref, home, (ds) => ds.flatMap((d) => (d.id === id ? (fn(d) ?? []) : [d])), merge);
}

export function addDrawing(
  ref: ChartRef,
  kind: DrawingKind,
  points: readonly DrawingPoint[],
  instrument: string,
  extra: { text?: string } = {},
): string {
  const style = read(drawingStore).styleByKind[kind];
  const d = makeDrawing(kind, points, instrument, { ...(style ? { style } : {}), ...extra });
  editOn(ref, ref.tileId, (ds) => [...ds, d]);
  return d.id;
}

export function moveDrawing(ref: ChartRef, id: string, points: readonly DrawingPoint[]): void {
  const anchors = toAnchors(points);
  editDrawing(ref, id, (d) => ({ ...d, points: anchors }));
}

export function removeDrawing(ref: ChartRef, id: string): void {
  editDrawing(ref, id, () => null);
  const sel = read(drawingStore).selected;
  if (sel?.id === id) selectDrawing(null);
}

export function restyleDrawing(ref: ChartRef, id: string, patch: Partial<DrawingStyle>, merge?: string): void {
  const d = shownOn(ref).find((x) => x.id === id);
  if (!d) return;
  editDrawing(ref, id, (x) => ({ ...x, style: { ...x.style, ...patch } }), merge);
  const { extend: _extend, ...remembered } = patch;
  if (Object.keys(remembered).length) rememberStyle(d.kind, remembered);
}

export function relabelDrawing(
  ref: ChartRef,
  id: string,
  patch: Partial<DrawingLabel>,
  opts: { typing?: boolean; merge?: string } = {},
): void {
  const d = shownOn(ref).find((x) => x.id === id);
  const current = d ? labelOf(d) : null;
  if (!d || !current) return;
  const next: DrawingLabel = { ...current, ...patch };
  if (patch.text !== undefined) next.text = opts.typing ? patch.text : cleanLabelText(patch.text);
  if (patch.color === undefined && 'color' in patch) delete next.color;
  editDrawing(ref, id, (x) => ({ ...x, label: next }), opts.merge ?? (opts.typing ? `label:${id}` : undefined));
  const { text: _text, ...look } = patch;
  if (Object.keys(look).length) {
    rememberStyle(d.kind, { label: labelLook(next) });
  }
}

export function updateDrawing(
  ref: ChartRef,
  id: string,
  patch: Partial<Pick<Drawing, 'locked' | 'levels' | 'text'>>,
): void {
  if (patch.text?.trim() === '') {
    removeDrawing(ref, id);
    return;
  }
  editDrawing(ref, id, (x) => ({ ...x, ...patch }));
}

export function ownDrawingCount(ref: ChartRef, instrument: string): number {
  return (chartOf(ref)?.drawings ?? []).filter((d) => d.instrument === instrument).length;
}

export function removeAllDrawings(ref: ChartRef, instrument: string): number {
  const n = ownDrawingCount(ref, instrument);
  if (n) editOn(ref, ref.tileId, (ds) => ds.filter((d) => d.instrument !== instrument));
  selectDrawing(null);
  return n;
}

export function canUndoDrawings(ref: ChartRef): boolean {
  const c = chartOf(ref);
  return c !== undefined && history.canUndo(keyOf(ref, c.instrument));
}

export function canRedoDrawings(ref: ChartRef): boolean {
  const c = chartOf(ref);
  return c !== undefined && history.canRedo(keyOf(ref, c.instrument));
}

function byHome(changes: readonly HomedChange[]): Map<string, HomedChange[]> {
  const out = new Map<string, HomedChange[]>();
  for (const c of changes) out.set(c.home, [...(out.get(c.home) ?? []), c]);
  return out;
}

function step(ref: ChartRef, dir: 'undo' | 'redo'): boolean {
  const chart = chartOf(ref);
  if (!chart) return false;
  const changes = history.take(keyOf(ref, chart.instrument), dir);
  if (!changes) return false;
  for (const [home, part] of byHome(changes))
    void updateChart(ref.layoutId, home, (c) => ({ ...c, drawings: applyChanges(c.drawings ?? [], part, dir) }));
  const sel = read(drawingStore).selected;
  if (sel && !shownOn(ref).some((d) => d.id === sel.id)) selectDrawing(null);
  return true;
}

export function undoDrawings(ref: ChartRef): boolean {
  return step(ref, 'undo');
}

export function redoDrawings(ref: ChartRef): boolean {
  return step(ref, 'redo');
}
