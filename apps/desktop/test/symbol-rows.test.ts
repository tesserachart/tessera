import { describe, expect, it } from 'vitest';
import { symbolRowName } from '../src/market/search.ts';

describe('symbol rows', () => {
  it('shows a catalog name only when it says more than the symbol', () => {
    expect(symbolRowName({ symbol: 'NQ Z6', instrument: 'NQZ6.CME', catalog: 'E-mini Nasdaq-100 Dec 2026' })).toBe(
      'E-mini Nasdaq-100 Dec 2026',
    );
    expect(symbolRowName({ symbol: 'NQ', instrument: 'NQ', catalog: 'NQ' })).toBe('');
    expect(symbolRowName({ symbol: 'NQ Z6', instrument: 'NQZ6.CME', catalog: 'NQZ6.CME' })).toBe('');
  });
});
