import type { SessionHours, SessionsOutput, TradingSession } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { closedNote, hoursRows, marketSession, sessionsInput } from '../src/markets/sessions.ts';
import { nsAt } from './support/time.ts';

const at = (iso: string) => Date.parse(iso);

function session(
  calendar: TradingSession['calendar'],
  tradeDate: string,
  segments: [string, string][],
  rth: [string, string] | null,
  earlyClose = false,
): TradingSession {
  const windows = segments.map(([start, end]) => ({ start: nsAt(start), end: nsAt(end) }));
  return {
    calendar,
    tradeDate,
    open: windows[0]!.start,
    close: windows.at(-1)!.end,
    segments: windows,
    rth: rth ? { start: nsAt(rth[0]), end: nsAt(rth[1]) } : null,
    earlyClose,
  };
}

const globex = (calendar: SessionHours['calendar'], market: string, rth: [string, string] | null): SessionHours => ({
  calendar,
  market,
  tz: 'America/New_York',
  days: 'Sun–Fri',
  opens: '18:00',
  opensDayBefore: true,
  closes: '17:00',
  rth: rth ? { start: rth[0], end: rth[1] } : null,
});

const crude: SessionsOutput = {
  instrument: 'CLX6.NYMEX-RITHMIC',
  hours: globex('cme_energy', 'NYMEX energy', ['09:00', '14:30']),
  sessions: (
    [
      ['2026-10-01', '2026-09-30T18:00:00-04:00', '2026-10-01T17:00:00-04:00'],
      ['2026-10-02', '2026-10-01T18:00:00-04:00', '2026-10-02T17:00:00-04:00'],
      ['2026-10-05', '2026-10-04T18:00:00-04:00', '2026-10-05T17:00:00-04:00'],
    ] as const
  ).map(([d, open, close]) =>
    session('cme_energy', d, [[open, close]], [`${d}T09:00:00-04:00`, `${d}T14:30:00-04:00`]),
  ),
  holidays: [],
};

const thanksgiving: SessionsOutput = {
  instrument: 'NQZ6.CME-RITHMIC',
  hours: globex('cme_equity_index', 'CME equity index', ['09:30', '16:00']),
  sessions: [
    session(
      'cme_equity_index',
      '2026-11-25',
      [['2026-11-24T18:00:00-05:00', '2026-11-25T17:00:00-05:00']],
      ['2026-11-25T09:30:00-05:00', '2026-11-25T16:00:00-05:00'],
    ),
    session(
      'cme_equity_index',
      '2026-11-27',
      [
        ['2026-11-25T18:00:00-05:00', '2026-11-26T13:00:00-05:00'],
        ['2026-11-26T18:00:00-05:00', '2026-11-27T13:15:00-05:00'],
      ],
      ['2026-11-27T09:30:00-05:00', '2026-11-27T13:00:00-05:00'],
      true,
    ),
  ],
  holidays: [{ date: '2026-11-26', name: 'Thanksgiving Day', halt: nsAt('2026-11-26T13:00:00-05:00') }],
};

const qqq: SessionsOutput = {
  instrument: 'QQQ.NASDAQ',
  hours: {
    calendar: 'us_equities',
    market: 'US equities',
    tz: 'America/New_York',
    days: 'Mon–Fri',
    opens: '04:00',
    opensDayBefore: false,
    closes: '20:00',
    rth: { start: '09:30', end: '16:00' },
  },
  sessions: [
    session(
      'us_equities',
      '2026-10-02',
      [['2026-10-02T04:00:00-04:00', '2026-10-02T20:00:00-04:00']],
      ['2026-10-02T09:30:00-04:00', '2026-10-02T16:00:00-04:00'],
    ),
  ],
  holidays: [],
};

