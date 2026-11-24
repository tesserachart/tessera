import type { EarlierBars, ListReplayDaysOutput, ReplayState } from '@tessera/protocol';
import { displayZone } from '../../state/timeZone.ts';

export const REPLAY_SPEEDS = [1, 2, 5, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

export function cursorMs(state: ReplayState, receivedAt: number, now: number): number {
  const at = state.cursor / 1e6;
  const ran = state.playing ? Math.max(0, now - receivedAt) * state.speed : 0;
  return Math.min(state.to / 1e6, at + ran);
}

export function hasEnded(state: ReplayState, receivedAt: number, now: number): boolean {
  return cursorMs(state, receivedAt, now) >= state.to / 1e6;
}

function formatter(options: Intl.DateTimeFormatOptions, tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: tz });
}

export function clockText(ms: number, tz: string = displayZone()): string {
  return formatter({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, tz).format(ms);
}

export function earlierText(earlier: EarlierBars, tz: string = displayZone()): string | null {
  switch (earlier.kind) {
    case 'whole':
      return null;
    case 'missing':
      return 'No saved bars before the replay';
    case 'gap': {
      const when = formatter(
        { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
        tz,
      );
      return `No saved bars from ${when.format(earlier.from / 1e6)} to ${when.format(earlier.to / 1e6)}`;
    }
  }
}

export function dayText(tradeDate: string): string {
  const [y, m, d] = tradeDate.split('-').map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d));
  return formatter({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, 'UTC').format(day);
}

function wallParts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = formatter(
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
    tz,
  ).formatToParts(ms);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour'), mi: n('minute'), s: n('second') };
}

function offsetAt(ms: number, tz: string): number {
  const w = wallParts(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

const TIME_OF_DAY = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/;

export function jumpTarget(state: ReplayState, text: string, tz: string = displayZone()): number | null {
  const m = TIME_OF_DAY.exec(text);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const from = state.from / 1e6;
  const to = state.to / 1e6;
  for (const edge of [from, to - 1]) {
    const w = wallParts(edge, tz);
    const at = Date.UTC(w.y, w.mo - 1, w.d, h, mi, s) - offsetAt(edge, tz);
    if (at >= from && at < to) return at * 1e6;
  }
  return null;
}

export interface DayChoice {
  readonly key: string;
  readonly instrument: string;
  readonly source: string;
  readonly tradeDate: string;
  readonly prints: number;
}

export function dayChoices(out: ListReplayDaysOutput, charted: string | null): DayChoice[] {
  const days = out.contracts.flatMap((c) =>
    c.days.map((d) => ({
      key: `${c.source}/${c.instrument}/${d.tradeDate}`,
      instrument: c.instrument,
      source: c.source,
      tradeDate: d.tradeDate,
      prints: d.prints,
    })),
  );
  const own = (d: DayChoice) => (d.instrument === charted ? 0 : 1);
  return days.sort(
    (a, b) => own(a) - own(b) || a.instrument.localeCompare(b.instrument) || b.tradeDate.localeCompare(a.tradeDate),
  );
}

export function speedOf(n: number): ReplaySpeed {
  return REPLAY_SPEEDS.find((s) => s === n) ?? 1;
}
