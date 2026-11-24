import { act, cleanup, render } from '@testing-library/react';
import { memo } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { pricesStale, streamStale, useFeeds, type Feeds } from '../src/shell/freshness.ts';
import { EMPTY_SHELL_DATA, ShellDataContext, type ShellData } from '../src/shell/shellData.ts';
import { runtimeLink, type RuntimeLink } from './support/runtimeLink.ts';

let link: RuntimeLink | null = null;
afterEach(() => {
  cleanup();
  link?.client.close();
  link = null;
});

const live: Feeds = { link: { status: 'open', everConnected: true }, behindMs: 0, pricesDown: [] };

describe('how fresh the desk’s numbers are', () => {
  it('reads live while the runtime is up, the page keeps up and the prices come in', () => {
    expect(streamStale(live)).toBeNull();
    expect(pricesStale(live, 'rithmic-apex')).toBeNull();
  });

  it('reads every number stale once the runtime drops', () => {
    const dropped: Feeds = { ...live, link: { status: 'reconnecting', everConnected: true } };
    expect(streamStale(dropped)).toEqual({ trust: 'stale', words: 'Runtime dropped' });
    expect(pricesStale(dropped, 'rithmic-apex')).toEqual({ trust: 'stale', words: 'Runtime dropped' });
  });

  it('says nothing before the first connection: there is no number yet to doubt', () => {
    expect(streamStale({ ...live, link: { status: 'connecting', everConnected: false } })).toBeNull();
  });

  it('reads positions and prices behind once the page trails the runtime by 2 s, saying by how much', () => {
    expect(streamStale({ ...live, behindMs: 1000 })).toBeNull();
    expect(streamStale({ ...live, behindMs: 2_000 })).toEqual({ trust: 'behind', words: '2 s behind' });
    expect(streamStale({ ...live, behindMs: 12_000 })).toEqual({ trust: 'behind', words: '10 s behind' });
    expect(pricesStale({ ...live, behindMs: 150_000 }, 'paper')).toEqual({ trust: 'behind', words: '2 min behind' });
  });

  it('says how far behind in steps that hold still while the lag wanders, not a count that ticks every second', () => {
    const words = (ms: number) => streamStale({ ...live, behindMs: ms })?.words;
    expect(new Set([41_000, 43_000, 44_999].map(words))).toEqual(new Set(['30 s behind']));
    expect(words(45_000)).toBe('45 s behind');
    expect(new Set([61_000, 95_000, 119_999].map(words))).toEqual(new Set(['1 min behind']));
    expect(words(185_000)).toBe('3 min behind');
  });

  it('reads the prices of a connection that stopped sending them stale, and the position itself still live', () => {
    const out: Feeds = { ...live, pricesDown: ['rithmic-apex'] };
    expect(pricesStale(out, 'rithmic-apex')).toEqual({ trust: 'stale', words: 'No live prices' });
    expect(pricesStale(out, 'mock')).toBeNull();
    expect(streamStale(out)).toBeNull();
  });

  it('holds still while positions, accounts and health tick, so a chart does not redraw with every P/L', async () => {
    link = runtimeLink({});
    await link.open();
    const seen: (readonly string[])[] = [];
    const Probe = memo(function Probe() {
      seen.push(useFeeds().pricesDown);
      return null;
    });
    const desk = (data: ShellData) => (
      <ShellDataContext.Provider value={data}>
        <Probe />
      </ShellDataContext.Provider>
    );
    const view = render(desk(EMPTY_SHELL_DATA));
    const health = (pricesDown: string[]) => act(() => link!.publish('health', { providers: [], pricesDown }));
    await health([]);
    for (let tick = 1; tick <= 5; tick += 1) view.rerender(desk({ ...EMPTY_SHELL_DATA, drafts: tick }));
    await health([]);
    expect(seen).toHaveLength(1);
    await health(['rithmic-apex']);
    await health(['rithmic-apex']);
    expect(seen).toEqual([[], ['rithmic-apex']]);
  });
});
