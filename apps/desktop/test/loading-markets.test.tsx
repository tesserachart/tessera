import type { Instrument, Quote } from '@tessera/protocol';
import { PlatformProvider } from '@tessera/ui';
import { act, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../src/app/queries.ts';
import { patch } from '../src/app/store.ts';
import { MarketsPage } from '../src/areas/markets/MarketsPage.tsx';
import { DEFAULT_PLACE, marketsUiStore, setMarketsPlace } from '../src/areas/markets/store.ts';
import { popoverPlaceStore } from '../src/markets/popoverModel.ts';
import { SymbolPopover } from '../src/markets/SymbolPopover.tsx';
import { watchlistsStore } from '../src/markets/watchlists.ts';
import { openSymbolSearch, closeSymbolSearch, uiStore } from '../src/state/ui.ts';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  settle,
  SIM,
  unmountSurface,
  visibleText,
  type HeldReads,
} from './support/loading.tsx';

const LISTED = (
  SIM.tools['market.list_instruments']![0]!.output as { connections: { instruments: Instrument[] }[] }
).connections.flatMap((c) => c.instruments);
const SPEC = SIM.tools['market.get_contract_spec']![0]!.output as {
  instrument: Instrument;
  spec: { instrument: string };
};
const QUOTES = SIM.topics['market.quotes'] as Quote[];
const ROOTS: Record<string, string> = { NQ: 'NQZ6.CME', ES: 'ESZ6.CME' };

const contractFor = (input: { instrument: string }) => {
  const id = ROOTS[input.instrument] ?? input.instrument;
  const listed = LISTED.find((i) => i.id === id) ?? { ...SPEC.instrument, id, symbol: id };
  return { instrument: listed, spec: { ...SPEC.spec, instrument: id } } as never;
};
const quoteFor = (input: { instrument: string }): Quote => {
  const id = ROOTS[input.instrument] ?? input.instrument;
  return { ...(QUOTES.find((q) => q.instrument === id) ?? QUOTES[0]!), instrument: id };
};
const searchFor = (input: { query: string; limit?: number | undefined }) => {
  const q = input.query.toLowerCase();
  const results = LISTED.filter((i) => i.id.toLowerCase().includes(q) || i.symbol.toLowerCase().includes(q));
  return { results: results.slice(0, input.limit ?? 5) };
};
const ANSWERS = {
  'market.get_contract_spec': contractFor,
  'market.get_quote': quoteFor,
  'market.search_instruments': searchFor,
};
const TOOLS = [
  'market.list_instruments',
  'market.get_contract_spec',
  'market.get_quote',
  'market.get_sessions',
  'market.search_instruments',
];

class DisplayNoneObserver {
  private readonly watched = new Set<Element>();
  private readonly mutations: MutationObserver;
  constructor(private readonly report: IntersectionObserverCallback) {
    this.mutations = new MutationObserver(() => this.send());
    this.mutations.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
  }
  observe(el: Element) {
    this.watched.add(el);
    queueMicrotask(() => this.send());
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
    this.mutations.disconnect();
  }
  private send() {
    const entries = [...this.watched].map((target) => ({ target, isIntersecting: !target.closest('.hidden') }));
    this.report(entries as IntersectionObserverEntry[], this as never);
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', DisplayNoneObserver);
  queryClient.clear();
  patch(marketsUiStore, DEFAULT_PLACE);
  patch(watchlistsStore, { value: { lists: [{ id: 'main', name: 'Watchlist', symbols: ['NQ', 'ES'] }] } });
});
afterEach(() => {
  unmountSurface();
  vi.unstubAllGlobals();
  closeSymbolSearch();
});

const held = () => heldReads(SIM, ANSWERS);

function mount(held: HeldReads, surface: ReactNode) {
  return mountSurface(held.client, <PlatformProvider value="other">{surface}</PlatformProvider>, { tools: TOOLS });
}

const optionNames = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label') ?? o.textContent);

