import type { QueuedMessage } from '@tessera/protocol';
import type { QueueView } from '../../src/areas/agents/useChat.ts';

export function queueView(items: readonly QueuedMessage[] = [], over: Partial<QueueView> = {}): QueueView {
  return {
    items,
    held: false,
    editing: null,
    edit: () => undefined,
    cancelEdit: () => undefined,
    remove: () => undefined,
    resume: () => undefined,
    ...over,
  };
}
