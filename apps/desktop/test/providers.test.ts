import type { LevelSourceInfo, SeriesCoverageInfo } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  ADD_WITH_ANALYST,
  backfillRange,
  backfillSpans,
  backfillWords,
  nyDate,
  providerPackageKeys,
  requestWords,
  storedWords,
} from '../src/accounts/providers.ts';

const source = (over: Partial<LevelSourceInfo>): LevelSourceInfo => ({
  providerId: 'acme',
  displayName: 'Acme levels',
  vendor: 'Acme',
  packages: [{ key: 'acme.levels', vendor: 'Acme', package: 'Levels', levels: [], open: false }],
  instruments: ['NQ'],
  schedule: 'Every 5 min, US market hours',
  callsToday: [],
  spec: null,
  editable: true,
  sendsSecret: true,
  history: null,
  health: null as never,
  ...over,
});

const series = (vendor: string, instrument: string, firstDate: string, lastDate: string) =>
  ({ vendor, instrument, firstDate, lastDate }) as SeriesCoverageInfo;

describe('providers of levels', () => {
  it('knows which packages the providers’ sections draw', () => {
    const zeta = source({
      providerId: 'zeta',
      vendor: 'Zeta',
      packages: [
        { key: 'zeta.classic', vendor: 'Zeta', package: 'Classic', levels: [], open: false },
        { key: 'zeta.state', vendor: 'Zeta', package: 'State', levels: [], open: false },
      ],
    });
    const list = [zeta, source({})];
    expect([...providerPackageKeys(list)]).toEqual(['zeta.classic', 'zeta.state', 'acme.levels']);
  });

  it('says the requests per quota pool', () => {
    expect(
      requestWords([
        { pool: 'api_default', used: 1204, cap: 4000 },
        { pool: 'api_futures_conversion', used: 3, cap: 300 },
      ]),
    ).toBe('api_default 1,204 of 4,000 · api_futures_conversion 3 of 300');
    expect(requestWords([{ pool: 'default', used: 12, cap: null }])).toBe('12 requests');
    expect(requestWords([{ pool: 'default', used: 12, cap: 100 }])).toBe('12 of 100 requests');
    expect(requestWords([])).toBeNull();
  });

  it('says what is stored of the vendor’s levels, by instrument', () => {
    const all = [
      series('Zeta', 'NQ', '2026-10-07', '2026-10-08'),
      series('Zeta', 'NQ', '2026-10-06', '2026-10-09'),
      series('Zeta', 'NDX', '2026-10-09', '2026-10-09'),
      series('Acme', 'NQ', '2026-01-01', '2026-01-02'),
    ];
    expect(storedWords(all, 'Zeta')).toBe('NQ 2026-10-06 to 2026-10-09 · NDX 2026-10-09');
    expect(storedWords(all, 'Nobody')).toBeNull();
  });

  it('offers backfill spans within what the vendor keeps, ending yesterday in New York', () => {
    expect(backfillSpans(90).map((s) => s.value)).toEqual(['7', '30', '90']);
    expect(backfillSpans(30).map((s) => s.value)).toEqual(['7', '30']);
    expect(backfillRange('2026-10-10', 7)).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(nyDate(Date.UTC(2026, 9, 10, 3))).toBe('2026-10-09');
    expect(
      backfillWords(
        [
          { status: 'would_ask', imported: 0 },
          { status: 'would_ask', imported: 0 },
          { status: 'already', imported: 0 },
        ],
        0,
      ),
    ).toBe('2 files to ask for · 1 stored before.');
    expect(
      backfillWords(
        [
          { status: 'stored', imported: 380 },
          { status: 'later', imported: 0 },
        ],
        380,
      ),
    ).toBe('380 values stored from 1 file · 1 left for the next run.');
    expect(backfillWords([], 0)).toBe('Nothing to ask for in that span.');
  });

  it('asks the analyst to draft and leaves the saving to the user', () => {
    expect(ADD_WITH_ANALYST).toContain('intel.test_source');
    expect(ADD_WITH_ANALYST).toContain('intel.draft_source');
  });
});
