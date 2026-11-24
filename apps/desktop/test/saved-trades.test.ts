import type { DayStatus, PullSummary, SavedContractInfo } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  pulledLines,
  anyRunning,
  contractExport,
  contractFact,
  contractHelp,
  dayWords,
  defaultPullForm,
  exportFolder,
  exportWords,
  failureWords,
  finishedDays,
  progressWords,
  pullActions,
  pullStateWords,
  pullTitle,
  pullsRefreshEvery,
  rangeWords,
  readPullForm,
} from '../src/areas/settings/savedTrades.ts';

const day = (date: string, status: DayStatus) => ({ date, contract: 'NQZ6.CME', source: 'mock', status });

function pull(over: Partial<PullSummary> = {}): PullSummary {
  return {
    id: 'NQ-2026-09-21-2026-09-25-rth',
    request: { instrument: 'nq', from: '2026-09-21', to: '2026-09-25', scope: 'rth' },
    state: 'running',
    progress: {
      days: 5,
      saved: 2,
      alreadySaved: 1,
      noTrades: 0,
      outOfReach: 0,
      failed: 0,
      later: 0,
      waiting: 2,
      prints: 412_331,
    },
    current: { date: '2026-09-22', piecesDone: 6, pieces: 13, waitingFor: null, waitingWhy: null },
    etaSeconds: null,
    auto: false,
    days: [],
    ...over,
  };
}

const contract: SavedContractInfo = {
  source: 'mock',
  instrument: 'NQZ6.CME',
  days: 14,
  prints: 2_100_000,
  bytes: 9_000_000,
  first: '2026-09-14',
  last: '2026-10-02',
};

describe('saved trades words', () => {
  it('names days and ranges the way a trader reads them', () => {
    expect(dayWords('2026-09-04')).toBe('Sep 4');
    expect(dayWords('2026-09-04', true)).toBe('Sep 4, 2026');
    expect(dayWords('2026-02-30')).toBe('2026-02-30');
    expect(rangeWords('2026-07-21', '2026-10-20')).toBe('Jul 21 to Oct 20, 2026');
    expect(rangeWords('2025-12-29', '2026-01-02')).toBe('Dec 29, 2025 to Jan 2, 2026');
    expect(rangeWords('2026-10-01', '2026-10-01')).toBe('Oct 1, 2026');
    expect(pullTitle(pull().request)).toBe('NQ · Sep 21 to Sep 25, 2026 · RTH');
  });

  it('says where a pull stands and what it has done', () => {
    expect(pullStateWords(pull())).toBe('Fetching Sep 22 · 46%');
    expect(pullStateWords(pull({ current: null }))).toBe('Waiting its turn');
    expect(
      pullStateWords(
        pull({
          current: { date: '2026-09-22', piecesDone: 0, pieces: 46, waitingFor: 'rithmic-apex', waitingWhy: null },
        }),
      ),
    ).toBe('Waiting for rithmic-apex to connect');
    expect(pullStateWords(pull({ state: 'cancelled' }))).toBe('Cancelled');
    expect(pullStateWords(pull({ state: 'done' }))).toBe('Done');
    expect(progressWords(pull())).toBe('3 of 5 days · 2 fetched · 1 already saved · 412,331 prints');
  });

  it('names the first failed day and its reason', () => {
    const failed = pull({
      state: 'done',
      progress: { ...pull().progress, failed: 2, waiting: 0 },
      days: [
        day('2026-09-21', { kind: 'failed', reason: 'the feed refused', tries: 1, at: null }),
        day('2026-09-22', { kind: 'saved', prints: 10 }),
        day('2026-09-23', { kind: 'failed', reason: 'timed out', tries: 1, at: null }),
      ],
    });
    expect(failureWords(failed)).toBe('Sep 21 failed (and 1 other day): the feed refused');
    expect(failureWords(pull())).toBeNull();
    expect(pullStateWords(failed)).toBe('Done, some days failed');
  });

  it('offers cancel while running and resume when stopped or failed', () => {
    expect(pullActions(pull())).toEqual({ cancel: true, resume: false });
    expect(pullActions(pull({ state: 'cancelled' }))).toEqual({ cancel: false, resume: true });
    expect(pullActions(pull({ state: 'done' }))).toEqual({ cancel: false, resume: false });
    expect(pullActions(pull({ state: 'done', progress: { ...pull().progress, failed: 1 } }))).toEqual({
      cancel: false,
      resume: true,
    });
    expect(anyRunning([pull({ state: 'done' }), pull()])).toBe(true);
    expect(anyRunning(undefined)).toBe(false);
    expect(finishedDays([pull(), pull({ state: 'done', progress: { ...pull().progress, waiting: 0 } })])).toBe(8);
  });

  it('keeps the pull list fresh while Settings shows, so a pull an agent started appears', () => {
    expect(pullsRefreshEvery(undefined, true)).toBe(5_000);
    expect(pullsRefreshEvery([pull({ state: 'done' })], true)).toBe(5_000);
    expect(pullsRefreshEvery([pull()], true)).toBe(1_000);
    expect(pullsRefreshEvery([pull()], false)).toBeUndefined();
  });

  it('describes a saved contract', () => {
    expect(contractHelp(contract)).toBe('mock · Sep 14 to Oct 2, 2026');
    expect(contractFact(contract)).toBe('14 days · 2,100,000 prints');
  });

  it('says what a login pulled today and this week in two short lines, sizes in KB and MB', () => {
    const pulled = {
      source: 'rithmic-apex',
      today: { requests: 1, bytes: 900 },
      week: { requests: 1_234, bytes: 18_874_368 },
      total: { requests: 1_234, bytes: 18_874_368 },
    };
    expect(pulledLines(pulled)).toEqual(['Today 900 B · 1 request', '7 days 18.0 MB · 1,234 requests']);
  });
});

