import type { AgentSessionSummary, RunDigest, Study } from '@tessera/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dayWords,
  entrySource,
  entryTotals,
  groupByDay,
  ledgerEntries,
  matching,
  onShelf,
  pickEntry,
  sourceWords,
} from '../src/areas/research/ledger.ts';
import { coverageLines, dateValue, moneyCi, pctCi, placeboLine, setupRows } from '../src/areas/research/model.ts';
import { SAMPLE_DIGEST, SAMPLE_STUDIES } from '../src/areas/research/samples.ts';
import { curveOf, sessionSharpe } from '../src/areas/research/tester.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';

afterEach(() => putRuntimeSettings({ 'display.timeZone': null }, false));

const DAY = 86_400_000_000_000;
const OCT_2 = Date.parse('2026-10-02T18:00:00Z') * 1e6;
const chat = (sessionId: string) => ({ kind: 'agent' as const, sessionId, provider: 'claude-code' });
const [orb, gap, flip] = SAMPLE_STUDIES as [Study, Study, Study];
const run = (id: string, study: Study, at: number, more: Partial<RunDigest> = {}): RunDigest => ({
  ...SAMPLE_DIGEST,
  runId: id,
  studyId: study.id,
  at,
  ...more,
});
const sessions = [{ id: 'ses-1', title: 'Opening range ideas' }] as unknown as AgentSessionSummary[];

describe('the research ledger', () => {
  const runs = [
    run('r-old', orb, OCT_2 - DAY, { origin: { kind: 'user' } }),
    run('r-new', orb, OCT_2, { origin: chat('ses-1') }),
    run('r-gap', gap, OCT_2 - 2 * DAY, { archivedAt: OCT_2 }),
    run('r-gone', { ...orb, id: 'deleted-study' }, OCT_2),
  ];
  const entries = ledgerEntries([orb, gap, flip], runs);

  it('lists every run newest first under its idea, and ideas not run yet first', () => {
    expect(entries.map((e) => e.id)).toEqual([flip.id, 'r-new', 'r-old', 'r-gap']);
    expect(entries[1]!.study.name).toBe(orb.name);
  });

  it('keeps archived runs on their own shelf', () => {
    expect(onShelf(entries, 'active').map((e) => e.id)).toEqual([flip.id, 'r-new', 'r-old']);
    expect(onShelf(entries, 'archived').map((e) => e.id)).toEqual(['r-gap']);
  });

  it('says which chat a run came from, else the chat its idea came from', () => {
    const [, fresh, old] = entries as [never, (typeof entries)[0], (typeof entries)[0]];
    expect(sourceWords(entrySource(fresh, sessions))).toBe('Opening range ideas');
    expect(sourceWords(entrySource(old, sessions))).toBe('You');
    const fromChat = ledgerEntries(
      [{ ...orb, origin: chat('ses-1') }],
      [run('r', orb, OCT_2, { origin: { kind: 'user' } })],
    );
    expect(entrySource(fromChat[0]!, sessions)).toEqual({
      kind: 'chat',
      sessionId: 'ses-1',
      title: 'Opening range ideas',
      gone: false,
    });
    const gone = ledgerEntries([orb], [run('r', orb, OCT_2, { origin: chat('ses-9') })]);
    expect(sourceWords(entrySource(gone[0]!, sessions))).toBe('A deleted chat');
    expect(sourceWords(entrySource(gone[0]!, null))).toBe('An analyst chat');
  });

  it('opens a study on its newest run', () => {
    expect(pickEntry(entries, orb.id)?.id).toBe('r-new');
    expect(pickEntry(entries, 'r-old')?.id).toBe('r-old');
    expect(pickEntry(entries, 'nowhere')).toBeNull();
  });

  it('finds runs by every word typed, across idea, market, verdict and chat', () => {
    expect(matching(entries, 'opening ideas', sessions).map((e) => e.id)).toEqual(['r-new']);
    expect(matching(entries, 'gap lead', sessions).map((e) => e.id)).toEqual(['r-gap']);
    expect(matching(entries, '  ', sessions)).toHaveLength(entries.length);
  });

  it('adds development and later into the run’s totals, and groups runs by day', () => {
    const base = SAMPLE_DIGEST.cases[0]!;
    expect(entryTotals(entries[1]!)).toEqual({
      trades: base.development.trades + base.later.trades,
      net: base.development.netPnl + base.later.netPnl,
    });
    expect(entryTotals(entries[0]!)).toBeNull();
    const days = groupByDay(entries, 'America/New_York');
    expect(days.map((d) => [d.day, d.entries.length])).toEqual([
      [null, 1],
      ['2026-10-02', 1],
      ['2026-10-01', 1],
      ['2026-09-30', 1],
    ]);
    expect(dayWords('2026-10-02', '2026-10-02')).toBe('Today');
    expect(dayWords('2026-10-01', '2026-10-02')).toBe('Thu 1 Oct');
    expect(dayWords(null, '2026-10-02')).toBe('Not run yet');
  });
});

