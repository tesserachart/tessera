import type { ReplayState } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { cursorMs, dayChoices, earlierText, hasEnded, jumpTarget } from '../src/chart/replay/model.ts';
import { displaySymbol, isReplay, replayedContract } from '../src/market/instruments.ts';
import { nsAt } from './support/time.ts';

const globexDay: ReplayState = {
  instrument: 'NQZ6-R1.CME',
  contract: 'NQZ6.CME',
  source: 'rithmic-apex',
  tradeDate: '2026-10-01',
  from: nsAt('2026-09-30T22:00:00Z'),
  to: nsAt('2026-10-01T21:00:00Z'),
  cursor: nsAt('2026-10-01T13:30:00Z'),
  playing: true,
  speed: 5,
  earlier: { kind: 'whole' },
};

describe('replay instruments', () => {
  it('read as a replay of their contract everywhere a symbol shows', () => {
    expect(replayedContract('NQZ6-R1.CME')).toBe('NQZ6.CME');
    expect(replayedContract('NQZ6-R12.CME')).toBe('NQZ6.CME');
    expect(displaySymbol('NQZ6-R3.CME')).toBe('NQ Z6 replay');
    expect(isReplay('NQZ6.CME')).toBe(false);
    expect(isReplay('BTC-USD.COINBASE')).toBe(false);
    expect(displaySymbol('NQZ6.CME')).toBe('NQ Z6');
  });
});

describe('the bars saved before a replay', () => {
  it('say nothing when they reach the replay, and name the stretch they miss or that there are none', () => {
    expect(earlierText({ kind: 'whole' })).toBeNull();
    expect(earlierText({ kind: 'missing' })).toBe('No saved bars before the replay');
    expect(
      earlierText(
        { kind: 'gap', from: nsAt('2026-10-27T21:00:00Z'), to: nsAt('2026-10-29T13:30:00Z') },
        'America/New_York',
      ),
    ).toBe('No saved bars from Tue 27 Oct, 17:00 to Thu 29 Oct, 09:30');
  });
});

describe('the replay clock', () => {
  const received = 1_000_000;

  it('runs at its speed from when the state arrived and holds while paused', () => {
    const start = Date.parse('2026-10-01T13:30:00Z');
    expect(cursorMs(globexDay, received, received + 2_000)).toBe(start + 10_000);
    expect(cursorMs({ ...globexDay, playing: false }, received, received + 60_000)).toBe(start);
  });

  it('stops at the end of the saved day', () => {
    const end = Date.parse('2026-10-01T21:00:00Z');
    expect(cursorMs(globexDay, received, received + 24 * 3_600_000)).toBe(end);
    expect(hasEnded(globexDay, received, received + 24 * 3_600_000)).toBe(true);
    expect(hasEnded(globexDay, received, received)).toBe(false);
  });
});

describe('jumping to a time of the day', () => {
  it('finds the New York time within the saved session, on either calendar day', () => {
    expect(jumpTarget(globexDay, '10:30')).toBe(nsAt('2026-10-01T14:30:00Z'));
    expect(jumpTarget(globexDay, '9:30:15')).toBe(nsAt('2026-10-01T13:30:15Z'));
    expect(jumpTarget(globexDay, '20:00')).toBe(nsAt('2026-10-01T00:00:00Z'));
  });

  it('refuses a time the day did not save or that is no time', () => {
    expect(jumpTarget(globexDay, '17:30')).toBeNull();
    expect(jumpTarget(globexDay, '24:10')).toBeNull();
    expect(jumpTarget(globexDay, 'soon')).toBeNull();
  });
});

describe('the saved days to pick from', () => {
  it('lists the charted contract first, newest day first', () => {
    const days = dayChoices(
      {
        contracts: [
          {
            instrument: 'ESZ6.CME',
            source: 'rithmic-apex',
            days: [{ tradeDate: '2026-10-01', from: 0, to: 1, prints: 10 }],
          },
          {
            instrument: 'NQZ6.CME',
            source: 'rithmic-apex',
            days: [
              { tradeDate: '2026-09-29', from: 0, to: 1, prints: 5 },
              { tradeDate: '2026-09-30', from: 0, to: 1, prints: 7 },
            ],
          },
        ],
      },
      'NQZ6.CME',
    );
    expect(days.map((d) => `${d.instrument} ${d.tradeDate}`)).toEqual([
      'NQZ6.CME 2026-09-30',
      'NQZ6.CME 2026-09-29',
      'ESZ6.CME 2026-10-01',
    ]);
  });
});
