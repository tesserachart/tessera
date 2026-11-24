import type { Instrument } from '@tessera/protocol';
import { PlatformProvider, TooltipProvider, type Platform } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClient } from './support/runtime.tsx';

const calls: string[] = [];
vi.mock('../src/workspace/controller.ts', () => ({
  setChartInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
}));
vi.mock('../src/workspace/addChart.ts', () => ({
  showInstrument: (i: string) => (calls.push(`chart ${i}`), Promise.resolve(true)),
  openChartTab: (i: string) => (calls.push(`tab ${i}`), Promise.resolve('chart-9')),
  splitWithSymbol: (i: string) => (calls.push(`split ${i}`), Promise.resolve(true)),
}));

const { SymbolPopover } = await import('../src/markets/SymbolPopover.tsx');
const { futuresRows, nextTab, popoverPlaceStore, setPopoverPlace } = await import('../src/markets/popoverModel.ts');
const { TestRuntime, seedTools, setTestServices } = await import('./support/runtime.tsx');
const { queryClient } = await import('../src/app/queries.ts');
const { toolKey } = await import('../src/app/tools.ts');
const { watchlistsStore } = await import('../src/markets/watchlists.ts');
const { areaStore } = await import('../src/areas/store.ts');
const { patch, read } = await import('../src/app/store.ts');
const { uiStore, openSymbolSearch, closeSymbolSearch } = await import('../src/state/ui.ts');
const { marketsUiStore } = await import('../src/areas/markets/store.ts');

const closed = { status: 'closed', server: null };
const client = {
  request: vi.fn(() => new Promise(() => undefined)),
  subscribe: () => () => undefined,
  state: { subscribe: () => () => undefined, getSnapshot: () => closed },
} as never;

function mount(platform: Platform = 'mac') {
  return render(
    <TestRuntime client={client}>
      <PlatformProvider value={platform}>
        <TooltipProvider>
          <SymbolPopover />
        </TooltipProvider>
      </PlatformProvider>
    </TestRuntime>,
  );
}

const fut = (id: string, root: string, expiry = '2026-12-18', front = true, exchange = 'CME'): Instrument => ({
  id,
  symbol: id.split('.')[0]!,
  name: `${root} product Dec 2026`,
  assetClass: 'future',
  exchange,
  currency: 'USD',
  root,
  expiry,
  isFront: front,
  tradable: true,
});

const options = () => screen.getAllByRole('option').map((o) => o.querySelector('.sym')?.textContent);
const input = () => screen.getByRole('combobox');

beforeEach(() => {
  calls.length = 0;
  patch(watchlistsStore, {
    value: {
      lists: [
        { id: 'main', name: 'Index futures', symbols: ['NQ', 'ES'] },
        { id: 'metals', name: 'Metals', symbols: ['GC', 'SI'] },
      ],
    },
    loaded: true,
  });
  patch(popoverPlaceStore, { tab: 'watchlist', watchlist: null });
  patch(uiStore, { recentSymbols: ['CL', 'GC'] });
  act(() => openSymbolSearch(''));
});
afterEach(() => {
  cleanup();
  act(() => closeSymbolSearch());
});

