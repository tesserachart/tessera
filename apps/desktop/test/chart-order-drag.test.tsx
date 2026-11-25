import { BracketsLayer, type ChartApi } from '@tessera/chart';
import type { Order, Position, Quote, TradingAccount } from '@tessera/protocol';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { ChartTrading } from '../src/chart/ChartTrading.tsx';
import { chartToasts } from '../src/chart/chartNotice.ts';
import { beginPlacement } from '../src/chart/placement.ts';
import { quoteStore } from '../src/market/quotes.ts';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { endPlacement, placementStore, startPlacement } from '../src/state/placement.ts';
import { ticketsStore } from '../src/state/tickets.ts';
import { rememberOco, tradeSettingsStore } from '../src/state/tradeSettings.ts';
import { DEFAULT_OCO } from '../src/shell/oco.ts';
import { accountUpdate, paperAccount } from './support/accounts.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { wireOrder } from './support/orders.ts';
import { actPause } from './support/pause.ts';
import { nextFrame } from './support/runtime.tsx';

Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });

const NQ = 'NQZ6.CME';
const LAST = 20641.25;
const yOf = (price: number) => 300 - (price - LAST) * 8;
const tile = { layoutId: 'L', tileId: 'chart-1' };

const chart = {
  coords: () => ({
    plot: { x: 0, y: 0, w: 800, h: 600 },
    yOfPrice: yOf,
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

const paper = accountUpdate(paperAccount('paper-main'));

const long: Position = {
  accountId: 'paper-main',
  instrument: NQ,
  qty: 1,
  avgPrice: 20641.5,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: { amount: -5, currency: 'USD' },
  mark: LAST,
  openedAt: 0,
};

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

async function desk(others: { accounts: TradingAccount[]; orders: Order[] } = { accounts: [], orders: [] }) {
  const rt = fakeRuntime();
  const orders = [leg('stop_loss', 20631.5), leg('take_profit', 20661.5), ...others.orders];
  const shell = {
    ...EMPTY_SHELL_DATA,
    env: 'paper' as const,
    accounts: [paper.account, ...others.accounts],
    accountId: paper.account.id,
    allOrders: orders,
    tradingKnown: true,
  };
  const view = render(
    <ShellDataContext.Provider value={shell}>
      <ChartTrading
        chart={chart}
        layer={new BracketsLayer({ id: 'orders' })}
        layoutId={tile.layoutId}
        tileId={tile.tileId}
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
  await act(async () => {
    rt.sub('accounts').event(paper);
    rt.sub('positions').event({ position: long });
    await nextFrame();
  });
  const stop = () => view.container.querySelector<HTMLElement>('[data-testid=tag-stop]')!;
  const hint = () => view.container.querySelector('.ct-hint')?.textContent ?? null;
  const host = () => view.container.querySelector<HTMLElement>('.chart-trade')!;
  return { rt, stop, hint, host };
}

const chartMenu = () => document.querySelector('[aria-label="Chart menu"]');
const rightClick = (el: Element, y: number) => {
  fireEvent.pointerDown(el, { button: 2, buttons: 2, pointerId: 2, clientX: 400, clientY: y });
  fireEvent.contextMenu(el, { button: 2, clientX: 400, clientY: y });
};

const said = () =>
  chartToasts(tile)
    .getSnapshot()
    .filter((t) => t.state === 'open')
    .map((t) => [t.title, t.detail].filter(Boolean).join(' · '));

afterEach(() => {
  cleanup();
  chartToasts(tile).clear();
  endPlacement();
  patch(tradeSettingsStore, { lastOco: {} });
});

describe('another account’s working orders on the chart', () => {
  it('shows them dimmed under the account’s name, and a click puts the ticket on that account', async () => {
    const paper2 = paperAccount('paper-2', 'Paper 2');
    const entry = wireOrder({
      id: 'p2-entry',
      request: { accountId: 'paper-2', side: 'buy', orderType: 'limit', limitPrice: 20543 },
    });
    const stop = wireOrder({
      role: 'stop_loss',
      parentId: 'p2-entry',
      status: 'held',
      request: { accountId: 'paper-2', side: 'sell', orderType: 'stop', stopPrice: 20533, reduceOnly: true },
    });
    const { host } = await desk({ accounts: [paper2], orders: [entry, stop] });
    const theirs = [...host().querySelectorAll<HTMLElement>('.ct-tag.is-elsewhere')];
    expect(theirs.map((t) => t.textContent)).toEqual([
      expect.stringMatching(/^Paper 2 · Buy limit 1 · 20,543\.00/),
      expect.stringMatching(/^Paper 2 · SL 20,533\.00/),
    ]);
    expect(theirs[0]!.getAttribute('aria-label')).toMatch(/: trade on Paper 2$/);
    expect(theirs.every((t) => t.querySelector('.x, .grip') === null)).toBe(true);
    expect(host().querySelectorAll('.ct-tag:not(.is-elsewhere)')).toHaveLength(3);
    fireEvent.click(theirs[0]!);
    expect(read(ticketsStore).tickets[tile.tileId]?.accountId).toBe('paper-2');
  });
});

describe('dragging a position’s stop on the chart', () => {
  it('says while dragging that a stop through the market would stop out, and sends nothing when let go there', async () => {
    const { rt, stop, hint } = await desk();
    expect(stop().textContent).toContain('SL 20,631.50');
    fireEvent.pointerDown(stop(), { button: 0, pointerId: 1, clientY: yOf(20631.5) });
    fireEvent.pointerMove(stop(), { pointerId: 1, clientY: yOf(20638) });
    expect(hint()).toBeNull();
    expect(stop().classList.contains('is-refused')).toBe(false);
    fireEvent.pointerMove(stop(), { pointerId: 1, clientY: yOf(20645) });
    expect(hint()).toBe('Stop 20,645.00 is above the market (20,641.25): it would stop out at once');
    expect(stop().classList.contains('is-refused')).toBe(true);
    fireEvent.pointerUp(stop(), { pointerId: 1, clientY: yOf(20645) });
    expect(rt.toolCalls('orders.modify')).toHaveLength(0);
    expect(stop().textContent).toContain('SL 20,631.50');
    expect(stop().classList.contains('is-moving')).toBe(false);
    expect(hint()).toBeNull();
    expect(said()).toEqual([
      'Not sent · Paper · Stop 20,645.00 is above the market (20,641.25): it would stop out at once',
    ]);
  });

  it('moves a stop let go on its side of the market', async () => {
    const { rt, stop, hint } = await desk();
    fireEvent.pointerDown(stop(), { button: 0, pointerId: 1, clientY: yOf(20631.5) });
    fireEvent.pointerMove(stop(), { pointerId: 1, clientY: yOf(20636) });
    fireEvent.pointerUp(stop(), { pointerId: 1, clientY: yOf(20636) });
    expect(hint()).toBeNull();
    expect(rt.toolCalls('orders.modify').map((c) => c.input)).toEqual([
      expect.objectContaining({ accountId: 'paper-main', stopPrice: 20636 }),
    ]);
  });
});

describe('a right-click drops the order in hand', () => {
  const grab = (stop: HTMLElement) => {
    fireEvent.pointerDown(stop, { button: 0, buttons: 1, pointerId: 1, clientY: yOf(20631.5) });
    fireEvent.pointerMove(stop, { buttons: 1, pointerId: 1, clientY: yOf(20636) });
  };

  it('a right press while dragging the stop sends nothing, puts the stop back, and opens no menu', async () => {
    const { rt, stop } = await desk();
    grab(stop());
    expect(stop().textContent).toContain('SL 20,636.00');
    act(() => {
      const at = { bubbles: true, cancelable: true, pointerId: 1, clientY: yOf(20636) };
      stop().dispatchEvent(new PointerEvent('pointermove', { ...at, button: 2, buttons: 3 }));
      stop().dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, buttons: 2 }));
    });
    fireEvent.contextMenu(stop(), { button: 2, clientX: 400, clientY: yOf(20636) });
    expect(rt.toolCalls('orders.modify')).toHaveLength(0);
    expect(stop().textContent).toContain('SL 20,631.50');
    expect(chartMenu()).toBeNull();
  });

  it('a menu key or a press that opens the menu at once drops the drag the same way', async () => {
    const { rt, stop } = await desk();
    grab(stop());
    fireEvent.contextMenu(stop(), { button: 2, clientX: 400, clientY: yOf(20636) });
    fireEvent.pointerUp(stop(), { button: 0, pointerId: 1, clientY: yOf(20636) });
    expect(rt.toolCalls('orders.modify')).toHaveLength(0);
    expect(stop().textContent).toContain('SL 20,631.50');
    expect(chartMenu()).toBeNull();
  });

  it('with nothing in hand a right-click opens the chart menu', async () => {
    const { host } = await desk();
    rightClick(host(), 300);
    expect(chartMenu()).not.toBeNull();
  });

  it('a right press on the chart ends its placement: no menu, and a later click sends nothing', async () => {
    const { rt, host } = await desk();
    const arm = () =>
      act(() =>
        startPlacement(
          beginPlacement({
            accountId: 'paper-main',
            environment: 'paper',
            instrument: NQ,
            symbol: 'NQ Z6',
            side: 'buy',
            qty: 1,
            kind: 'limit',
            tick: 0.25,
            decimals: 2,
            mode: 'qty',
            risk: 250,
            tickValue: 5,
            stopTicks: null,
            targetTicks: null,
            ...tile,
          }),
        ),
      );
    const click = () => fireEvent.pointerDown(host(), { button: 0, buttons: 1, clientX: 400, clientY: yOf(20630) });

    arm();
    click();
    await vi.waitFor(() => expect(rt.toolCalls('orders.submit')).toHaveLength(1));

    arm();
    rightClick(document.body, 300);
    expect(read(placementStore).placing).not.toBeNull();
    rightClick(host(), 300);
    expect(read(placementStore).placing).toBeNull();
    expect(chartMenu()).toBeNull();
    click();
    await actPause();
    expect(rt.toolCalls('orders.submit')).toHaveLength(1);
  });
});

const menuItem = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[aria-label="Chart menu"] [role=menuitem]')].find((el) =>
    el.textContent.startsWith(text),
  );

