import type { AgentSessionSummary } from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';

export interface SessionGroup {
  label: string;
  sessions: AgentSessionSummary[];
}

const DAY = 86_400_000;

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupSessions(sessions: readonly AgentSessionSummary[], nowMs: number): SessionGroup[] {
  const today = dayStart(nowMs);
  const groups: SessionGroup[] = [
    { label: 'Today', sessions: [] },
    { label: 'Yesterday', sessions: [] },
    { label: 'Previous 7 days', sessions: [] },
    { label: 'Earlier', sessions: [] },
  ];
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    const at = normalizeEpochMs(s.updatedAt);
    const i = at >= today ? 0 : at >= today - DAY ? 1 : at >= today - 7 * DAY ? 2 : 3;
    groups[i]!.sessions.push(s);
  }
  return groups.filter((g) => g.sessions.length > 0);
}
