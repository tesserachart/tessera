import { afterEach, describe, expect, it } from 'vitest';
import {
  blankStudy,
  coverageInput,
  coverageLines,
  dataWords,
  hhmm,
  parseLevels,
  dateValue,
  fromDateValue,
  moneyCi,
  pctCi,
  placeboLine,
  stateWord,
  studyProblem,
} from '../src/areas/research/model.ts';
import { candlesInput, curveOf, inCandles, sessionSharpe } from '../src/areas/research/tester.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';

afterEach(() => putRuntimeSettings({ 'display.timeZone': null }, false));

describe('a study’s level inputs and window', () => {
  it('levels are named vendor.level, the window HH:MM to HH:MM', () => {
    expect(parseLevels('zeta.major_long_gamma, zeta.zero_gamma@NDX  ')).toEqual([
      'zeta.major_long_gamma',
      'zeta.zero_gamma@NDX',
    ]);
    expect(hhmm('9:30')).toBe('09:30');
    expect(hhmm('24:00')).toBeNull();
    const s = { ...blankStudy('NQ'), name: 'MLG', hypothesis: 'h' };
    expect(studyProblem({ ...s, data: { ...s.data, levels: ['major_long_gamma'] } })).toBe(
      'Name levels as vendor.level, as Level history names them',
    );
    expect(studyProblem({ ...s, data: { ...s.data, window: { start: '11:30', end: '09:30' } } })).toBe(
      'The window needs a start before its end (HH:MM)',
    );
    const d = { ...s.data, levels: ['zeta.major_long_gamma'], window: { start: '09:30', end: '11:30' } };
    expect(studyProblem({ ...s, data: d })).toBeNull();
    expect(dataWords(d, 'NQ Z6')).toBe(
      'NQ Z6 · 5m · all served history · 09:30–11:30 New York · zeta.major_long_gamma',
    );
    expect(dataWords({ ...d, window: { ...d.window, timeZone: 'Asia/Kolkata' } }, 'NQ Z6')).toBe(
      'NQ Z6 · 5m · all served history · 09:30–11:30 Kolkata · zeta.major_long_gamma',
    );
  });

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
  it('a study reads its state, or its verdict once run, with its generation', () => {
    expect(stateWord({ state: 'draft', lastVerdict: null, generation: 1 })).toBe('Draft');
    expect(stateWord({ state: 'frozen', lastVerdict: null, generation: 1 })).toBe('Frozen');
    expect(stateWord({ state: 'recorded', lastVerdict: 'lead', generation: 3 })).toBe('Lead · gen 3');
  });

  it('measurements carry their intervals', () => {
    expect(pctCi(0.5242, [0.47, 0.576])).toBe('52.4% (47.0–57.6)');
    expect(moneyCi(12.4, [-3.1, 27.9])).toBe('$12.40 (−$3.10 to $27.90)');
    expect(moneyCi(null, null)).toBe('—');
    expect(placeboLine({ runs: 100, realMean: 4, placeboMedian: 1.2, percentile: 0.74 })).toBe(
      'Beat 74% of 100 placebo runs (the same trades at random bars; their median $1.20 a trade)',
    );
  });

  it('a new study needs its name and its hypothesis before it can be saved', () => {
    const s = blankStudy('NQ');
    expect(studyProblem(s)).toBe('Name the study');
    expect(studyProblem({ ...s, name: 'ORB' })).toBe('Register the hypothesis before it runs');
    expect(studyProblem({ ...s, name: 'ORB', hypothesis: 'h' })).toBeNull();
  });

  it('dates are days in the trader’s time zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    const ns = fromDateValue('2026-10-02')!;
    expect(new Date(ns / 1e6).toISOString()).toBe('2026-10-01T15:00:00.000Z');
    expect(dateValue(ns)).toBe('2026-10-02');
    expect(new Date(fromDateValue('2026-10-02', true)! / 1e6).toISOString()).toBe('2026-10-02T14:59:59.999Z');
    putRuntimeSettings({ 'display.timeZone': 'Asia/Kolkata' }, false);
    expect(new Date(fromDateValue('2026-10-02')! / 1e6).toISOString()).toBe('2026-10-01T18:30:00.000Z');
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    expect(new Date(fromDateValue('2026-10-25', true)! / 1e6).toISOString()).toBe('2026-10-25T23:59:59.999Z');
    expect(dateValue(fromDateValue('2026-01-15', true))).toBe('2026-01-15');
    expect(fromDateValue('')).toBeNull();
  });

  it('asks coverage for the exchange’s trade dates, whatever the trader’s zone', () => {
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    const s = blankStudy('NQ');
    const run = { from: fromDateValue('2026-10-07')!, to: fromDateValue('2026-10-09', true)! };
    expect(coverageInput(s, run)).toMatchObject({ from: '2026-10-06', to: '2026-10-09' });
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

  it('charts the whole run when it fits, else a window around the picked trade', () => {
    const study = blankStudy('NQ');
    const step = 300e9;
    const short = { from: 0, to: 100 * step };
    expect(candlesInput(study, short, null)).toMatchObject({ from: 0, to: 101 * step, tf: '5m', session: 'all' });
    const long = { from: 0, to: 20_000 * step };
    const trade = { entryTime: 10_000 * step, exitTime: 10_010 * step };
    const around = candlesInput(study, long, trade);
    expect(around.to! - around.from!).toBe(2000 * step);
    expect(inCandles(around, trade)).toBe(true);
    expect(inCandles(around, { entryTime: 0, exitTime: step })).toBe(false);
    const last = candlesInput(study, long, { entryTime: 20_000 * step, exitTime: 20_000 * step });
    expect(last.to).toBe(20_001 * step);
  });
});