describe('the chart menu’s Place limit', () => {
  it('sends a plain limit with no stop or target, even with the trade panel’s bracket on', async () => {
    act(() =>
      rememberOco('paper-main|NQ', {
        ...DEFAULT_OCO,
        on: true,
        stop: { on: true, unit: 'ticks', value: 40 },
        target: { on: true, unit: 'ticks', value: 80 },
      }),
    );
    const { rt, host } = await desk();
    rightClick(host(), yOf(20620));
    const item = menuItem('Buy limit 1 @ 20,620.00');
    expect(item?.textContent).toBe('Buy limit 1 @ 20,620.00no bracket');
    fireEvent.click(item!);
    await vi.waitFor(() => expect(rt.toolCalls('orders.submit')).toHaveLength(1));
    const sent = rt.toolCalls('orders.submit')[0]!.input as Record<string, unknown>;
    expect(sent).toMatchObject({ orderType: 'limit', limitPrice: 20620, side: 'buy', qty: 1 });
    expect(sent.bracket ?? null).toBeNull();
  });

  it('with no bracket saved, sends a plain stop', async () => {
    const { rt, host } = await desk();
    rightClick(host(), yOf(20660));
    fireEvent.click(menuItem('Buy stop 1 @ 20,660.00')!);
    await vi.waitFor(() => expect(rt.toolCalls('orders.submit')).toHaveLength(1));
    const sent = rt.toolCalls('orders.submit')[0]!.input as Record<string, unknown>;
    expect(sent).toMatchObject({ orderType: 'stop', stopPrice: 20660 });
    expect(sent.bracket ?? null).toBeNull();
  });
});

