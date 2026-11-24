import { BracketsLayer, type ChartApi } from '@tessera/chart';
import type { Position, Quote, TradingAccount } from '@tessera/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountUpdatesStore, positionsStore, usePositions } from '../src/app/portfolio.ts';
import { ChartTrading } from '../src/chart/ChartTrading.tsx';
import { quoteStore } from '../src/market/quotes.ts';
import { ShellDataProvider } from '../src/shell/ShellData.tsx';
import { EMPTY_SHELL_DATA, ShellDataContext, useShellData, type ShellData } from '../src/shell/shellData.ts';
import { accountUpdate, paperAccount } from './support/accounts.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';
import { wireOrder } from './support/orders.ts';
import { nextFrame, TestRuntime, topicFeed } from './support/runtime.tsx';

Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });

const NQ = 'NQZ6.CME';
const LAST = 20641.25;
const PAPER = paperAccount('paper-main');

const chart = {
  coords: () => ({
    plot: { x: 0, y: 0, w: 800, h: 600 },
    yOfPrice: (price: number) => 300 - (price - LAST) * 8,
    priceOfY: (y: number) => LAST + (300 - y) / 8,
    xOfTime: () => null,
    timeOfX: () => null,
    from: 0,
    to: 100,
    barSpacing: 8,
  }),
  on: () => () => undefined,
  layers: () => [],
  setViewport: () => undefined,
} as unknown as ChartApi;

const longWith = (pnl: number): Position => ({
  accountId: PAPER.id,
  instrument: NQ,
  qty: 1,
  avgPrice: 20641.5,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: { amount: pnl, currency: 'USD' },
  mark: 20641.5 + pnl / 20,
  openedAt: 0,
});

const leg = (role: 'stop_loss' | 'take_profit', price: number) =>
  wireOrder({
    role,
    parentId: 'e1',
    request: {
      side: 'sell',
      orderType: role === 'stop_loss' ? 'stop' : 'limit',
      stopPrice: role === 'stop_loss' ? price : null,
      limitPrice: role === 'take_profit' ? price : null,
      reduceOnly: true,
    },
  });

async function quoteTick(rt: FakeRuntime, pnl: number, account: TradingAccount = PAPER) {
  await act(async () => {
    rt.sub('accounts').event(accountUpdate(account, pnl));
    rt.sub('positions').event({ position: longWith(pnl) });
    await nextFrame();
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('an order tag on a ticking position', () => {
  async function desk(pnl: number) {
    const rt = fakeRuntime();
    const orders = [leg('stop_loss', 20631.5), leg('take_profit', 20661.5)];
    const shell: ShellData = {
      ...EMPTY_SHELL_DATA,
      env: 'paper',
      accounts: [PAPER],
      accountId: PAPER.id,
      allOrders: orders,
      tradingKnown: true,
    };
    const view = render(
      <ShellDataContext.Provider value={shell}>
        <ChartTrading
          chart={chart}
          layer={new BracketsLayer({ id: 'orders' })}
          layoutId="L"
          tileId="chart-1"
          instrument={NQ}
          ids={new Set([NQ])}
          spec={null}
          levels={[]}
          layers={[]}
        >
          {null}
        </ChartTrading>
      </ShellDataContext.Provider>,
    );
    act(() => {
      quoteStore.apply({ instrument: NQ, ts: 0, bid: LAST, ask: 20641.5, last: LAST } as Quote);
      quoteStore.notifyNow();
    });
    await quoteTick(rt, pnl);
    const entry = () => view.container.querySelector<HTMLElement>('[data-testid=tag-entry]')!;
    return { rt, entry };
  }

  it('measures no tag when a tick moves only its P/L, and measures the one tag whose text changes width', async () => {
    const measured = vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return { width: this.toString().length * 7 } as DOMRect;
    });
    const { rt, entry } = await desk(-5);
    expect(entry().textContent).toContain('−$5');
    expect(measured).toHaveBeenCalled();
    measured.mockClear();

    await quoteTick(rt, -7);
    expect(entry().textContent).toContain('−$7');
    expect(measured).not.toHaveBeenCalled();

    await quoteTick(rt, -15);
    expect(entry().textContent).toContain('−$15');
    expect(measured).toHaveBeenCalledTimes(1);
  });
});

describe('the desk on a ticking position', () => {
  function mount() {
    const shells: ShellData[] = [];
    const lives: (Position[] | null)[] = [];
    function Desk() {
      shells.push(useShellData());
      return null;
    }
    function Positions() {
      lives.push(usePositions());
      return null;
    }
    const rt = fakeRuntime();
    const feed = topicFeed();
    render(
      <TestRuntime client={{ subscribe: feed.subscribe, request: () => new Promise(() => undefined) }}>
        <ShellDataProvider>
          <Desk />
          <Positions />
        </ShellDataProvider>
      </TestRuntime>,
    );
    return { rt, feed, shells, lives };
  }

  it('re-renders nothing that reads the shell’s data when a tick moves only P/L, and shows the P/L once a frame', async () => {
    const { feed, shells, lives } = mount();
    const tick = async (pnl: number, account: TradingAccount = PAPER) => {
      await act(async () => {
        feed.push('accounts', accountUpdate(account, pnl));
        feed.push('positions', { position: longWith(pnl) });
        await nextFrame();
      });
    };
    await tick(-5);
    expect(shells.at(-1)!.accounts.map((a) => a.displayName)).toEqual(['Paper']);
    const shellRenders = shells.length;
    const liveRenders = lives.length;

    await act(async () => {
      for (const pnl of [-6, -7, -8, -9, -10]) {
        feed.push('accounts', accountUpdate(PAPER, pnl));
        feed.push('positions', { position: longWith(pnl) });
      }
      await nextFrame();
    });
    expect(shells.length).toBe(shellRenders);
    expect(lives.length).toBe(liveRenders + 1);
    expect(lives.at(-1)?.[0]?.unrealizedPnl?.amount).toBe(-10);

    await tick(-11, { ...PAPER, displayName: 'Paper (renamed)' });
    expect(shells.length).toBe(shellRenders + 1);
    expect(shells.at(-1)!.accounts.map((a) => a.displayName)).toEqual(['Paper (renamed)']);
  });
});

describe('the position and account streams', () => {
  it('tell their readers once a frame, however many ticks arrive in it, with the newest values', async () => {
    const rt = fakeRuntime();
    const positions: number[] = [];
    const accounts: number[] = [];
    const offPositions = positionsStore.subscribe((list) => positions.push(list?.[0]?.unrealizedPnl?.amount ?? 0));
    const offAccounts = accountUpdatesStore.subscribe((list) => accounts.push(list?.[0]?.summary.openPnl.amount ?? 0));
    for (const pnl of [-5, -6, -7, -8]) {
      rt.sub('accounts').event(accountUpdate(PAPER, pnl));
      rt.sub('positions').event({ position: longWith(pnl) });
    }
    expect([positions, accounts]).toEqual([[], []]);
    expect(positionsStore.getState()?.[0]?.unrealizedPnl?.amount).toBe(-8);
    await nextFrame();
    expect([positions, accounts]).toEqual([[-8], [-8]]);
    offPositions();
    offAccounts();
  });
});
