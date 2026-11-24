import type { SessionHours, SessionsOutput, SessionWindow } from '@tessera/protocol';
import { useCallback, useSyncExternalStore } from 'react';
import { useClock } from '../app/clock.ts';
import { useHasTool, useToolValue } from '../app/tools.ts';
import { zoneAbbreviation } from '../state/timeZone.ts';

export interface MarketSession {
  label: string;
  open: boolean;
  closesInMs: number | null;
  holiday: string | null;
}

const NS_PER_MS = 1_000_000;
const DAY_MS = 86_400_000;
const DAYS_BACK = 3;
const DAYS_AHEAD = 7;
const LONGEST_DAILY_HALT_MS = 2 * 3_600_000;

const dateIn = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function sessionsInput(instrument: string, nowMs: number): { instrument: string; from: string; to: string } {
  return { instrument, from: utcDate(nowMs - DAYS_BACK * DAY_MS), to: utcDate(nowMs + DAYS_AHEAD * DAY_MS) };
}

export function marketSession(nowMs: number, data: SessionsOutput): MarketSession {
  const { hours, sessions, holidays } = data;
  if (hours.calendar === 'crypto24x7') return { label: 'Open 24/7', open: true, closesInMs: null, holiday: null };
  const now = nowMs * NS_PER_MS;
  const inside = (w: SessionWindow) => now >= w.start && now < w.end;
  const today = dateIn(hours.tz).format(nowMs);
  const holiday = holidays.find((h) => h.date === today)?.name ?? null;
  for (const s of sessions) {
    if (s.rth && inside(s.rth)) {
      return { label: 'Regular', open: true, closesInMs: (s.rth.end - now) / NS_PER_MS, holiday };
    }
    if (!s.segments.some(inside)) continue;
    if (holiday) return { label: 'Holiday hours', open: true, closesInMs: null, holiday };
    const beforeRth = s.rth !== null && now < s.rth.start;
    const label = !s.rth ? 'Open' : beforeRth ? (hours.opensDayBefore ? 'Overnight' : 'Pre-market') : 'After hours';
    return { label, open: true, closesInMs: null, holiday };
  }
  const before = sessions.filter((s) => s.close <= now).at(-1);
  const after = sessions.find((s) => s.open > now);
  const halt =
    !holiday && before && after && (after.open - before.close) / NS_PER_MS <= LONGEST_DAILY_HALT_MS
      ? 'Daily halt'
      : null;
  return { label: halt ?? 'Closed', open: false, closesInMs: null, holiday };
}

function nextOpenMs(nowMs: number, data: SessionsOutput): number | null {
  const now = nowMs * NS_PER_MS;
  const starts = data.sessions.flatMap((s) => s.segments.map((w) => w.start)).filter((t) => t > now);
  return starts.length > 0 ? Math.min(...starts) / NS_PER_MS : null;
}

function openingWords(atMs: number, nowMs: number, tz: string): string {
  const day = dateIn(tz);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const when =
    day.format(atMs) === day.format(nowMs) ? time.format(atMs) : `${weekday.format(atMs)} ${time.format(atMs)}`;
  return `${when} ${zoneAbbreviation(tz, atMs, 'shortGeneric')}`;
}

export function closedNote(nowMs: number, data: SessionsOutput): string | null {
  const session = marketSession(nowMs, data);
  if (session.open) return null;
  const why = session.holiday ?? session.label;
  const opens = nextOpenMs(nowMs, data);
  return opens === null ? why : `${why} · opens ${openingWords(opens, nowMs, data.hours.tz)}`;
}

function zoneWords(tz: string): string {
  return zoneAbbreviation(tz, Date.now(), 'shortGeneric');
}

export function hoursRows(h: SessionHours): { label: string; value: string }[] {
  if (h.calendar === 'crypto24x7') return [{ label: 'Hours', value: 'Around the clock, every day' }];
  const zone = zoneWords(h.tz);
  return [
    { label: 'Hours', value: `${h.days} ${h.opens}–${h.closes} ${zone}` },
    { label: 'Regular hours', value: h.rth ? `${h.rth.start}–${h.rth.end} ${zone}` : 'None known' },
  ];
}

const SESSIONS_KEPT = { keepFor: DAY_MS };

export function useMarketSessions(instrument: string | null, nowMs: number): SessionsOutput | null {
  const has = useHasTool('market.get_sessions');
  const input = has && instrument ? sessionsInput(instrument, nowMs) : null;
  return useToolValue('market.get_sessions', input, SESSIONS_KEPT) ?? null;
}

export function useClosedNote(instrument: string | null): string | null {
  const clock = useClock();
  const data = useMarketSessions(instrument, clock.now());
  const note = useCallback(() => (data ? closedNote(clock.now(), data) : null), [clock, data]);
  return useSyncExternalStore(clock.subscribe, note);
}