describe('dragging a working limit on the chart', () => {
  const entryTag = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('[data-testid=tag-entry]')].find((t) =>
      t.textContent.includes('Buy limit'),
    )!;
  const dragBy = (el: HTMLElement, from: number, to: number) => {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientY: yOf(from) });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: yOf(to) });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: yOf(to) });
  };

  it('moves a plain limit dragged by its tag', async () => {
    const entry = wireOrder({ id: 'plain', request: { side: 'buy', orderType: 'limit', limitPrice: 20620 } });
    const { rt, host } = await desk({ accounts: [], orders: [entry] });
    dragBy(entryTag(host()), 20620, 20624);
    await vi.waitFor(() =>
      expect(rt.toolCalls('orders.modify').map((c) => c.input)).toEqual([
        { accountId: 'paper-main', orderId: 'plain', limitPrice: 20624 },
      ]),
    );
    expect(rt.toolCalls('orders.submit')).toHaveLength(0);
  });

  it('moves a plain limit dragged by its line', async () => {
    const entry = wireOrder({ id: 'plain', request: { side: 'buy', orderType: 'limit', limitPrice: 20620 } });
    const { rt, host } = await desk({ accounts: [], orders: [entry] });
    const line = [...host().querySelectorAll<HTMLElement>('.ct-edge[data-part=entry]')].find(
      (el) => Math.abs(parseFloat(el.style.top) - yOf(20620)) < 20,
    )!;
    dragBy(line, 20620, 20617);
    await vi.waitFor(() =>
      expect(rt.toolCalls('orders.modify').map((c) => c.input)).toEqual([
        { accountId: 'paper-main', orderId: 'plain', limitPrice: 20617 },
      ]),
    );
  });

  it('moves a bracketed entry, not its target', async () => {
    const entry = wireOrder({
      id: 'entry',
      request: { side: 'buy', orderType: 'limit', limitPrice: 20620, bracket: { stopLoss: 20610, takeProfit: 20635 } },
    });
    const legs = [
      wireOrder({
        role: 'stop_loss',
        parentId: 'entry',
        status: 'held',
        request: { side: 'sell', orderType: 'stop', stopPrice: 20610, reduceOnly: true },
      }),
      wireOrder({
        role: 'take_profit',
        parentId: 'entry',
        status: 'held',
        request: { side: 'sell', orderType: 'limit', limitPrice: 20635, reduceOnly: true },
      }),
    ];
    const { rt, host } = await desk({ accounts: [], orders: [entry, ...legs] });
    dragBy(entryTag(host()), 20620, 20624);
    await vi.waitFor(() =>
      expect(rt.toolCalls('orders.modify').map((c) => c.input)).toEqual([
        { accountId: 'paper-main', orderId: 'entry', limitPrice: 20624 },
      ]),
    );
  });
});

