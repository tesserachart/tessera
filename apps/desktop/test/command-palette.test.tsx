import type { Instrument } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClient } from './support/runtime.tsx';

const calls: string[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  setChartInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
}));
vi.mock('../src/workspace/addChart.ts', () => ({
  showInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
  splitWithSymbol: (i: string) => (calls.push(`split ${i}`), Promise.resolve(true)),
}));

const { CommandPalette } = await import('../src/shell/CommandPalette.tsx');
const { commands } = await import('../src/commands/registry.ts');
const { seedTools, setTestServices, TestRuntime } = await import('./support/runtime.tsx');
const { read } = await import('../src/app/store.ts');
const { queryClient } = await import('../src/app/queries.ts');
const { closePalette, openPalette, uiStore } = await import('../src/state/ui.ts');
const { patch } = await import('../src/app/store.ts');

const ES_Z6: Instrument = {
  id: 'ESZ6.CME',
  symbol: 'ESZ6',
  name: 'E-mini S&P 500 Dec 2026',
  assetClass: 'future',
  exchange: 'CME',
  currency: 'USD',
  root: 'ES',
  expiry: '2026-12-18',
  isFront: true,
  tradable: true,
};

type Answer = { ok: true; output: { results: Instrument[] } } | { ok: false; error: { message: string } };
const searches = new Map<string, (answer: Answer) => void>();
const client: FakeClient = {
  request: (method, params: { name?: string; input?: { query?: string } } | undefined) =>
    method === 'tools.invoke' && params?.name === 'market.search_instruments'
      ? new Promise((resolve) => searches.set(params.input?.query ?? '', resolve))
      : new Promise(() => undefined),
};

async function reply(answers: Record<string, Answer>) {
  act(() => {
    for (const [query, a] of Object.entries(answers)) searches.get(query)?.(a);
  });
  await waitFor(() =>
    expect(
      queryClient.isFetching({
        predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[1] === 'market.search_instruments',
      }),
    ).toBe(0),
  );
}
const found = (...results: Instrument[]): Answer => ({ ok: true, output: { results } });
const BUSY: Answer = { ok: false, error: { message: 'the runtime is busy' } };

const ran: string[] = [];
let unregister: () => void = () => undefined;

function mount() {
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <CommandPalette />
      </TooltipProvider>
    </TestRuntime>,
  );
}

const input = () => screen.getByRole('combobox');
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(input(), { key });
const highlighted = () =>
  screen
    .getAllByRole('option')
    .find((o) => o.getAttribute('aria-selected') === 'true')
    ?.querySelector('.name')?.textContent;

beforeEach(() => {
  calls.length = 0;
  ran.length = 0;
  searches.clear();
  setTestServices(client);
  queryClient.clear();
  seedTools(['market.search_instruments']);
  unregister = commands.registerAll([
    { id: 'analyst.newSession', title: 'New analyst session', group: 'Analyst', when: () => false, run: () => {} },
    {
      id: 'connections.open',
      title: 'Connections',
      group: 'General',
      run: () => void ran.push('connections'),
    },
    {
      id: 'chart.bigTrades',
      title: 'Big trades: show or hide',
      group: 'Chart',
      run: () => void ran.push('big trades'),
    },
    { id: 'tape.show', title: 'Show time & sales', group: 'View', run: () => void ran.push('time & sales') },
    {
      id: 'alerts.new',
      title: 'New alert on this chart…',
      group: 'Alerts',
      shortcut: 'alt+a',
      run: () => void ran.push('new alert'),
    },
    { id: 'settings.open', title: 'Open Settings', group: 'Settings', shortcut: 'mod+,', run: () => {} },
  ]);
  patch(uiStore, { recentCommands: [] });
  act(() => openPalette());
});
afterEach(() => {
  cleanup();
  unregister();
  act(() => closePalette());
});

