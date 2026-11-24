import type {
  AgentEventEnvelope,
  AgentSessionsEvent,
  AgentSessionSummary,
  Approval,
  ApprovalEvent,
  ProviderHealth,
} from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { currentSession, reduceSessions } from '../app/agentSessions.ts';
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from '../app/agentTranscript.ts';
import { dismissApproval, NO_APPROVALS, reduceApprovals, shownPending, type Approvals } from '../app/approvals.ts';
import { patch, read, makeStore, type Store, useStore } from '../app/store.ts';
import { createOverlay } from '../app/overlay.ts';

export interface AnalystState {
  sessions: AgentSessionSummary[] | null;
  approvals: Approval[] | null;
  expired: readonly Approval[];
  selected: string | null;
  fresh: boolean;
  transcript: { sessionId: string; t: Transcript } | null;
  providers: ProviderHealth[];
  healthKnown: boolean;
  sheet: boolean;
  unread: boolean;
  arrived: ReadonlySet<string>;
}

const LIVE_WINDOW_MS = 30_000;

export function isLive(tsMs: number, nowMs: number): boolean {
  return Number.isFinite(tsMs) && nowMs - tsMs < LIVE_WINDOW_MS;
}

function sortedSessions(map: ReadonlyMap<string, AgentSessionSummary>): AgentSessionSummary[] {
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export const EMPTY_ANALYST: AnalystState = {
  sessions: null,
  approvals: null,
  expired: [],
  selected: null,
  fresh: false,
  transcript: null,
  providers: [],
  healthKnown: false,
  sheet: false,
  unread: false,
  arrived: new Set(),
};

function makeAnalystStore(): Store<AnalystState> {
  return makeStore(EMPTY_ANALYST);
}

export const analystStore = makeAnalystStore();

export function useAnalyst<T>(selector: (s: AnalystState) => T): T {
  return useStore(analystStore, selector);
}

let sessionMap: ReadonlyMap<string, AgentSessionSummary> = new Map();
let approvalBook: Approvals = NO_APPROVALS;

const sessionEdits = createOverlay();
type SessionPart = 'title' | 'mode' | 'model';
const editKey = (id: string, part: SessionPart) => `${id}/${part}`;
const partOf = (s: AgentSessionSummary, part: SessionPart): unknown =>
  part === 'model' ? { model: s.model, effort: s.effort ?? null } : s[part];

function shownSessions(): AgentSessionSummary[] {
  return sortedSessions(
    new Map(
      [...sessionMap].map(([id, s]) => {
        const title = sessionEdits.shown(editKey(id, 'title'), s.title);
        const mode = sessionEdits.shown(editKey(id, 'mode'), s.mode);
        const m = sessionEdits.shown(editKey(id, 'model'), partOf(s, 'model')) as {
          model: string | null;
          effort: string | null;
        };
        const { effort: _effort, ...rest } = s;
        return [id, { ...rest, title, mode, model: m.model, ...(m.effort ? { effort: m.effort } : {}) }];
      }),
    ),
  );
}

export function applySessions(ev: AgentSessionsEvent): void {
  sessionMap = reduceSessions(sessionMap, ev);
  for (const [id, s] of sessionMap)
    for (const part of ['title', 'mode', 'model'] as const) sessionEdits.settle(editKey(id, part), partOf(s, part));
  patch(analystStore, { sessions: shownSessions() });
}

export async function editSession(
  id: string,
  part: SessionPart,
  value: unknown,
  send: () => Promise<unknown>,
): Promise<void> {
  const sent = sessionEdits.write(editKey(id, part), value, send);
  patch(analystStore, { sessions: shownSessions() });
  try {
    await sent;
  } finally {
    patch(analystStore, { sessions: shownSessions() });
  }
}

export function applyApprovals(ev: ApprovalEvent): void {
  approvalBook = reduceApprovals(approvalBook, ev);
  patch(analystStore, { approvals: shownPending(approvalBook), expired: approvalBook.expired });
}

export function resetApprovals(): void {
  approvalBook = { ...approvalBook, pending: new Map() };
  patch(analystStore, { approvals: null });
}

export function dismissDraft(id: string): void {
  approvalBook = dismissApproval(approvalBook, id);
  patch(analystStore, (s) => ({
    approvals: s.approvals === null ? null : shownPending(approvalBook),
    expired: approvalBook.expired,
  }));
}

export function beginTranscript(sessionId: string): void {
  if (read(analystStore).transcript?.sessionId !== sessionId)
    patch(analystStore, { transcript: { sessionId, t: EMPTY_TRANSCRIPT } });
}

export function applyEnvelope(env: AgentEventEnvelope, visible: boolean, nowMs: number): void {
  const cur = read(analystStore).transcript;
  const prev = cur?.sessionId === env.sessionId ? cur.t : EMPTY_TRANSCRIPT;
  const t = reduceTranscript(prev, env);
  if (t === prev) return;
  const ended = env.event.type === 'turn_finished' && !visible && isLive(normalizeEpochMs(env.ts), nowMs) ? true : null;
  patch(analystStore, { transcript: { sessionId: env.sessionId, t }, ...(ended ? { unread: true } : {}) });
}

export const setProviders = (providers: ProviderHealth[]) => patch(analystStore, { providers, healthKnown: true });
export const selectSession = (selected: string | null) => patch(analystStore, { selected, fresh: false, sheet: false });
export const newConversation = () => patch(analystStore, { selected: null, fresh: true, sheet: false });
export const setSheet = (sheet: boolean) => patch(analystStore, { sheet });

export function markSeen(): void {
  if (read(analystStore).unread) patch(analystStore, { unread: false });
}

export function markArrived(approvalId: string): void {
  const { arrived } = read(analystStore);
  if (arrived.has(approvalId)) return;
  patch(analystStore, { arrived: new Set([...arrived, approvalId]) });
}

export function selectCurrent(
  s: Pick<AnalystState, 'sessions' | 'selected'> & { fresh?: boolean },
): AgentSessionSummary | null {
  if (s.fresh) return null;
  return currentSession(s.sessions ?? [], s.selected);
}

export function useCurrentSession(): AgentSessionSummary | null {
  return useAnalyst(selectCurrent);
}

export function selectTranscript(
  s: Pick<AnalystState, 'sessions' | 'selected' | 'transcript'> & { fresh?: boolean },
): Transcript | null {
  const id = selectCurrent(s)?.id ?? null;
  return id !== null && s.transcript?.sessionId === id ? s.transcript.t : null;
}

export function useCurrentTranscript(): Transcript | null {
  return useAnalyst(selectTranscript);
}

const NONE_PENDING: Approval[] = [];

export function usePending(): Approval[] {
  return useAnalyst((s) => s.approvals ?? NONE_PENDING);
}

export function useExpired(): readonly Approval[] {
  return useAnalyst((s) => s.expired);
}

export function readyModels(providers: readonly ProviderHealth[]): string[] {
  return providers.filter((p) => p.kind === 'agent' && p.status === 'ok').map((p) => p.providerId);
}