describe('a drag whose send is still on its way', () => {
  const sendStopTo = (stop: HTMLElement, price: number) => {
    fireEvent.pointerDown(stop, { button: 0, pointerId: 1, clientY: yOf(20631.5) });
    fireEvent.pointerMove(stop, { pointerId: 1, clientY: yOf(price) });
    fireEvent.pointerUp(stop, { pointerId: 1, clientY: yOf(price) });
  };

  it('leaves a newer drag alone when its answer comes back, after Esc or arrow keys took the tag', async () => {
    const { rt, stop } = await desk();
    sendStopTo(stop(), 20636);
    await vi.waitFor(() => expect(rt.toolCalls('orders.modify')).toHaveLength(1));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.pointerDown(stop(), { button: 0, pointerId: 2, clientY: yOf(20631.5) });
    fireEvent.pointerMove(stop(), { pointerId: 2, clientY: yOf(20634) });
    expect(stop().textContent).toContain('SL 20,634.00');
    await act(async () => {
      rt.pending('orders.modify').fail('rejected', 'The broker refused the change');
      await actPause();
    });
    expect(stop().textContent).toContain('SL 20,634.00');
    fireEvent.pointerUp(stop(), { pointerId: 2, clientY: yOf(20634) });
    await vi.waitFor(() => expect(rt.toolCalls('orders.modify')).toHaveLength(2));
  });

  it('leaves a tag moved by the keyboard alone when the send it replaced answers', async () => {
    const { rt, stop } = await desk();
    sendStopTo(stop(), 20636);
    await vi.waitFor(() => expect(rt.toolCalls('orders.modify')).toHaveLength(1));
    stop().focus();
    fireEvent.keyDown(stop(), { key: 'ArrowUp' });
    const moved = stop().textContent;
    await act(async () => {
      rt.pending('orders.modify').fail('rejected', 'The broker refused the change');
      await actPause();
    });
    expect(stop().textContent).toBe(moved);
    expect(stop().classList.contains('is-moving')).toBe(true);
  });
});
