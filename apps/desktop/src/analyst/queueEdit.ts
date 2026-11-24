import type { QueuedMessage } from '@tessera/protocol';

export interface QueuedEdit {
  sessionId: string;
  queuedId: string;
  original: string;
  setAside: string;
}

export type EditEnd = 'clean' | 'kept' | 'discarded';

export function beginEdit(
  current: QueuedEdit | null,
  sessionId: string,
  item: QueuedMessage,
  draft: string,
): QueuedEdit {
  return { sessionId, queuedId: item.id, original: item.text, setAside: current ? current.setAside : draft };
}

export function stillQueued(edit: QueuedEdit, sessionId: string | null, queue: readonly QueuedMessage[]): boolean {
  return edit.sessionId === sessionId && queue.some((q) => q.id === edit.queuedId);
}

export function endWithoutSave(edit: QueuedEdit, draft: string): { draft: string; end: EditEnd } {
  const dirty = draft.trim() !== edit.original.trim();
  if (!dirty) return { draft: edit.setAside, end: 'clean' };
  if (!edit.setAside.trim()) return { draft, end: 'kept' };
  return { draft: edit.setAside, end: 'discarded' };
}
