import type {
  ChartHours,
  ChartState,
  SessionFilter,
  SessionHours,
  SessionsOutput,
  SessionWindow,
} from '@tessera/protocol';
import { useClock } from '../app/clock.ts';
import { useMarketSessions } from '../markets/sessions.ts';
import { zoneAbbreviation } from '../state/timeZone.ts';

export const HOURS_SHORT: Readonly<Record<ChartHours, string>> = { rth: 'RTH', eth: 'ETH' };

export const HOURS_WORDS: Readonly<Record<ChartHours, string>> = {
  rth: 'Regular hours',
  eth: 'Extended hours',
};

export function hoursOf(chart: Pick<ChartState, 'hours'> | null | undefined): ChartHours {
  return chart?.hours ?? 'eth';
}

export function withHours<C extends Pick<ChartState, 'hours'>>(chart: C, hours: ChartHours): C {
  const { hours: _held, ...rest } = chart;
  return (hours === 'eth' ? rest : { ...rest, hours }) as C;
}

export function hasRegularHours(sessions: SessionsOutput | null): boolean | null {
  return sessions ? sessions.hours.rth !== null : null;
}

export function chartSession(hours: ChartHours, sessions: SessionsOutput | null): SessionFilter {
  return hours === 'rth' && hasRegularHours(sessions) !== false ? 'rth' : 'all';
}

export function useChartSession(instrument: string | null, hours: ChartHours): SessionFilter {
  const clock = useClock();
  const sessions = useMarketSessions(hours === 'rth' ? instrument : null, clock.now());
  return chartSession(hours, sessions);
}

export function hoursSpan(h: SessionHours, hours: ChartHours, atMs: number): string | null {
  const zone = zoneAbbreviation(h.tz, atMs, 'shortGeneric');
  if (hours === 'eth') return `${h.opens}–${h.closes} ${zone}`;
  return h.rth ? `${h.rth.start}–${h.rth.end} ${zone}` : null;
}

export function tradingNow(data: SessionsOutput, hours: ChartHours, nowMs: number): boolean {
  const now = nowMs * 1_000_000;
  const inside = (w: SessionWindow | null) => w !== null && now >= w.start && now < w.end;
  return data.sessions.some((s) => (hours === 'rth' ? inside(s.rth) : s.segments.some(inside)));
}
