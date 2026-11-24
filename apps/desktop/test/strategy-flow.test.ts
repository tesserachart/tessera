import type { JournalTrade, Setup } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { readRunnerSetting, runnerValue } from '../src/analyst/tradingSessions.ts';
import {
  replayTrades,
  sessionsWords,
  setupOfStudy,
  studyTradeView,
  tradable,
  tradedBySessions,
} from '../src/areas/research/flow.ts';

const trade = (id: string, closedAt: number | null): JournalTrade =>
  ({
    id,
    instrument: 'NQZ6.CME',
    side: 'sell',
    qty: 2,
    openedAt: 1_000,
    closedAt,
    status: closedAt === null ? 'open' : 'closed',
  }) as JournalTrade;

describe('strategies between Research, the analyst and the journal', () => {
  it('replays only closed trades, with what the bars need', () => {
    expect(replayTrades([trade('a', 5_000), trade('b', null)])).toEqual([
      { instrument: 'NQZ6.CME', side: 'sell', qty: 2, openedAt: 1_000, closedAt: 5_000 },
    ]);
  });

  it('keeps the traded study when another session setting changes', () => {
    const s = readRunnerSetting({ enabled: true, accountId: 'paper', studyId: 'study-1' });
    expect(tradedBySessions(s, { id: 'study-1' })).toBe(true);
    expect(runnerValue(s, { issuesRepo: 'owner/repo' })).toMatchObject({ studyId: 'study-1' });
    expect(runnerValue(s, { studyId: '' })).not.toHaveProperty('studyId');
  });

  it('trades frozen studies only and finds the setup that holds a study’s trades', () => {
    expect(tradable({ state: 'draft' })).toBe(false);
    expect(tradable({ state: 'recorded' })).toBe(true);
    const setups = [
      { id: 's1', studyId: null },
      { id: 's2', studyId: 'study-1' },
    ] as Setup[];
    expect(setupOfStudy(setups, { id: 'study-1' })?.id).toBe('s2');
    expect(setupOfStudy(setups, { id: 'study-9' })).toBeNull();
  });
});

describe('the study pane’s word on the trading sessions', () => {
  it('says the sessions are off rather than a bare Off', () => {
    const status = {
      setting: { enabled: false, studyId: 'study-1' },
      instructionsPath: '',
      instructionsChars: null,
      missing: [],
      day: null,
      nextStart: null,
    };
    expect(sessionsWords(status, 0)).toBe('Trading sessions are off');
    expect(sessionsWords({ ...status, setting: { enabled: true }, missing: ['Pick the account it trades'] }, 0)).toBe(
      'Not ready: Pick the account it trades',
    );
  });
});

describe('the study pane while a session runs', () => {
  const day = (studyId: string | null) => ({
    date: '2026-10-02',
    opensAt: 0,
    closesAt: 10_000,
    phase: 'trading' as const,
    sessionId: 'ses-1',
    accountId: 'paper-main',
    startedAt: 0,
    note: null,
    studyId,
  });
  const status = (studyId: string | null, setStudy: string) => ({
    setting: { enabled: true, studyId: setStudy },
    instructionsPath: '',
    instructionsChars: null,
    missing: [],
    day: day(studyId),
    nextStart: null,
  });
  const frozen = (id: string) => ({ id, state: 'frozen' as const });

  it('says the running session keeps the study it started with', () => {
    const s = status('study-a', 'study-b');
    expect(studyTradeView(s.setting, s, frozen('study-b'), 5)).toEqual({
      action: 'Stop the analyst trading it',
      standing: 'From the next session: the running one keeps its study',
    });
    expect(studyTradeView(s.setting, s, frozen('study-a'), 5)).toEqual({
      action: 'Have the analyst trade it instead',
      standing: 'The running session trades it until its close',
    });
  });

  it('says when the running session trades without a study', () => {
    const s = status(null, 'study-b');
    expect(studyTradeView(s.setting, s, frozen('study-b'), 5).standing).toBe(
      'From the next session: the running one trades without a study',
    );
  });

  it('offers nothing on a draft that is not set', () => {
    const s = status(null, '');
    expect(studyTradeView({ enabled: true }, s, { id: 'x', state: 'draft' }, 5).action).toBeNull();
  });
});
