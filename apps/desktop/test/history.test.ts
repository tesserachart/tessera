import type { PullSummary } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  FOLLOWS_DESK,
  checkedInputs,
  deskRoots,
  durationWords,
  historyProgress,
  offerLede,
  offerMarkets,
  offerRows,
  requestsOf,
  rowWords,
  statusWords,
  toggled,
  totalWords,
  unknownWhy,
} from '../src/areas/settings/history.ts';
import { ALL_SAVED, UNMEASURED, estimate, pull } from './support/history.tsx';

const rowsOf = (...pairs: [string, ReturnType<typeof estimate>][]) =>
  offerRows(
    pairs.map(([input]) => input),
    new Map(pairs),
  );

describe('the markets a week of history is offered for', () => {
  it('lists the desk’s first, then the watchlists’, each once whatever its case', () => {
    expect(offerMarkets(['NQ', 'ES'], ['MNQ', 'ES', 'nq', ' RTY '])).toEqual(['NQ', 'ES', 'MNQ', 'RTY']);
    expect(offerMarkets([], [])).toEqual([]);
  });

  it('takes a chart’s root from its contract spec, waiting for the spec of one not read yet', () => {
    const nq = { instrument: 'NQZ6.CME', root: 'NQ' };
    const spot = { instrument: 'BTC-USD', root: null };
    expect(deskRoots(['a', 'b', 'c'], [nq, null, spot])).toEqual(['NQ', 'BTC-USD']);
  });

  it('keeps a row per contract the runtime resolves, drops what it does not serve or has nothing to ask for', () => {
    const rows = rowsOf(
      ['NQ', estimate('NQ')],
      ['NQZ6.CME', estimate('NQ')],
      ['ES', estimate('ES')],
      ['CL', estimate('CL', { days: 3, outOfReach: 3, saved: 0 })],
    );
    expect(rows.map((r) => r.input)).toEqual(['NQ', 'ES']);
    expect(offerRows(['NQ', 'GC'], new Map([['NQ', estimate('NQ')]])).map((r) => r.input)).toEqual(['NQ']);
  });
});

describe('which rows are checked', () => {
  const rows = rowsOf(
    ['NQ', estimate('NQ')],
    ['ES', estimate('ES')],
    ['MNQ', estimate('MNQ', ALL_SAVED)],
    ['RTY', estimate('RTY')],
  );

  it('follows the desk until the user touches a box, and never checks a day-complete row', () => {
    expect([...checkedInputs(rows, ['NQ', 'ES', 'MNQ'], FOLLOWS_DESK)]).toEqual(['NQ', 'ES']);
    expect([...checkedInputs(rows, ['ES'], FOLLOWS_DESK)]).toEqual(['ES']);
  });

  it('keeps what the user picked once they touch a box, whatever the desk does next', () => {
    const touched = toggled(rows, ['NQ', 'ES'], FOLLOWS_DESK, 'RTY');
    expect([...checkedInputs(rows, ['NQ', 'ES'], touched)]).toEqual(['NQ', 'ES', 'RTY']);
    expect([...checkedInputs(rows, [], touched)]).toEqual(['NQ', 'ES', 'RTY']);
    const off = toggled(rows, ['NQ', 'ES'], touched, 'NQ');
    expect([...checkedInputs(rows, ['NQ'], off)]).toEqual(['ES', 'RTY']);
  });

  it('asks for the request of each checked row, dates as the runtime filled them', () => {
    expect(requestsOf(rows, new Set(['ES', 'RTY']))).toEqual([estimate('ES').request, estimate('RTY').request]);
  });
});

