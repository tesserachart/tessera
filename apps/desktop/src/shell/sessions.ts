import type { AgentSessionSummary } from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { zonedFormat } from '../state/timeZone.ts';

const GROUPS: { id: string; label: string; match: (s: AgentSessionSummary) => boolean }[] = [
  { id: 'needs', label: 'Needs you', match: (s) => s.status === 'needs_you' },
  { id: 'running', label: 'Running', match: (s) => s.status === 'running' },
  { id: 'recent', label: 'Recent', match: () => true },
];

export function groupSessions(
  sessions: readonly AgentSessionSummary[],
): { id: string; label: string; sessions: AgentSessionSummary[] }[] {
  const seen = new Set<string>();
  return GROUPS.map((g) => {
    const list = sessions.filter((s) => !seen.has(s.id) && g.match(s));
    for (const s of list) seen.add(s.id);
    return { id: g.id, label: g.label, sessions: list };
  }).filter((g) => g.sessions.length > 0);
}

export function orderSessions(sessions: readonly AgentSessionSummary[]): AgentSessionSummary[] {
  return groupSessions(sessions).flatMap((g) => g.sessions);
}

const dayFmt = zonedFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = zonedFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekdayFmt = zonedFormat('en-US', { weekday: 'short' });
const dateFmt = zonedFormat('en-US', { day: 'numeric', month: 'short' });

function shortDate(at: number): string {
  const p = Object.fromEntries(
    dateFmt()
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day ?? ''} ${p.month ?? ''}`;
}

export function relTime(ts: number, nowMs: number): string {
  if (!Number.isFinite(ts)) return '';
  const at = normalizeEpochMs(ts);
  const d = Math.max(0, nowMs - at);
  if (d < 60_000) return 'now';
  if (dayFmt().format(at) === dayFmt().format(nowMs)) return timeFmt().format(at);
  if (d < 6 * 86_400_000) return weekdayFmt().format(at);
  return shortDate(at);
}
