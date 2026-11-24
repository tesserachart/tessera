import type { ChartState } from '@tessera/protocol';
import type { DockviewApi } from 'dockview-react';
import { layoutsStore, setLayoutCharts } from '../../state/layouts.ts';
import { saveLayout, workspaceContext } from '../controller.ts';
import { deskToasts } from './deskToasts.ts';
import { syncEdgeChrome } from './edges.ts';
import { patch, read, makeStore } from '../../app/store.ts';

/* dockview's own layout history ships only in the paid dockview-enterprise. */

export const UNDO_MS = 8000;
const UNDO_KEY = 'dock-undo';

interface Undoable {
  text: string;
  layoutId: string;
  tree: ReturnType<DockviewApi['toJSON']>;
  charts: Record<string, ChartState>;
  seq: number;
}

interface UndoStore {
  offer: Undoable | null;
  open: boolean;
}

export const undoStore = makeStore<UndoStore>({ offer: null, open: false });
let seq = 0;

export function snapshotForUndo(): Omit<Undoable, 'text' | 'seq'> | null {
  const ctx = workspaceContext();
  if (!ctx || ctx.popout) return null;
  const charts = read(layoutsStore).layouts[ctx.layoutId]?.charts ?? {};
  return { layoutId: ctx.layoutId, tree: ctx.api.toJSON(), charts };
}

export function offerUndo(text: string, before: Omit<Undoable, 'text' | 'seq'> | null): void {
  if (!before) return;
  const offer = { ...before, text, seq: ++seq };
  patch(undoStore, { offer, open: true });
  deskToasts.push({
    key: UNDO_KEY,
    title: text,
    ms: UNDO_MS,
    action: { label: 'Undo', run: undoDockChange },
    onClose: () => dismissUndo(offer.seq),
  });
}

export function dismissUndo(which?: number): void {
  const { offer: cur, open } = read(undoStore);
  if (!cur || !open || (which !== undefined && cur.seq !== which)) return;
  patch(undoStore, { open: false });
  deskToasts.dismiss(UNDO_KEY);
}

function undoDockChange(): void {
  const { offer, open } = read(undoStore);
  const ctx = workspaceContext();
  patch(undoStore, { open: false });
  deskToasts.dismiss(UNDO_KEY);
  if (!offer || !open || ctx?.layoutId !== offer.layoutId) return;
  const now = read(layoutsStore).layouts[offer.layoutId]?.charts ?? {};
  const missing = Object.fromEntries(Object.entries(offer.charts).filter(([id]) => !(id in now)));
  if (Object.keys(missing).length > 0) setLayoutCharts(offer.layoutId, { ...now, ...missing });
  ctx.api.fromJSON(offer.tree, { reuseExistingPanels: true });
  syncEdgeChrome(ctx.api);
  ctx.allowDockSaves();
  void saveLayout();
}
