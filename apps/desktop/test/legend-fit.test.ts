import { describe, expect, it } from 'vitest';
import { firstFit, fitted, FIT_STEPS } from '../src/chart/settings/legendFit.ts';

const loading = { text: 'Loading · 0 of 1 session', short: 'Loading 0/1', least: 'Loading…' };

describe('a legend row with no room drops its extras before its loading words', () => {
  it('drops the ratio and row size first, then shortens the loading words, never dropping them', () => {
    expect(fitted('4 ticks', loading, 0)).toEqual({
      tight: false,
      least: false,
      suffix: '4 ticks',
      notice: loading.text,
    });
    expect(fitted('4 ticks', loading, 1)).toEqual({ tight: true, least: false, suffix: '', notice: loading.text });
    expect(fitted('4 ticks', loading, 2)).toEqual({ tight: true, least: false, suffix: '', notice: 'Loading 0/1' });
    expect(fitted('4 ticks', loading, 3)).toEqual({ tight: true, least: true, suffix: '', notice: 'Loading…' });
    expect(fitted('', null, 3).notice).toBe('');
  });

  it('takes the first step that fits, and the shortest when none does', () => {
    expect(firstFit(() => true)).toBe(0);
    expect(firstFit((step) => step >= 2)).toBe(2);
    expect(firstFit(() => false)).toBe(FIT_STEPS - 1);
  });
});