describe('the symbol popover', () => {
  it('opens on the user’s watchlist, in its order, the search focused', () => {
    mount();
    expect(input()).toBe(document.activeElement);
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Index futures');
    expect(options()).toEqual(['NQ', 'ES']);
    act(() => setPopoverPlace({ watchlist: 'metals' }));
    expect(options()).toEqual(['GC', 'SI']);
  });

  it('walks its lists with ← →: the futures say plainly when nothing lists them; the recent symbols', () => {
    mount();
    fireEvent.keyDown(input(), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('Futures');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('This runtime does not list its instruments')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'ArrowRight' });
    expect(options()).toEqual(['CL', 'GC']);
    fireEvent.keyDown(input(), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Index futures');
    expect(nextTab('watchlist', -1)).toBe('recent');
  });

  it('names its keys as the trader’s keyboard does: Enter and Ctrl off a Mac, ⏎ and ⌘ on one', () => {
    act(() => openSymbolSearch(''));
    const { unmount } = mount('other');
    expect(document.querySelector('.hint')?.textContent).toBe('Enter chart · Ctrl+Enter tab · Shift+Enter split');
    unmount();
    mount('mac');
    expect(document.querySelector('.hint')?.textContent).toBe('⏎ chart · ⌘⏎ tab · ⇧⏎ split');
  });

  it('a pick switches the chart; ⌘⏎ opens a new tab, ⇧⏎ a split; the popover closes', () => {
    mount();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(calls).toEqual(['chart ES']);
    expect(read(uiStore).symbolSearch).toBeNull();
    cleanup();
    act(() => openSymbolSearch(''));
    mount();
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(calls).toEqual(['chart ES', 'tab NQ', 'split NQ']);
  });

  it('searches as typed (a letter typed on a chart opens it with that letter), and ⏎ charts the first match', () => {
    cleanup();
    act(() => openSymbolSearch('m'));
    mount();
    expect((input() as HTMLInputElement).value).toBe('m');
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.change(input(), { target: { value: 'mes' } });
    expect(options()).toEqual(['MES']);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(calls).toEqual(['chart MES']);
  });

  it('opened for a new tab (⌘T, a pane’s +), ⏎ opens the pick as a tab', () => {
    cleanup();
    act(() => openSymbolSearch('', 'tab'));
    mount();
    expect(screen.getByRole('combobox', { name: 'Search symbols for a new chart tab' })).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(calls).toEqual(['tab NQ']);
  });

  it('does not label NQ or ES as unsaved when contract specs fail', async () => {
    cleanup();
    const failClient = {
      request: (method: string, params: { name?: string } | undefined) =>
        method === 'tools.invoke' && params?.name === 'market.get_contract_spec'
          ? Promise.resolve({ ok: false, error: { message: 'Rithmic ended the session (ForcedLogout)' } })
          : new Promise(() => undefined),
      subscribe: () => () => undefined,
      state: {
        subscribe: () => () => undefined,
        getSnapshot: () => ({
          status: 'open',
          attempt: 0,
          everConnected: true,
          server: null,
          lastError: null,
          lastErrorCode: null,
          nextRetryAt: null,
          connectedAt: 1,
          endpoint: null,
        }),
      },
    } as never;
    setTestServices(failClient);
    queryClient.clear();
    seedTools(['market.get_contract_spec']);
    render(
      <TestRuntime client={failClient}>
        <TooltipProvider>
          <SymbolPopover />
        </TooltipProvider>
      </TestRuntime>,
    );
    await vi.waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .some((q) => q.state.status === 'error'),
      ).toBe(true),
    );
    expect(screen.queryAllByText('No connection serves it')).toHaveLength(0);
    expect(options()).toEqual(['NQ', 'ES']);
    fireEvent.click(screen.getByRole('option', { name: /ES/ }));
    expect(calls).toEqual(['chart ES']);
    expect(screen.queryByText(/ForcedLogout/i)).toBeNull();
  });

  it('⏎ typed before the matches arrive opens the first match once they do; typing on drops it', async () => {
    cleanup();
    const searches = new Map<string, (answer: unknown) => void>();
    const searching: FakeClient = {
      request: (method, params: { name?: string; input?: { query?: string; limit?: number } } | undefined) =>
        method === 'tools.invoke' && params?.name === 'market.search_instruments' && params.input?.limit === 12
          ? new Promise((resolve) => searches.set(params.input?.query ?? '', resolve))
          : new Promise(() => undefined),
    };
    const answer = (query: string, ...ids: string[]) =>
      act(async () => {
        searches.get(query)?.({ ok: true, output: { results: ids.map((id) => fut(id, id.slice(0, 2))) } });
        const key = toolKey('market.search_instruments', { query, limit: 12 });
        while (queryClient.getQueryState(key)?.status === 'pending') await new Promise((r) => setTimeout(r, 0));
      });
    setTestServices(searching);
    queryClient.clear();
    seedTools(['market.search_instruments']);
    act(() => openSymbolSearch('', 'tab'));
    render(
      <TestRuntime client={searching}>
        <TooltipProvider>
          <SymbolPopover />
        </TooltipProvider>
      </TestRuntime>,
    );
    fireEvent.change(input(), { target: { value: 'ES' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(calls).toEqual([]);
    await answer('ES', 'ESZ6.CME', 'ESH7.CME');
    await vi.waitFor(() => expect(calls).toEqual(['tab ESZ6.CME']));

    calls.length = 0;
    act(() => openSymbolSearch('', 'tab'));
    fireEvent.change(input(), { target: { value: 'G' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.change(input(), { target: { value: 'GC' } });
    await answer('G', 'GCZ6.COMEX');
    await answer('GC', 'GCZ6.COMEX');
    expect(calls).toEqual([]);
  });

  it('All markets opens the Markets area on the same search', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'gold' } });
    fireEvent.click(screen.getByRole('button', { name: 'All markets' }));
    expect(read(areaStore).area).toBe('markets');
    expect(read(marketsUiStore)).toMatchObject({ query: 'gold', list: 'all' });
    expect(read(uiStore).symbolSearch).toBeNull();
  });
});

describe('the popover’s futures', () => {
  it('lists each root’s months by expiry under one heading, the front marked, each contract once', () => {
    const rows = futuresRows([
      fut('NQH7.CME', 'NQ', '2027-03-19', false),
      fut('NQZ6.CME', 'NQ', '2026-12-18', true),
      fut('ESZ6.CME', 'ES', '2026-12-18', true),
      fut('NQZ6.CME', 'NQ', '2026-12-18', true),
    ]);
    expect(rows.map((r) => [r.id, r.heading, r.name, r.front])).toEqual([
      ['ESZ6.CME', 'ES · ES product', 'Dec 2026', true],
      ['NQZ6.CME', 'NQ · NQ product', 'Dec 2026', true],
      ['NQH7.CME', null, 'Mar 2027', false],
    ]);
  });

  it('names a contract by its contract month: CL Z6 is December though it stops trading in November', () => {
    const rows = futuresRows([fut('CLZ6.NYMEX', 'CL', '2026-11-19', true, 'NYMEX')]);
    expect(rows.map((r) => r.name)).toEqual(['Dec 2026']);
  });
});