describe('market sessions from the runtime calendar', () => {
  it('tells a CME product the phase of its own regular session', () => {
    expect(marketSession(at('2026-10-02T10:00:00-04:00'), crude)).toEqual({
      label: 'Regular',
      open: true,
      closesInMs: 4.5 * 3_600_000,
      holiday: null,
    });
    expect(marketSession(at('2026-10-02T15:00:00-04:00'), crude).label).toBe('After hours');
    expect(marketSession(at('2026-10-01T22:00:00-04:00'), crude).label).toBe('Overnight');
    expect(marketSession(at('2026-10-01T17:30:00-04:00'), crude)).toMatchObject({ label: 'Daily halt', open: false });
    expect(marketSession(at('2026-10-02T17:30:00-04:00'), crude)).toMatchObject({ label: 'Closed', open: false });
    expect(marketSession(at('2026-10-04T19:00:00-04:00'), crude).label).toBe('Overnight');
  });

  it('reads a holiday from the calendar: holiday hours until the halt, then closed', () => {
    expect(marketSession(at('2026-11-26T10:00:00-05:00'), thanksgiving)).toEqual({
      label: 'Holiday hours',
      open: true,
      closesInMs: null,
      holiday: 'Thanksgiving Day',
    });
    expect(marketSession(at('2026-11-26T14:00:00-05:00'), thanksgiving)).toMatchObject({
      label: 'Closed',
      open: false,
      holiday: 'Thanksgiving Day',
    });
    expect(marketSession(at('2026-11-27T12:00:00-05:00'), thanksgiving)).toMatchObject({
      label: 'Regular',
      closesInMs: 3_600_000,
    });
  });

  it('keeps pre-market and after hours for US equities', () => {
    expect(marketSession(at('2026-10-02T08:00:00-04:00'), qqq).label).toBe('Pre-market');
    expect(marketSession(at('2026-10-02T17:00:00-04:00'), qqq).label).toBe('After hours');
    expect(marketSession(at('2026-10-02T21:00:00-04:00'), qqq)).toMatchObject({ label: 'Closed', open: false });
    expect(marketSession(at('2026-10-03T12:00:00-04:00'), qqq).open).toBe(false);
    const btc = { ...qqq, hours: { ...qqq.hours, calendar: 'crypto24x7' as const } };
    expect(marketSession(at('2026-10-03T12:00:00-04:00'), btc)).toMatchObject({ label: 'Open 24/7', open: true });
  });

  it('describes the hours of each calendar', () => {
    expect(hoursRows(crude.hours)).toEqual([
      { label: 'Hours', value: 'Sun–Fri 18:00–17:00 ET' },
      { label: 'Regular hours', value: '09:00–14:30 ET' },
    ]);
    expect(hoursRows(globex('cme_globex', 'CME Globex', null))[1]).toEqual({
      label: 'Regular hours',
      value: 'None known',
    });
    expect(hoursRows(qqq.hours)).toEqual([
      { label: 'Hours', value: 'Mon–Fri 04:00–20:00 ET' },
      { label: 'Regular hours', value: '09:30–16:00 ET' },
    ]);
    expect(hoursRows({ ...qqq.hours, calendar: 'crypto24x7' })).toEqual([
      { label: 'Hours', value: 'Around the clock, every day' },
    ]);
  });

  it('asks for the trade dates around the day it is, far enough ahead to reach the next open after a long holiday', () => {
    expect(sessionsInput('CLX6', at('2026-10-02T14:42:00-04:00'))).toEqual({
      instrument: 'CLX6',
      from: '2026-09-29',
      to: '2026-10-09',
    });
  });

  it('says when a closed market opens again, in the exchange’s time, and nothing while it trades', () => {
    expect(closedNote(at('2026-10-03T12:00:00-04:00'), crude)).toBe('Closed · opens Sun 18:00 ET');
    expect(closedNote(at('2026-10-04T12:00:00-04:00'), crude)).toBe('Closed · opens 18:00 ET');
    expect(closedNote(at('2026-10-01T17:30:00-04:00'), crude)).toBe('Daily halt · opens 18:00 ET');
    expect(closedNote(at('2026-10-02T10:00:00-04:00'), crude)).toBeNull();
    expect(closedNote(at('2026-10-04T19:00:00-04:00'), crude)).toBeNull();
    expect(closedNote(at('2026-11-26T14:00:00-05:00'), thanksgiving)).toBe('Thanksgiving Day · opens 18:00 ET');
    expect(closedNote(at('2026-11-27T14:00:00-05:00'), thanksgiving)).toBe('Closed');
    const btc = { ...qqq, hours: { ...qqq.hours, calendar: 'crypto24x7' as const } };
    expect(closedNote(at('2026-10-03T12:00:00-04:00'), btc)).toBeNull();
  });
});
