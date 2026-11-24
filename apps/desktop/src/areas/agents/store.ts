import type { SessionMode } from '@tessera/protocol';
import { z } from 'zod';
import { patch, makeStore, useStore } from '../../app/store.ts';
import type { QueuedEdit } from '../../analyst/queueEdit.ts';
import type { ModelPick } from './models.ts';

interface AgentsUiState {
  pick: ModelPick | null;
  nextMode: SessionMode | null;
  open: Readonly<Record<string, readonly string[]>>;
  editing: QueuedEdit | null;
}

const ModelPickSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
});

export const agentsUiStore = makeStore<AgentsUiState>(
  { pick: null, nextMode: null, open: {}, editing: null },
  {
    persist: {
      key: 'tessera.agents',
      version: 1,
      fields: { pick: ModelPickSchema.nullable() },
    },
  },
);

export function useAgentsUi<T>(select: (s: AgentsUiState) => T): T {
  return useStore(agentsUiStore, select);
}

export const setPick = (pick: ModelPick) => patch(agentsUiStore, { pick });
export const setNextMode = (nextMode: SessionMode | null) => patch(agentsUiStore, { nextMode });
export const setQueuedEdit = (editing: QueuedEdit | null) => patch(agentsUiStore, { editing });

export function toggleOpenRow(sessionId: string, key: string): void {
  patch(agentsUiStore, (s) => {
    const cur = s.open[sessionId] ?? [];
    const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
    return { open: { ...s.open, [sessionId]: next } };
  });
}

const NONE: readonly string[] = [];

export function useOpenRows(sessionId: string | null): readonly string[] {
  return useAgentsUi((s) => (sessionId ? (s.open[sessionId] ?? NONE) : NONE));
}
