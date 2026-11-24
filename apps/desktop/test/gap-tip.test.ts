import { afterEach, describe, expect, it } from 'vitest';
import { gapTipWords } from '../src/chart/gapTip.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';

describe('the gap strip tip', () => {
  afterEach(() => putRuntimeSettings({ 'display.timeZone': null }, false));

  it('says in plain words which time has no trade history, in the desk time zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'America/New_York' }, false);
    const from = Date.parse('2026-10-02T10:00:00-04:00');
    expect(gapTipWords(from, from + 3 * 60_000)).toBe('No trade history 10:00–10:03');
  });
});