describe('what a row and the total say', () => {
  it('reads days and size, saying plainly what is not known or already there', () => {
    expect(rowWords(rowsOf(['NQ', estimate('NQ')])[0]!)).toEqual({ days: '5 days', size: 'about 410 MB', why: null });
    expect(rowWords(rowsOf(['ES', estimate('ES', UNMEASURED)])[0]!)).toEqual({
      days: '5 days',
      size: 'size not known yet',
      why: unknownWhy('size', 'ES'),
    });
    expect(rowWords(rowsOf(['MNQ', estimate('MNQ', ALL_SAVED)])[0]!)).toEqual({
      days: '5 days',
      size: 'saved',
      why: 'Already on this computer',
    });
    expect(rowWords(rowsOf(['CL', estimate('CL', { days: 5, outOfReach: 2 })])[0]!).days).toBe('3 days');
    expect(rowWords(rowsOf(['CL', estimate('CL', { days: 2, outOfReach: 1 })])[0]!).days).toBe('1 day');
  });

  it('says a market whose week is downloading is, and leaves it out of the picked ones', () => {
    const nq = estimate('NQ');
    const rows = offerRows(
      ['NQ', 'ES'],
      new Map([
        ['NQ', nq],
        ['ES', estimate('ES')],
      ]),
      new Set([nq.id]),
    );
    expect(rowWords(rows[0]!)).toEqual({
      days: '5 days',
      size: 'downloading',
      why: 'Downloading now. The status bar shows how far it is.',
    });
    expect([...checkedInputs(rows, ['NQ', 'ES'], FOLLOWS_DESK)]).toEqual(['ES']);
    expect([...checkedInputs(rows, ['NQ'], toggled(rows, ['NQ'], FOLLOWS_DESK, 'NQ'))]).toEqual([]);
  });

  it('totals the checked rows, and says what is missing instead of a partial sum', () => {
    const rows = rowsOf(
      ['NQ', estimate('NQ')],
      ['ES', estimate('ES', { size: { bytes: 410 * 1024 * 1024, prints: 1, measuredPrints: 1 }, seconds: 120 })],
      ['RTY', estimate('RTY', UNMEASURED)],
      ['GC', estimate('GC', { seconds: null })],
    );
    expect(totalWords(rows, new Set())).toBeNull();
    expect(totalWords(rows, new Set(['NQ', 'ES']))).toEqual({
      lead: 'About 820 MB and 6 minutes. It runs in the background while you chart.',
      hint: null,
      why: null,
    });
    expect(totalWords(rows, new Set(['NQ', 'RTY']))).toEqual({
      lead: '',
      hint: 'Size not known yet',
      why: unknownWhy('size', 'RTY'),
    });
    expect(totalWords(rows, new Set(['NQ', 'GC']))).toEqual({
      lead: 'About 820 MB · ',
      hint: 'time not known yet',
      why: unknownWhy('time', 'GC'),
    });
  });

  it('gives the reasons in the words of the design and a paragraph naming the connection', () => {
    expect(unknownWhy('size', 'nq')).toBe(
      'Tessera measures a day’s size from the trades of NQ it has saved from this connection. None are saved yet.',
    );
    expect(unknownWhy('time', 'NQ')).toBe('Tessera times downloads by this connection’s own pace. None has run yet.');
    expect(offerLede('Apex · Rithmic')).toBe(
      'Tessera charts the prices of your own feed, Apex · Rithmic, and saves what it reads here, nowhere else. Replay and the order-flow studies read that saved history, so a week of it fills them from the first day.',
    );
  });

  it('says a duration the way a trader would', () => {
    expect([0, 59, 60, 360, 3_540, 3_600, 4_500, 7_200].map(durationWords)).toEqual([
      'under a minute',
      'under a minute',
      '1 minute',
      '6 minutes',
      '59 minutes',
      '1 hour',
      '1 hour 15 minutes',
      '2 hours',
    ]);
  });
});

describe('the status bar’s view of the pulls', () => {
  const failedPull = (root: string): PullSummary =>
    pull(root, 5, {
      state: 'done',
      current: null,
      progress: {
        days: 5,
        saved: 3,
        alreadySaved: 0,
        noTrades: 0,
        outOfReach: 0,
        failed: 2,
        later: 0,
        waiting: 0,
        prints: 9,
      },
    });

  it('counts the running pulls’ days together and names each with its own', () => {
    const view = historyProgress([pull('NQ', 3), pull('ES', 0), failedPull('RTY')], []);
    expect(view).toEqual({
      kind: 'running',
      done: 3,
      days: 10,
      lines: ['NQ Z6 · 3 of 5 days', 'ES Z6 · 0 of 5 days'],
    });
    expect(statusWords(view as Extract<typeof view, { kind: 'running' }>)).toEqual({
      shown: 'History 3/10 days',
      name: 'Downloading history: 3 of 10 days',
    });
  });

  it('is idle with nothing running, and reports failed days only of pulls that ran in this window', () => {
    expect(historyProgress([], [])).toEqual({ kind: 'idle' });
    expect(historyProgress([failedPull('NQ')], [])).toEqual({ kind: 'idle' });
    const view = historyProgress([failedPull('NQ')], [failedPull('NQ').id]);
    expect(view).toEqual({ kind: 'failed', days: 2 });
    expect(statusWords(view as Extract<typeof view, { kind: 'failed' }>).shown).toBe('History: 2 days failed');
    expect(
      historyProgress([pull('NQ', 5, { state: 'done', current: null })], ['NQ-2026-10-26-2026-10-30-session']),
    ).toEqual({
      kind: 'idle',
    });
  });
});
