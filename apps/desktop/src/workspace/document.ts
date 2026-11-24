import type { Layout, LayoutSummary } from '@tessera/protocol';
import { makeStore, patch, read, useStore } from '../app/store.ts';
import { runTool } from '../app/tools.ts';
import { RETIRED_AREA_LAYOUTS } from '../state/layouts.ts';
import { setWorkspace, uiStore } from '../state/ui.ts';
import { deskContextOf, layoutSaved, stopLayoutWrites, workspaceContext } from './controller.ts';

export type LeaveChoice = 'save' | 'discard' | 'cancel';
type Leaving = 'switch' | 'quit';

export interface LeaveAsk {
  names: readonly string[];
  leaving: Leaving;
}

export interface RecoveredWorkspaces {
  ids: readonly string[];
  names: readonly string[];
}

interface DocumentState {
  known: Record<string, { revision: number; unsaved: boolean }>;
  ask: LeaveAsk | null;
  recovered: RecoveredWorkspaces | null;
}

type Document = Pick<Layout, 'id' | 'revision'> & { unsaved?: boolean | undefined };

export const documentStore = makeStore<DocumentState>({ known: {}, ask: null, recovered: null });

export function noteDocument(layout: Document): void {
  const known = read(documentStore).known[layout.id];
  const unsaved = layout.unsaved === true;
  if (known && (known.revision > layout.revision || (known.revision === layout.revision && known.unsaved === unsaved)))
    return;
  patch(documentStore, (s) => ({ known: { ...s.known, [layout.id]: { revision: layout.revision, unsaved } } }));
}

export function isUnsaved(layoutId: string | null): boolean {
  return layoutId !== null && read(documentStore).known[layoutId]?.unsaved === true;
}

export function useUnsaved(layoutId: string | null): boolean {
  return useStore(documentStore, (s) => (layoutId ? s.known[layoutId]?.unsaved === true : false));
}

let answer: ((choice: LeaveChoice) => void) | null = null;

function askLeave(ask: LeaveAsk): Promise<LeaveChoice> {
  if (answer) return Promise.resolve('cancel');
  return new Promise((resolve) => {
    answer = (choice) => {
      answer = null;
      patch(documentStore, { ask: null });
      resolve(choice);
    };
    patch(documentStore, { ask });
  });
}

export function answerLeave(choice: LeaveChoice): void {
  answer?.(choice);
}

function shownDesk(): string | null {
  const ctx = workspaceContext();
  return ctx && !ctx.popout ? ctx.layoutId : null;
}

async function settle(layoutId: string): Promise<void> {
  await deskContextOf(layoutId)?.flush?.();
  await layoutSaved();
}

export async function saveWorkspace(layoutId: string | null = shownDesk()): Promise<void> {
  if (!layoutId) return;
  await settle(layoutId);
  const out = await runTool('workspace.save', { layoutId });
  noteDocument({ id: layoutId, revision: out.revision, unsaved: false });
}

export async function revertWorkspace(layoutId: string | null = shownDesk()): Promise<void> {
  if (!layoutId) return;
  await settle(layoutId);
  const out = await runTool('workspace.revert', { layoutId });
  noteDocument({ id: layoutId, revision: out.revision, unsaved: false });
  const recovered = read(documentStore).recovered;
  if (recovered?.ids.includes(layoutId)) patch(documentStore, { recovered: null });
}

async function unsavedLayout(layoutId: string): Promise<Layout | null> {
  await settle(layoutId);
  try {
    const layout = await runTool('layout.get', { layoutId });
    noteDocument(layout);
    return layout.unsaved === true ? layout : null;
  } catch {
    return null;
  }
}

const nothingLeft = (): Promise<void> => Promise.resolve();

export async function leaveWorkspace(): Promise<(() => Promise<void>) | null> {
  const from = shownDesk();
  if (!from) return nothingLeft;
  const layout = await unsavedLayout(from);
  if (!layout) return nothingLeft;
  const choice = await askLeave({ names: [layout.name], leaving: 'switch' });
  if (choice === 'cancel') return null;
  if (choice === 'save') {
    await saveWorkspace(from);
    return nothingLeft;
  }
  return () => revertWorkspace(from);
}

export async function switchWorkspace(next: string | null): Promise<boolean> {
  if (read(uiStore).workspace === next) return true;
  if (!shownDesk()) {
    setWorkspace(next);
    return true;
  }
  const left = await leaveWorkspace();
  if (!left) return false;
  setWorkspace(next);
  await left();
  return true;
}

export async function confirmQuit(): Promise<boolean> {
  const shown = shownDesk();
  if (shown) await settle(shown);
  let unsaved: LayoutSummary[];
  try {
    const list = await runTool('layout.list', {});
    unsaved = list.layouts.filter((l) => l.unsaved === true && !RETIRED_AREA_LAYOUTS.includes(l.id));
  } catch {
    return true;
  }
  if (unsaved.length > 0) {
    const choice = await askLeave({ names: unsaved.map((l) => l.name), leaving: 'quit' });
    if (choice === 'cancel') return false;
    stopLayoutWrites();
    const tool = choice === 'save' ? 'workspace.save' : 'workspace.revert';
    for (const l of unsaved) {
      await runTool(tool, { layoutId: l.id }).catch((err: unknown) => {
        console.warn(`[workspace] ${tool} ${l.id} before quitting failed; its changes come back next time`, err);
      });
    }
    return true;
  }
  stopLayoutWrites();
  return true;
}

let recoveryChecked = false;

export async function checkRecovered(): Promise<void> {
  if (recoveryChecked) return;
  recoveryChecked = true;
  let rows: LayoutSummary[];
  try {
    rows = (await runTool('layout.list', {})).layouts.filter((l) => !RETIRED_AREA_LAYOUTS.includes(l.id));
  } catch {
    recoveryChecked = false;
    return;
  }
  for (const l of rows) noteDocument(l);
  const recovered = rows.filter((l) => l.recovered === true);
  if (recovered.length > 0)
    patch(documentStore, { recovered: { ids: recovered.map((l) => l.id), names: recovered.map((l) => l.name) } });
}

export function keepRecovered(): void {
  patch(documentStore, { recovered: null });
}

export async function revertRecovered(): Promise<void> {
  const ids = read(documentStore).recovered?.ids ?? [];
  patch(documentStore, { recovered: null });
  for (const id of ids) await revertWorkspace(id);
}

function quoted(names: readonly string[]): string {
  const q = names.map((n) => `“${n}”`);
  return q.length <= 2 ? q.join(' and ') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]!}`;
}

export function leaveWords(ask: LeaveAsk): { title: string; description: string } {
  const one = ask.names.length === 1;
  const what = one ? quoted(ask.names) : `${String(ask.names.length)} workspaces`;
  const quitting = ask.leaving === 'quit' ? ' before quitting' : '';
  return {
    title: `Save changes to ${what}${quitting}?`,
    description: one
      ? 'If you don’t save, your changes are lost.'
      : `${quoted(ask.names)}. If you don’t save, their changes are lost.`,
  };
}

export function recoveredWords(r: RecoveredWorkspaces): { title: string; description: string } {
  const one = r.names.length === 1;
  return {
    title: `Tessera closed before you saved ${one ? quoted(r.names) : `${String(r.names.length)} workspaces`}`,
    description: one ? 'Your unsaved changes are back.' : `${quoted(r.names)}. Your unsaved changes are back.`,
  };
}
