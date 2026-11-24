import { describe, expect, it } from 'vitest';
import { parseTimeframe, TIMEFRAME_PRESETS, timeframeWords } from '../src/timeframe.ts';
import { Timeframe } from '../src/schemas.gen.ts';
import { timeframeMs } from '../src/time.ts';

describe('timeframes', () => {
  it('reads any count of seconds, minutes, hours or sessions the way the runtime does', () => {
    const cases: [string, string][] = [
      ['2s', '2s'],
      ['45 sec', '45s'],
      ['7m', '7m'],
      ['13 minutes', '13m'],
      ['90m', '90m'],
      ['2h', '2h'],
      ['3 Hours', '3h'],
      ['2d', '2D'],
      ['5 days', '5D'],
      ['D', '1D'],
      ['1S', '1s'],
      ['4H', '4h'],
      ['15', '15m'],
      ['60s', '1m'],
      ['120s', '2m'],
      ['60m', '1h'],
      ['240m', '4h'],
      ['24h', '24h'],
    ];
    for (const [text, wire] of cases) expect(parseTimeframe(text), text).toBe(wire);
  });

  it('refuses nonsense and intervals out of range', () => {
    for (const bad of ['', '0m', 'abc', '5x', '1.5m', '-1m', '25h', '86401s', '366D', '1W', 'm5']) {
      expect(parseTimeframe(bad), bad).toBeNull();
    }
  });

  it('offers 15s and 30s among the presets, every one valid on the wire', () => {
    expect(TIMEFRAME_PRESETS).toContain('15s');
    expect(TIMEFRAME_PRESETS).toContain('30s');
    for (const tf of TIMEFRAME_PRESETS) {
      expect(Timeframe.parse(tf)).toBe(tf);
      expect(parseTimeframe(tf)).toBe(tf);
    }
    expect(Timeframe.safeParse('1W').success).toBe(false);
    expect(Timeframe.safeParse(15).success).toBe(false);
  });

  it('names and measures any timeframe', () => {
    expect(timeframeWords('90m')).toBe('90 minutes');
    expect(timeframeWords('1D')).toBe('1 day');
    expect(timeframeWords('15s')).toBe('15 seconds');
    expect(timeframeMs('15s')).toBe(15_000);
    expect(timeframeMs('2D')).toBe(2 * 86_400_000);
  });
});
