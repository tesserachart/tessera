import type { AgentEvent, Card, CoverageDay, DataCoverage } from '@tessera/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DataCoverageCard } from '../src/analyst/cards/DataCoverageCard.tsx';
import {
  count,
  downloadState,
  downloadWords,
  gaps,
  laneMark,
  laneWords,
  leftWords,
  runWords,
} from '../src/analyst/cards/coverage.ts';
import { EMPTY_TRANSCRIPT, reduceTranscript } from '../src/app/agentTranscript.ts';

const day = (
  date: string,
  prints: CoverageDay['prints'],
  bars: CoverageDay['bars'] = 'saved',
  note: string | null = null,
): CoverageDay => ({
  date,
  contract: 'NQZ6.CME',
  prints,
  bars,
  outOfReach: false,
  note,
});

const DAYS = [
  day('2026-10-19', 'missing'),
  day('2026-10-20', 'missing'),
  day('2026-10-21', 'partial'),
  day('2026-10-22', 'saved'),
  day('2026-10-23', 'missing', 'missing'),
];

const coverage = (symbol: string): DataCoverage => ({
  symbol,
  scope: 'rth',
  from: '2026-10-19',
  to: '2026-10-23',
  days: DAYS,
  download: null,
});

const card = (symbol: string): Card => ({
  id: 'card-NQ-2026-10-19-2026-10-23-rth',
  body: { kind: 'data_coverage', ...coverage(symbol) },
  actions: [{ label: 'Check again', tool: 'market.data_coverage', input: { instrument: 'NQ' }, primary: false }],
  updatedAt: 1,
});

afterEach(cleanup);

describe('the data coverage card', () => {
  it('counts each lane and names the missing runs of days', () => {
    const prints = count(DAYS, 'prints');
    expect(prints).toEqual({ saved: 1, partial: 1, missing: 3 });
    expect(laneMark(prints)).toBe('partial');
    expect(laneWords(prints)).toBe('1 of 5 days saved · 1 in part · 3 missing');
    expect(gaps(DAYS, 'prints').map(runWords)).toEqual(['Oct 19 – Oct 21 (3 days)', 'Oct 23']);
    expect(laneMark(count(DAYS, 'bars'))).toBe('partial');
    expect(laneMark(count([day('2026-10-22', 'saved')], 'prints'))).toBe('done');
  });

  it('shows every day of each lane and what is missing', () => {
    render(<DataCoverageCard body={coverage('NQ')} actions={null} />);
    expect(screen.getByText('NQ saved data')).toBeTruthy();
    expect(screen.getByText('RTH · Oct 19 – Oct 23')).toBeTruthy();
    expect(screen.getByText('1 of 5 days saved · 1 in part · 3 missing')).toBeTruthy();
    expect(screen.getByText('4 of 5 days saved · 1 missing')).toBeTruthy();
    expect(document.querySelectorAll('.cc-days i[data-held="missing"]')).toHaveLength(4);
    expect(screen.getByText('Missing days')).toBeTruthy();
  });

  it('splits a run of missing days where the reason changes and says each reason', () => {
    const days = [
      day('2026-10-19', 'partial', 'saved', 'older than Apex · Rithmic keeps'),
      day('2026-10-20', 'missing', 'saved', 'older than Apex · Rithmic keeps'),
      day('2026-10-21', 'partial'),
      day('2026-10-22', 'partial', 'saved', 'today’s session is still open'),
    ];
    expect(gaps(days, 'prints').map(runWords)).toEqual([
      'Oct 19 – Oct 20 (2 days) · older than Apex · Rithmic keeps',
      'Oct 21',
      'Oct 22 · today’s session is still open',
    ]);
    expect(gaps(days, 'bars')).toEqual([]);
    const old = { ...day('2026-10-16', 'missing', 'missing', 'older than Apex · Rithmic keeps'), outOfReach: true };
    expect(gaps([old], 'bars').map(runWords)).toEqual(['Oct 16 · older than Apex · Rithmic keeps']);
  });

  it('says a download in the days it fetches, the day under way and the time left', () => {
    const d = {
      pullId: 'NQ-2026-10-19-2026-10-23-rth',
      state: 'running',
      days: 5,
      done: 2,
      failed: 0,
      outOfReach: 0,
      current: '2026-10-21',
      piecesDone: 6,
      pieces: 13,
      etaSeconds: 1260,
      waitingFor: null,
      waitingWhy: null,
      fetching: 2,
      fetched: 1,
      later: 0,
      auto: true,
    };
    const starting = { ...d, fetched: 0, current: null, piecesDone: 0, pieces: 0, etaSeconds: null };
    expect(downloadWords(starting)).toBe('Downloading 2 days…');
    expect(downloadWords(d)).toBe('Downloading · 1 of 2 days · Oct 21, 6 of 13 half hours · about 21 min left');
    expect(downloadState(d)).toBe('running');
    expect(
      downloadWords({ ...d, waitingFor: 'Apex · Rithmic', waitingWhy: 'the connection was taken by another login' }),
    ).toBe('Downloading · 1 of 2 days · waiting for Apex · Rithmic: the connection was taken by another login');
    expect(downloadWords({ ...d, state: 'cancelled' })).toBe('Download stopped · 1 of 2 days');
    expect(downloadWords({ ...d, state: 'done', fetched: 2 })).toBe('Saved · 2 days');
    expect(downloadWords({ ...d, state: 'done', fetching: 0, fetched: 0 })).toBe('Saved');
    expect(downloadWords({ ...d, state: 'done', fetched: 1, later: 1, outOfReach: 1 })).toBe(
      'Saved 1 of 2 days · 1 still coming · 1 older than the connection keeps',
    );
    expect(downloadState({ ...d, state: 'done', failed: 1 })).toBe('failed');
    expect(leftWords(30)).toBe('under a minute left');
    expect(leftWords(2 * 3600 + 600)).toBe('about 2 h 10 min left');
  });

  it('sits in the transcript where its call was, once, at its latest', () => {
    const ev = (event: AgentEvent, seq: number) => ({ sessionId: 's1', seq, ts: seq, turnId: 't1', event });
    let t = reduceTranscript(EMPTY_TRANSCRIPT, ev({ type: 'card', card: card('NQ') }, 1));
    t = reduceTranscript(t, ev({ type: 'card', card: card('ES') }, 2));
    const cards = t.items.filter((i) => i.kind === 'card');
    expect(cards).toHaveLength(1);
    const body = cards[0]?.kind === 'card' ? cards[0].card.body : null;
    expect(body?.kind === 'data_coverage' && body.symbol).toBe('ES');
  });
});
