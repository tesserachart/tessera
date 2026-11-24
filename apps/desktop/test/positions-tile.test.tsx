import {
  createStore,
  type ConnectionState,
  type Fill,
  type Money,
  type Position,
  type TradingAccount,
} from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../src/app/queries.ts';
import { EMPTY_SHELL_DATA, ShellDataContext, type ShellData } from '../src/shell/shellData.ts';
import { PositionsTile } from '../src/workspace/tiles/PositionsTile.tsx';
import {
  answeringClient,
  CONNECTED,
  nextFrame,
  seedTools,
  setTestServices,
  TestRuntime,
  topicFeed,
  type TopicFeed,
} from './support/runtime.tsx';

afterEach(() => {
  cleanup();
  queryClient.clear();
});

const NQ = 'NQZ6.CME';
const OPENED_MS = Date.parse('2026-10-02T09:30:00-04:00');
const usd = (amount: number): Money => ({ amount, currency: 'USD' });

function todaysFills(n: number): Fill[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `fill-${String(i)}`,
    brokerFillId: null,
    orderId: null,
    accountId: 'paper-main',
    instrument: NQ,
    side: i % 2 === 0 ? 'buy' : 'sell',
    qty: 1,
    price: 20_000 + i * 0.25,
    ts: (OPENED_MS + i * 1_000) * 1e6,
    fee: usd(0),
    realizedPnl: i % 2 === 0 ? null : usd(5),
    source: 'paper',
  }));
}

const PAPER = { id: 'paper-main', displayName: 'Paper', environment: 'paper' } as TradingAccount;
const DESK: ShellData = { ...EMPTY_SHELL_DATA, accounts: [PAPER], tradingKnown: true };

const longAt = (mark: number): Position => ({
  accountId: 'paper-main',
  instrument: NQ,
  qty: 1,
  avgPrice: 19_995,
  realizedPnl: usd(0),
  unrealizedPnl: usd((mark - 19_995) * 20),
  mark,
  openedAt: OPENED_MS * 1e6,
});

function runtimeWithFills(n: number, feed: TopicFeed) {
  const { client } = answeringClient({ 'portfolio.get_fills': () => ({ fills: todaysFills(n) }) });
  const live = { ...client, subscribe: feed.subscribe };
  setTestServices(live);
  seedTools(['portfolio.get_fills']);
  return live;
}

const tileProps = {
  api: { id: 'positions', getParameters: () => ({}), updateParameters: () => undefined },
} as unknown as IDockviewPanelProps;

type FormatGetter = { format: unknown };

async function formattingOnOneTick(fills: number): Promise<number> {
  const feed = topicFeed({ positions: [{ position: longAt(19_990.25) }] });
  const client = runtimeWithFills(fills, feed);
  render(
    <TestRuntime client={client}>
      <ShellDataContext.Provider value={DESK}>
        <PositionsTile {...tileProps} />
      </ShellDataContext.Provider>
    </TestRuntime>,
  );
  await screen.findByText(`Fills today · ${String(fills)}`);
  await screen.findByText('19,990.25');
  const formatting = [
    vi.spyOn(Intl.NumberFormat.prototype as FormatGetter, 'format', 'get'),
    vi.spyOn(Intl.DateTimeFormat.prototype as FormatGetter, 'format', 'get'),
    vi.spyOn(Date.prototype, 'toLocaleTimeString'),
    vi.spyOn(Date.prototype, 'toLocaleString'),
  ];
  await act(async () => {
    feed.push('positions', { position: longAt(19_990.75) });
    await nextFrame();
  });
  expect(screen.getByText('19,990.75')).toBeTruthy();
  const calls = formatting.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  for (const spy of formatting) spy.mockRestore();
  cleanup();
  queryClient.clear();
  return calls;
}

describe('the Positions tile on a ticking market', () => {
  it('shows today’s fills newest first, each with its New York time and what it realized', async () => {
    const client = runtimeWithFills(2, topicFeed({ positions: [{ position: longAt(19_990.25) }] }));
    render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={DESK}>
          <PositionsTile {...tileProps} />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    await screen.findByText('Fills today · 2');
    await screen.findByText('Open · 1');
    const rows = [...document.querySelectorAll('tbody')].at(-1)!.querySelectorAll('tr:not(.pz-cols)');
    expect([...rows].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))).toEqual([
      ['NQ Z6', 'Sold 1', '20,000.25', '09:30:01', '', '+$5.00', 'Paper', ''],
      ['NQ Z6', 'Bought 1', '20,000.00', '09:30:00', '', '—', 'Paper', ''],
    ]);
  });

  it('does the same work on a tick with thirty fills today as with one', async () => {
    const one = await formattingOnOneTick(1);
    const many = await formattingOnOneTick(30);
    expect(one).toBeGreaterThan(0);
    expect(many).toBe(one);
  });
});

const long2: Position = {
  accountId: 'paper-main',
  instrument: NQ,
  qty: 2,
  avgPrice: 20_603,
  realizedPnl: usd(0),
  unrealizedPnl: usd(130),
  mark: 20_616,
  openedAt: 0,
};

async function mount() {
  const state = createStore<ConnectionState>(CONNECTED);
  const behind = createStore(0);
  const { subscribe } = topicFeed({ positions: [{ position: long2 }] });
  const { container } = render(
    <TestRuntime client={{ state, behind, subscribe }}>
      <TooltipProvider>
        <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, tradingKnown: true }}>
          <PositionsTile {...tileProps} />
        </ShellDataContext.Provider>
      </TooltipProvider>
    </TestRuntime>,
  );
  await screen.findByText('Open · 1');
  const row = () =>
    [...container.querySelectorAll('.pz-table tbody tr:not(.pz-cols)')].find((r) => !r.closest('[role="status"]'))!;
  return { state, behind, row };
}

describe('open positions, when their numbers are old', () => {
  it('read live while the runtime is up and the page keeps up', async () => {
    const { row } = await mount();
    expect(screen.getByText('Open · 1')).toBeTruthy();
    expect(row().textContent).toContain('Long 2');
    expect(row().getAttribute('data-trust')).toBeNull();
  });

  it('read stale, and say why on their group, once the runtime drops', async () => {
    const { state, row } = await mount();
    act(() => state.set({ ...CONNECTED, status: 'reconnecting', connectedAt: null }));
    expect(screen.getByText('Open · 1 · Runtime dropped')).toBeTruthy();
    expect(row().getAttribute('data-trust')).toBe('stale');
    act(() => state.set(CONNECTED));
    expect(screen.getByText('Open · 1')).toBeTruthy();
    expect(row().getAttribute('data-trust')).toBeNull();
  });

  it('read behind, saying by how much, while the page trails the runtime', async () => {
    const { behind, row } = await mount();
    act(() => behind.set(150_000));
    expect(screen.getByText('Open · 1 · 2 min behind')).toBeTruthy();
    expect(row().getAttribute('data-trust')).toBe('behind');
    act(() => behind.set(0));
    expect(row().getAttribute('data-trust')).toBeNull();
  });
});
