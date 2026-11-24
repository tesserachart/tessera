import type { ChartState, SessionsOutput } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { chartSession, hasRegularHours, hoursOf, hoursSpan, tradingNow, withHours } from '../src/chart/hours.ts';
import { profileHours, profileOptions } from '../src/chart/layers/orderflow/volumeProfile.ts';
import { resolveIndicator } from '../src/chart/indicators.ts';
import { INDICATOR_SPECS } from '@tessera/protocol';
import { ns } from './support/time.ts';

const ny = (at: string) => Date.parse(`2026-10-02T${at}:00-04:00`);

const ES: SessionsOutput = {
  instrument: 'ESZ6.CME',
  hours: {
    calendar: 'cme_equity_index',
    market: 'CME equity index',
    tz: 'America/New_York',
    days: 'Sun–Fri',
    opens: '18:00',
    opensDayBefore: true,
    closes: '17:00',
    rth: { start: '09:30', end: '16:00' },
  },
  sessions: [
    {
      calendar: 'cme_equity_index',
      tradeDate: '2026-10-02',
      open: ns(Date.parse('2026-10-01T18:00:00-04:00')),
      close: ns(ny('17:00')),
      segments: [{ start: ns(Date.parse('2026-10-01T18:00:00-04:00')), end: ns(ny('17:00')) }],
      rth: { start: ns(ny('09:30')), end: ns(ny('16:00')) },
      earlyClose: false,
    },
  ],
  holidays: [],
};

const BTC: SessionsOutput = {
  ...ES,
  instrument: 'BTC-USD',
  hours: { ...ES.hours, calendar: 'crypto24x7', rth: null },
  sessions: ES.sessions.map((s) => ({ ...s, rth: null })),
};

describe('a chart’s hours', () => {
  it('are every hour until set, and setting them back to every hour leaves no trace', () => {
    expect(hoursOf(null)).toBe('eth');
    expect(hoursOf({})).toBe('eth');
    const es: Pick<ChartState, 'instrument' | 'hours'> = { instrument: 'ES' };
    const rth = withHours(es, 'rth');
    expect(rth).toEqual({ instrument: 'ES', hours: 'rth' });
    expect(withHours(rth, 'eth')).toEqual({ instrument: 'ES' });
  });

  it('show regular hours only on a market that has them, asked at once before its hours are known', () => {
    expect(chartSession('eth', ES)).toBe('all');
    expect(chartSession('rth', ES)).toBe('rth');
    expect(chartSession('rth', null), 'not known yet: regular hours, so the chart is read once').toBe('rth');
    expect(chartSession('rth', BTC), 'a market with no regular hours shows all of them').toBe('all');
    expect(hasRegularHours(BTC)).toBe(false);
    expect(hasRegularHours(null)).toBeNull();
  });

  it('say when each choice trades and whether it trades now', () => {
    expect(hoursSpan(ES.hours, 'rth', ny('12:00'))).toMatch(/^09:30–16:00 /);
    expect(hoursSpan(ES.hours, 'eth', ny('12:00'))).toMatch(/^18:00–17:00 /);
    expect(hoursSpan(BTC.hours, 'rth', ny('12:00'))).toBeNull();
    expect(tradingNow(ES, 'rth', ny('12:00'))).toBe(true);
    expect(tradingNow(ES, 'rth', ny('08:00'))).toBe(false);
    expect(tradingNow(ES, 'eth', ny('08:00'))).toBe(true);
    expect(tradingNow(ES, 'eth', ny('17:30'))).toBe(false);
  });
});

describe('a volume profile on a chart', () => {
  const spec = INDICATOR_SPECS.find((s) => s.kind === 'volume_profile')!;

  it('follows the chart’s hours unless it sets its own', () => {
    expect(resolveIndicator(spec, {}).inputs.hours, 'a new profile takes the chart’s').toBe('chart');
    expect(profileHours('chart', 'rth')).toBe('rth');
    expect(profileHours('chart', 'all')).toBe('all');
    expect(profileHours('chart')).toBe('all');
    for (const own of ['all', 'rth', 'split'] as const) {
      expect(profileHours(own, 'rth'), `its own ${own} wins`).toBe(own);
      expect(profileHours(own, 'all')).toBe(own);
    }
  });

  it('names the chart’s hours beside the choice that follows them', () => {
    const settings = resolveIndicator(spec, {});
    expect(profileOptions(settings, 'rth').notes).toEqual({ 'hours.chart': 'RTH' });
    expect(profileOptions(settings, 'all').notes).toEqual({ 'hours.chart': 'ETH' });
  });
});