describe('⌘K does what was typed', () => {
  it('Enter pressed before the symbol search answers charts that symbol, and runs no command', async () => {
    mount();
    type('ES');
    press('Enter');
    expect(ran).toEqual([]);
    expect(calls).toEqual([]);
    expect(read(uiStore).paletteOpen).toBe(true);
    await reply({ ES: found(ES_Z6) });
    expect(calls).toEqual(['chart ESZ6.CME']);
    expect(ran).toEqual([]);
    expect(read(uiStore).paletteOpen).toBe(false);
  });

  it('a symbol that lands late takes the highlight from the first command', async () => {
    mount();
    type('ES');
    expect(highlighted()).toBe('Big trades: show or hide');
    await reply({ ES: found(ES_Z6) });
    expect(highlighted()).toBe('ES Z6');
    press('Enter');
    expect(calls).toEqual(['chart ESZ6.CME']);
    expect(ran).toEqual([]);
  });

  it('a row the trader moved to keeps the highlight when symbols land above it', async () => {
    mount();
    type('ES');
    press('ArrowDown');
    expect(highlighted()).toBe('Show time & sales');
    await reply({ ES: found(ES_Z6) });
    expect(highlighted()).toBe('Show time & sales');
    press('Enter');
    expect(ran).toEqual(['time & sales']);
    expect(calls).toEqual([]);
  });

  it('a row under the trader’s pointer keeps the highlight when symbols land above it', async () => {
    mount();
    type('ES');
    fireEvent.pointerMove(screen.getByText('Show time & sales'));
    expect(highlighted()).toBe('Show time & sales');
    await reply({ ES: found(ES_Z6) });
    expect(highlighted()).toBe('Show time & sales');
  });

  it('Enter after a search that fails at once charts the typed symbol, and runs no command', async () => {
    cleanup();
    act(() => closePalette());
    const failClient: FakeClient = {
      request: (method, params: { name?: string; input?: { query?: string } } | undefined) =>
        method === 'tools.invoke' && params?.name === 'market.search_instruments'
          ? Promise.resolve({ ok: false, error: { message: 'Rithmic ended the session (ForcedLogout)' } })
          : new Promise(() => undefined),
    };
    setTestServices(failClient);
    queryClient.clear();
    seedTools(['market.search_instruments']);
    render(
      <TestRuntime client={failClient}>
        <TooltipProvider>
          <CommandPalette />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => openPalette());
    type('ES');
    await waitFor(() =>
      expect(
        queryClient.isFetching({
          predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[1] === 'market.search_instruments',
        }),
      ).toBe(0),
    );
    press('Enter');
    expect(ran).toEqual([]);
    expect(calls).toEqual(['chart ES']);
    expect(screen.queryByText(/ForcedLogout/i)).toBeNull();
  });

  it('with the runtime down, Enter charts a desk symbol and does not run a command', async () => {
    cleanup();
    act(() => closePalette());
    const downClient: FakeClient = {
      request: () => new Promise(() => undefined),
      state: {
        getSnapshot: () => ({
          status: 'reconnecting',
          attempt: 3,
          everConnected: true,
          server: null,
          lastError: null,
          lastErrorCode: null,
          nextRetryAt: null,
          connectedAt: 1,
          endpoint: null,
        }),
        subscribe: () => () => undefined,
      },
    };
    setTestServices(downClient);
    queryClient.clear();
    seedTools(['market.search_instruments']);
    render(
      <TestRuntime client={downClient}>
        <TooltipProvider>
          <CommandPalette />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => openPalette());
    type('ES');
    expect(screen.getByText('ES')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/could not reach the feed/i);
    press('Enter');
    expect(ran).toEqual([]);
    expect(calls).toEqual(['chart ES']);
  });

  it('with the runtime down, Connections plus Enter opens Connections and never charts that word', async () => {
    cleanup();
    act(() => closePalette());
    const downClient: FakeClient = {
      request: () => new Promise(() => undefined),
      state: {
        getSnapshot: () => ({
          status: 'reconnecting',
          attempt: 3,
          everConnected: true,
          server: null,
          lastError: null,
          lastErrorCode: null,
          nextRetryAt: null,
          connectedAt: 1,
          endpoint: null,
        }),
        subscribe: () => () => undefined,
      },
    };
    setTestServices(downClient);
    queryClient.clear();
    seedTools(['market.search_instruments']);
    render(
      <TestRuntime client={downClient}>
        <TooltipProvider>
          <CommandPalette />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => openPalette());
    type('Connections');
    await waitFor(() => expect(highlighted()).toBe('Connections'));
    expect(screen.getByRole('status').textContent).toMatch(/could not reach the feed/i);
    expect(screen.getByText('Enter').parentElement?.textContent).toMatch(/run/i);
    press('Enter');
    expect(ran).toEqual(['connections']);
    expect(calls).toEqual([]);
  });

  it('with the runtime down, unknown text does not become a chart instrument', async () => {
    cleanup();
    act(() => closePalette());
    const downClient: FakeClient = {
      request: () => new Promise(() => undefined),
      state: {
        getSnapshot: () => ({
          status: 'reconnecting',
          attempt: 2,
          everConnected: true,
          server: null,
          lastError: null,
          lastErrorCode: null,
          nextRetryAt: null,
          connectedAt: 1,
          endpoint: null,
        }),
        subscribe: () => () => undefined,
      },
    };
    setTestServices(downClient);
    queryClient.clear();
    seedTools(['market.search_instruments']);
    render(
      <TestRuntime client={downClient}>
        <TooltipProvider>
          <CommandPalette />
        </TooltipProvider>
      </TestRuntime>,
    );
    act(() => openPalette());
    type('ZZQX');
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not reach the feed/i));
    press('Enter');
    expect(calls.filter((c) => c.includes('ZZQX') || c.includes('Connections'))).toEqual([]);
    expect(calls.every((c) => !/^chart /i.test(c) || /^(chart ES|chart MES|chart NQ)/.test(c))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('an Enter waiting on a search that fails charts the typed symbol, and runs no command', async () => {
    mount();
    type('ES');
    press('Enter');
    act(() => {
      searches.get('ES')?.(BUSY);
    });
    await waitFor(() => expect(calls).toEqual(['chart ES']));
    expect(ran).toEqual([]);
    expect(read(uiStore).paletteOpen).toBe(false);
    expect(screen.queryByText(/ForcedLogout|os error|tools\.invoke/i)).toBeNull();
  });

  it('an Enter waiting on a search is dropped when the trader types on', async () => {
    mount();
    type('ES');
    press('Enter');
    type('ESH');
    await reply({ ES: found(ES_Z6), ESH: found() });
    expect(ran).toEqual([]);
    expect(calls).toEqual([]);
    expect(read(uiStore).paletteOpen).toBe(true);
  });
});

describe('⌘K with nothing typed', () => {
  const groups = () =>
    [...document.querySelectorAll('[cmdk-group]')].map((g) => [
      g.querySelector('[cmdk-group-heading]')?.textContent ?? '',
      [...g.querySelectorAll('[cmdk-item] .name')].map((n) => n.textContent),
    ]);

  it('lists the commands by group with their keys, and only the ones that can run now', () => {
    mount();
    expect(groups()).toEqual([
      ['View', ['Connections', 'Show time & sales']],
      ['Chart', ['Big trades: show or hide']],
      ['Alerts', ['New alert on this chart…']],
      ['Settings', ['Open Settings']],
    ]);
    const alert = screen.getByRole('option', { name: /New alert on this chart/ });
    expect(alert.querySelector('.t-key')).not.toBeNull();
    expect(highlighted()).toBe('Connections');
  });

  it('a command run from the palette leads the next one under Recent', () => {
    mount();
    fireEvent.click(screen.getByRole('option', { name: /Show time & sales/ }));
    expect(ran).toEqual(['time & sales']);
    expect(read(uiStore).recentCommands).toEqual(['tape.show']);
    act(() => openPalette());
    expect(groups()[0]).toEqual(['Recent', ['Show time & sales']]);
    expect(highlighted()).toBe('Show time & sales');
    press('Enter');
    expect(ran).toEqual(['time & sales', 'time & sales']);
  });
});