describe('Markets loads as one piece', () => {
  it('lists every market with its name, quote and session at once', async () => {
    const reads = held();
    const { container } = mount(reads, <MarketsPage />);
    const { loading, loaded } = await expectLoadsInOneGo(reads, () => container);
    expect(loading).not.toMatch(/Symbol|No connection|Mock market|NQ|Closed/);
    expect(loaded).toContain('Mock market');
    expect(loaded).not.toContain('No connection lists instruments here.');
    expect(optionNames()).toHaveLength(LISTED.length);
    for (const row of screen.getAllByRole('option')) {
      expect(row.querySelector('.c-last')?.textContent, row.getAttribute('aria-label') ?? '').not.toBe('');
      expect(row.querySelector('.c-sess')?.textContent, row.getAttribute('aria-label') ?? '').not.toBe('');
    }
    expect(screen.queryByRole('status', { name: 'Loading markets' })).toBeNull();
  });

  it('shows a watchlist of root symbols, resolved and named, at once', async () => {
    setMarketsPlace({ list: 'watchlist' });
    const reads = held();
    const { container } = mount(reads, <MarketsPage />);
    const { loading, loaded } = await expectLoadsInOneGo(reads, () => container);
    expect(loading).not.toMatch(/No symbols yet|NQ|ES/);
    expect(optionNames()).toEqual(['NQ Z6', 'ES Z6']);
    expect(loaded).not.toContain('No symbols yet');
    for (const row of screen.getAllByRole('option')) {
      expect(row.querySelector('.c-last')?.textContent).not.toBe('');
      expect(row.querySelector('.nm')?.textContent).not.toBe('');
    }
  });

  it('brings the detail pane of a selected market in with the page', async () => {
    setMarketsPlace({ instrument: 'NQZ6.CME' });
    const reads = held();
    const { container } = mount(reads, <MarketsPage />);
    const { loading, loaded } = await expectLoadsInOneGo(reads, () => container);
    expect(loading).not.toMatch(/Tick|Exchange|Select a market/);
    const detail = screen.getByRole('region', { name: /details$/ });
    expect(detail.textContent).toMatch(/Tick/);
    expect(detail.textContent).toMatch(/Session/);
    expect(detail.textContent).toMatch(/Hours/);
    expect(loaded).not.toContain('Select a market');
  });

  it('fills the detail pane in one go when another market is picked', async () => {
    const reads = held();
    const { container } = mount(reads, <MarketsPage />);
    await expectLoadsInOneGo(reads, () => container);
    act(() => setMarketsPlace({ instrument: 'GCZ6.COMEX' }));
    await settle();
    const states = new Set<string>();
    const note = () => {
      const text = visibleText(container.querySelector('.mk-side')!);
      const whole = ['Tick', 'Hours', 'Volume', 'Prior close'].every((word) => text.includes(word));
      states.add(whole ? 'whole' : text === '' ? 'none' : `partial: ${text}`);
    };
    note();
    while (reads.waiting > 0) {
      await act(async () => {
        reads.answerNext();
        await Promise.resolve();
      });
      await settle();
      note();
    }
    expect([...states].sort()).toEqual(['none', 'whole']);
  });

  it('never says no market matches while the search is still out', async () => {
    const reads = held();
    const { container } = mount(reads, <MarketsPage />);
    await expectLoadsInOneGo(reads, () => container);
    act(() => setMarketsPlace({ query: 'zzzz' }));
    await settle();
    expect(reads.waiting).toBeGreaterThan(0);
    expect(visibleText(container)).not.toContain('No market matches');
    while (reads.waiting > 0) {
      await act(async () => {
        reads.answerNext();
        await Promise.resolve();
      });
      await settle();
    }
    expect(visibleText(container)).toContain('No market matches “zzzz”.');
  });
});

describe('the symbol popover loads its rows as one piece', () => {
  beforeEach(() => {
    patch(popoverPlaceStore, { tab: 'watchlist', watchlist: null });
    patch(uiStore, { recentSymbols: [] });
    act(() => openSymbolSearch(''));
  });

  it('shows the watchlist rows, price and brief at once', async () => {
    const reads = held();
    const { container } = mount(reads, <SymbolPopover />);
    const { loading, loaded } = await expectLoadsInOneGo(reads, () => container);
    expect(loading).not.toMatch(/NQ|ES|tick/);
    expect(loaded).toContain('NQ');
    expect(loaded).toMatch(/tick 0\.25/);
    for (const row of screen.getAllByRole('option')) {
      expect(row.querySelector('.t-price')?.textContent).not.toBe('');
      expect(row.querySelector('.chg')?.textContent).not.toBe('');
    }
    expect(screen.queryByRole('status', { name: 'Loading symbols' })).toBeNull();
  });

  it('never claims there are no matches while the remote search is out, then lists the hits complete', async () => {
    const reads = held();
    const { container } = mount(reads, <SymbolPopover />);
    await expectLoadsInOneGo(reads, () => container);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mnq' } });
    const typed = await expectLoadsInOneGo(reads, () => container);
    expect(typed.loading).not.toMatch(/No symbol matches|MNQ/);
    expect(typed.loaded).toContain('MNQ');
    for (const row of screen.getAllByRole('option')) expect(row.querySelector('.chg')?.textContent).not.toBe('');
  });

  it('says no symbol matches only once the search has answered', async () => {
    const reads = held();
    const { container } = mount(reads, <SymbolPopover />);
    await expectLoadsInOneGo(reads, () => container);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qqqqq' } });
    const typed = await expectLoadsInOneGo(reads, () => container);
    expect(typed.loading).not.toContain('No symbol matches');
    expect(typed.loaded).toContain('No symbol matches “qqqqq”');
  });
});
