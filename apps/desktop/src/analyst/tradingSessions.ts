import type {
  AccountUpdate,
  JsonValue,
  SessionRunnerSetting,
  TradingDay,
  TradingSessionStatus,
} from '@tessera/protocol';
import { normalizeEpochMs } from '@tessera/protocol';
import { zonedFormat } from '../state/timeZone.ts';

export const SESSION_RUNNER_KEY = 'agent.sessionRunner';

export function readRunnerSetting(v: unknown): SessionRunnerSetting {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { enabled: false };
  const o = v as Record<string, unknown>;
  const text = (k: string) => {
    const x = o[k];
    return typeof x === 'string' ? x : undefined;
  };
  return {
    enabled: o.enabled === true,
    accountId: text('accountId'),
    provider: text('provider'),
    model: text('model'),
    effort: text('effort'),
    instructionsPath: text('instructionsPath'),
    issuesRepo: text('issuesRepo'),
    studyId: text('studyId'),
  };
}

export function runnerValue(s: SessionRunnerSetting, change: Partial<SessionRunnerSetting>): JsonValue {
  const next: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries({ ...s, ...change })) {
    if (typeof v === 'boolean') next[k] = v;
    else if (typeof v === 'string' && v.trim() !== '') next[k] = v.trim();
  }
  return next;
}

export function repoProblem(text: string): string | null {
  const t = text.trim();
  if (t === '' || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(t)) return null;
  return 'A repository as owner/name, or empty for none';
}

const DAY = zonedFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const CLOCK = zonedFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export function sessionClock(at: number): string {
  return CLOCK().format(normalizeEpochMs(at));
}

export function dateWords(date: string): string {
  return DAY('UTC')
    .format(new Date(`${date}T12:00:00Z`))
    .replace(',', '');
}

function current(st: TradingSessionStatus | undefined, now: number): TradingDay | null {
  const day = st?.day;
  if (!day) return null;
  if (day.phase === 'trading' || day.phase === 'closing') return day;
  return now < normalizeEpochMs(day.closesAt) ? day : null;
}

export function standingWords(st: TradingSessionStatus | undefined, now: number): string {
  if (!st) return '';
  const day = current(st, now);
  if (day) {
    switch (day.phase) {
      case 'trading': {
        const since = day.startedAt === null ? '' : ` since ${sessionClock(day.startedAt)}`;
        return `Trading${since} · the market breaks at ${sessionClock(day.closesAt)}`;
      }
      case 'closing':
        return 'Closing out and writing its log';
      case 'done':
        return 'This session is over: its report is in its conversation and the journal';
      case 'skipped':
        return `This session did not start: ${day.note ?? 'see its issue'}`;
    }
  }
  if (!st.setting.enabled) return 'Off';
  if (st.missing.length > 0) return `Not ready: ${st.missing.join('. ')}`;
  if (st.nextStart === null) return '';
  const next = normalizeEpochMs(st.nextStart);
  return next <= now
    ? 'Starts within seconds'
    : `Next session ${DAY().format(next).replace(',', '')} at ${sessionClock(next)}`;
}

export function sessionRunning(st: TradingSessionStatus | undefined, now: number): boolean {
  const phase = current(st, now)?.phase;
  return phase === 'trading' || phase === 'closing';
}

export function canStartNow(st: TradingSessionStatus | undefined, now: number): boolean {
  if (!st?.setting.enabled || st.missing.length > 0 || sessionRunning(st, now)) return false;
  return st.nextStart !== null && normalizeEpochMs(st.nextStart) <= now;
}

export function accountLabel(u: AccountUpdate): string {
  return `${u.account.displayName} · ${u.account.environment.toUpperCase()}`;
}