describe('a study’s level inputs and window', () => {
  it('a run says what its levels covered and what was left out', () => {
    expect(
      coverageLines({
        sessionsRead: 20,
        sessionsUsed: 3,
        usedFrom: '2026-10-07',
        usedTo: '2026-10-09',
        excludedDates: ['2026-09-14'],
        inputs: [
          {
            name: 'zeta.major_long_gamma',
            series: 'zeta.state.major_long_gamma',
            vendor: 'Zeta',
            label: 'Major Long Gamma',
            instrument: 'NQZ6.CME',
            basis: 'NDX',
            firstDate: '2026-10-07',
            lastDate: '2026-10-09',
            sessions: 3,
          },
        ],
      }),
    ).toEqual([
      'Ran on 3 of 20 sessions (2026-10-07 to 2026-10-09): those with history of every level input.',
      'zeta.major_long_gamma · Zeta Major Long Gamma on NQZ6.CME (NDX prices) · 2026-10-07 to 2026-10-09 · 3 sessions',
      '17 sessions left out, none filled in.',
    ]);
  });
});

describe('the Research area’s words', () => {
  it('measurements carry their intervals', () => {
    expect(pctCi(0.5242, [0.47, 0.576])).toBe('52.4% (47.0–57.6)');
    expect(moneyCi(12.4, [-3.1, 27.9])).toBe('$12.40 (−$3.10 to $27.90)');
    expect(moneyCi(null, null)).toBe('—');
    expect(placeboLine({ runs: 100, realMean: 4, placeboMedian: 1.2, percentile: 0.74 })).toBe(
      'Beat 74% of 100 placebo runs (the same trades at random bars; their median $1.20 a trade)',
    );
  });

  it('dates are days in the trader’s time zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(dateValue(Date.parse('2026-10-01T15:00:00Z') * 1e6)).toBe('2026-10-02');
    putRuntimeSettings({ 'display.timeZone': 'America/New_York' }, false);
    expect(dateValue(Date.parse('2026-10-01T15:00:00Z') * 1e6)).toBe('2026-10-01');
    expect(dateValue(null)).toBe('');
  });

  it('reads a study’s setup in plain words', () => {
    const study: Study = {
      ...orb,
      data: { ...orb.data, rthOnly: true, window: { start: '09:30', end: '12:00' }, levels: ['zeta.zero_gamma'] },
      execution: { ...orb.execution, stopTicks: 60, targetTicks: null },
    };
    const rows = Object.fromEntries(setupRows(study, 'NQ Z6').map((r) => [r.label, r.value]));
    expect(rows).toMatchObject({
      Market: 'NQ Z6 · 5m · RTH only',
      History: 'All served history',
      Window: '09:30–12:00 New York',
      Levels: 'zeta.zero_gamma',
      Rules: 'Breakout of 20 bars, held 12',
      Stop: '60 ticks',
      Target: 'None',
      'Fill cases': 'base 1t · stressed 2t',
    });
    expect(rows['Pass rules']).toBe(
      'At least 100 later trades · Later mean trade’s interval above zero · Each half of the later sessions positive · Development positive',
    );
  });
});

describe('the strategy tester measures', () => {
  it('counts sessions without a trade as flat in the Sharpe ratio', () => {
    const flat = sessionSharpe([100, -50], 2);
    const diluted = sessionSharpe([100, -50], 4);
    expect(flat).toBeCloseTo((25 / Math.sqrt(11250)) * Math.sqrt(252), 6);
    expect(diluted).toBeCloseTo((12.5 / Math.sqrt((10000 + 2500 - 4 * 12.5 ** 2) / 3)) * Math.sqrt(252), 6);
    expect(sessionSharpe([100], 1)).toBeNull();
    expect(sessionSharpe([], 10)).toBeNull();
  });

  it('keeps the deepest drawdown of every point it thins out', () => {
    const equity = [100, 120, 80, 130, 90, 140].map((e, i) => ({ time: i, equity: e }));
    expect(curveOf(equity, 3)).toEqual([
      { time: 0, pnl: 0, drawdown: 0 },
      { time: 2, pnl: -20, drawdown: -40 },
      { time: 4, pnl: -10, drawdown: -40 },
      { time: 5, pnl: 40, drawdown: 0 },
    ]);
  });
});
