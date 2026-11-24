import type { AgentSessionsEvent, AgentSessionSummary } from '@tessera/protocol';

export function reduceSessions(
  prev: ReadonlyMap<string, AgentSessionSummary>,
  ev: AgentSessionsEvent,
): Map<string, AgentSessionSummary> {
  if (ev.type === 'snapshot') return new Map(ev.sessions.map((s) => [s.id, s]));
  const next = new Map(prev);
  if (ev.type === 'upsert') next.set(ev.session.id, ev.session);
  else next.delete(ev.sessionId);
  return next;
}

function needsYou(s: AgentSessionSummary): boolean {
  return s.status === 'needs_you';
}

export function currentSession(
  sessions: readonly AgentSessionSummary[],
  selected: string | null = null,
): AgentSessionSummary | null {
  return (
    (selected ? sessions.find((s) => s.id === selected) : undefined) ??
    sessions.find(needsYou) ??
    sessions.find((s) => s.status === 'running') ??
    sessions.find((s) => s.status === 'idle') ??
    sessions[0] ??
    null
  );
}
