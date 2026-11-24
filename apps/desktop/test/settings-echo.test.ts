import { describe, expect, it } from 'vitest';
import { rustStrings } from './support/rust.ts';
import { MERGED_KEYS, unchangedSetting } from '../src/state/settingsSync.ts';
import { stableStringify } from '../src/workspace/layouts.ts';

const mine = { favouriteIntervals: ['1m', '5m'], defaultChartType: 'candles', recentSymbols: ['NQZ6.CME'] };

describe('a window writes a setting back only when it changed', () => {
  it('a merged key holding fields an older build stored is unchanged when the window’s own fields match', () => {
    const stored = stableStringify({ ...mine, watchlist: ['QQQ'], marketList: 'watchlist' });
    expect(unchangedSetting('ui.preferences', mine, stored)).toBe(true);
  });

  it('a merged key is changed when one of the window’s own fields differs or is missing', () => {
    expect(unchangedSetting('ui.preferences', mine, stableStringify({ ...mine, defaultChartType: 'bars' }))).toBe(
      false,
    );
    const { recentSymbols: _gone, ...without } = mine;
    expect(unchangedSetting('ui.preferences', mine, stableStringify(without))).toBe(false);
  });

  it('a key the runtime replaces whole compares whole', () => {
    expect(unchangedSetting('ui.view', { a: 1 }, stableStringify({ a: 1, b: 2 }))).toBe(false);
    expect(unchangedSetting('ui.view', { a: 1 }, stableStringify({ a: 1 }))).toBe(true);
  });

  it('a key not loaded yet is never unchanged', () => {
    expect(unchangedSetting('ui.preferences', mine, undefined)).toBe(false);
  });
});

describe('the keys a window merges', () => {
  it('are the keys the runtime merges field by field', () => {
    expect([...MERGED_KEYS].sort()).toEqual(rustStrings('tessera-runtime/src/settings.rs', 'MERGED').sort());
  });
});
