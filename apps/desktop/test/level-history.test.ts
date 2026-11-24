import type { ImportLevelHistoryOutput, SeriesCoverageInfo } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { adapterOptions, coverageGroups, importSummary } from '../src/areas/settings/levelHistory.ts';

const series = (level: string, first: string, last: string, origins: Record<string, number>): SeriesCoverageInfo => ({
  name: `zeta.state.${level}`,
  vendor: 'Zeta',
  package: 'State',
  level,
  label: null,
  instrument: 'NQZ6.CME',
  endpoint: 'state/gamma_zero',
  basis: 'NDX',
  first: 0,
  last: 0,
  firstDate: first,
  lastDate: last,
  days: 3,
  observations: 10,
  origins,
});

describe('Settings › Levels › Level history', () => {
  it('lists each vendor on each instrument with its levels verbatim, its dates and where the values came from', () => {
    const g = coverageGroups([
      series('major_long_gamma', '2026-10-07', '2026-10-09', { live: 1204 }),
      series('major_short_gamma', '2026-10-06', '2026-10-08', { live: 3, import: 12480 }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      title: 'Zeta · NQZ6.CME',
      levels: 'major_long_gamma, major_short_gamma',
      span: '2026-10-06 to 2026-10-09 · 3 days',
      origins: 'recorded 1,207 · imported 12,480',
    });
  });

  it('a dry run says what it would store and what it could not read', () => {
    const out: ImportLevelHistoryOutput = {
      dryRun: true,
      importId: null,
      vendor: 'Acme Levels',
      adapter: 'mapping:acme-levels',
      rows: 101,
      records: 100,
      imported: 60,
      duplicates: 40,
      unreadable: 1,
      problems: [{ line: 102, message: '"x" is not a time' }],
      series: [
        {
          name: 'acme-levels.CW',
          package: '',
          level: 'CW',
          label: 'Call Wall',
          instrument: 'NQ',
          records: 100,
          new: 60,
          firstDate: '2026-10-07',
          lastDate: '2026-10-09',
        },
      ],
      instruments: ['NQ'],
      firstDate: '2026-10-07',
      lastDate: '2026-10-09',
      days: 3,
      samples: [],
      saved: null,
      notes: ['a dry run: nothing was stored'],
    };
    expect(importSummary(out)).toEqual([
      'Acme Levels: 100 values read, 60 new, 40 already stored from 2026-10-07 to 2026-10-09 (3 days).',
      'acme-levels.CW (Call Wall) on NQ',
      '1 rows not read; line 102: "x" is not a time.',
    ]);
    expect(adapterOptions([{ name: 'acme-levels', vendor: 'Acme Levels', kind: 'mapping', description: '' }])).toEqual([
      { value: 'acme-levels', label: 'Acme Levels (saved mapping)' },
    ]);
  });
});