describe('the pull form', () => {
  it('turns a valid form into a request', () => {
    expect(readPullForm({ instrument: ' NQ ', from: '2026-07-21', to: '2026-10-20', scope: 'session' })).toEqual({
      ok: true,
      request: { instrument: 'NQ', from: '2026-07-21', to: '2026-10-20', scope: 'session' },
    });
  });

  it('says what is wrong with an invalid one', () => {
    const f = { instrument: 'NQ', from: '2026-07-21', to: '2026-10-20', scope: 'rth' as const };
    expect(readPullForm({ ...f, instrument: '' })).toMatchObject({ ok: false });
    expect(readPullForm({ ...f, from: '' })).toEqual({ ok: false, why: 'Pick the first day.' });
    expect(readPullForm({ ...f, from: '2026-11-01' })).toEqual({ ok: false, why: 'The first day is after the last.' });
  });

  it('starts at about a quarter of NQ RTH ending yesterday', () => {
    expect(defaultPullForm(new Date(2026, 9, 22, 9, 0))).toEqual({
      instrument: 'NQ',
      from: '2026-07-22',
      to: '2026-10-21',
      scope: 'rth',
    });
  });
});

describe('export', () => {
  it('writes into the data directory’s exports by default', () => {
    expect(exportFolder('/home/me/.local/share/tessera/')).toBe('/home/me/.local/share/tessera/exports');
    expect(exportFolder('C:\\Users\\me\\Tessera')).toBe('C:\\Users\\me\\Tessera\\exports');
    expect(exportFolder(null)).toBe('');
  });

  it('exports a contract’s saved days whole, from its own connection', () => {
    expect(contractExport(contract, '/x')).toEqual({
      instrument: 'NQZ6.CME',
      from: '2026-09-14',
      to: '2026-10-02',
      scope: 'session',
      dir: '/x',
      source: 'mock',
    });
    expect(contractExport({ ...contract, first: null, last: null }, '/x')).toBeNull();
  });

  it('says what was written', () => {
    const file = (date: string, complete: boolean) => ({
      date,
      path: `/x/NQ-${date}.csv`,
      contract: 'NQZ6.CME',
      source: 'mock',
      prints: 10,
      complete,
    });
    expect(
      exportWords({ dir: '/x', files: [file('2026-09-24', true), file('2026-09-25', false)], missing: ['2026-09-21'] }),
    ).toBe('2 files in /x · 1 day saved only in part · 1 day with nothing saved');
  });
});
