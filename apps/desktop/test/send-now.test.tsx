import { QueryClientProvider } from '@tanstack/react-query';
import type { AccountUpdate, Approval, OrderInput, Quote, ToolName } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTicketModel, type TicketInstrument } from '../src/chart/ticket/useTicketModel.ts';
import type { TicketTrade } from '../src/chart/ticket/useTicketTrade.ts';
import { queryClient } from '../src/app/queries.ts';
import { quoteStore } from '../src/market/quotes.ts';
import { ApprovalCard } from '../src/shell/ApprovalCard.tsx';
import { chartToasts, noteOnChart } from '../src/chart/chartNotice.ts';
import { noticeWords } from '../src/shell/noticeWords.ts';
import { DEFAULT_TICKET } from '../src/state/tickets.ts';
import { LATE_ORDER } from '@tessera/protocol';
import { MOTION } from '@tessera/ui';
import {
  breakeven,
  cancelAll,
  cancelOrder,
  flatten,
  mergeBrackets,
  modifyOrderPrice,
  orderFreshMs,
  orderHoldBoundMs,
  orderIntentKey,
  resetOrderIntents,
  reverse,
  submitOrder,
  useOrderFreshMs,
  watchOrderLate,
  type ActionResult,
} from '../src/shell/tradeActions.ts';
import { wireOrder } from './support/orders.ts';
import { runtimeLink, type RuntimeLink } from './support/runtimeLink.ts';

const BUY_1_NQ: OrderInput = {
  accountId: 'paper-main',
  instrument: 'NQZ6.CME',
  side: 'buy',
  qty: 1,
  orderType: 'market',
  tif: 'day',
};

const BUY_LIMIT_20600: OrderInput = { ...BUY_1_NQ, orderType: 'limit', limitPrice: 20_600 };
const BUY_LIMIT_20500: OrderInput = { ...BUY_1_NQ, orderType: 'limit', limitPrice: 20_500 };
const SELL_1_NQ: OrderInput = { ...BUY_1_NQ, side: 'sell' };

const filled = () => ({ order: wireOrder({ status: 'filled', filledQty: 1, avgFillPrice: 20_641.5 }), bracket: [] });

const NQ = 'NQZ6.CME';
const DRAFT_BUY_2_NQ: Approval = {
  id: 'a_1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sessionId: 's_1',
  callId: 'c_1',
  tool: 'orders.submit',
  risk: 'financial',
  input: {},
  preview: {
    request: {
      accountId: 'paper-main',
      instrument: NQ,
      side: 'buy',
      qty: 2,
      orderType: 'limit',
      limitPrice: 20_600,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
    },
    environment: 'paper',
    restatement: 'BUY 2 NQZ6 LMT 20600 DAY',
    referencePrice: 20_641.25,
    estPrice: 20_600,
    estValue: null,
    estFees: null,
    riskToStop: null,
    buyingPowerAfter: null,
    positionAfter: 2,
    checks: [],
    createdAt: 0,
  },
  previewHash: 'h1',
  draftId: 'd_1',
  environment: 'paper',
  instrument: NQ,
  createdAt: 0,
  staleAt: Date.now() + 600_000,
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
};
const NQ_CHART = { layoutId: 'L1', tileId: 'chart-1', instrument: NQ };
const NQ_QUOTE: Quote = {
  instrument: NQ,
  ts: 1,
  bid: 20_641.25,
  bidSize: 4,
  ask: 20_641.5,
  askSize: 3,
  last: 20_641.25,
  lastSize: 1,
  session: null,
  source: null,
};
const NQ_IDS = new Set([NQ]);
const NQ_TICKET = {
  spec: null,
  instrument: NQ,
  ids: NQ_IDS,
  symbol: 'NQ Z6',
  differs: false,
  as: 'chart',
  charted: { instrument: NQ, ids: NQ_IDS, symbol: 'NQ Z6', spec: null },
  choices: [],
  unavailable: null,
} satisfies TicketInstrument;
const LONG_1: TicketTrade = {
  setup: DEFAULT_TICKET,
  update: {
    account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper', currency: 'USD' },
    summary: { netLiq: { amount: 100_000, currency: 'USD' }, dayPnl: { amount: 0, currency: 'USD' } },
    risk: null,
  } as unknown as AccountUpdate,
  positions: [
    {
      accountId: 'paper-main',
      instrument: NQ,
      qty: 1,
      avgPrice: 20_641.5,
      realizedPnl: { amount: 0, currency: 'USD' },
      unrealizedPnl: null,
      mark: null,
      openedAt: 1,
    },
  ],
  orders: [],
  env: 'paper',
  entry: { open: true },
};

let link: RuntimeLink | null = null;
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  link?.client.close();
  link = null;
  resetOrderIntents();
});

const NO_ANSWER = { title: 'No answer from the runtime', detail: 'Check Orders before sending it again' };
const TOO_LATE = { title: 'Not sent', detail: 'Too late. The runtime did not take it in time' };

function onceLate(): Promise<ActionResult> {
  return new Promise((resolve) => {
    const stop = watchOrderLate((update) => {
      stop();
      resolve(update.result);
    });
  });
}

const NOT_SENT = { title: 'Not sent', detail: 'The runtime is not connected' };

describe('an order is sent now or not at all', () => {
  it('a Buy market clicked while the runtime is unreachable is not sent, says so, and never goes once it is back', async () => {
    link = runtimeLink({ 'orders.submit': filled });
    await link.open();
    await link.cut();
    const clicked = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await link.restore();
    expect(noticeWords(await clicked)).toEqual(NOT_SENT);
    expect(link.invoked('orders.submit')).toEqual([]);

    const now = await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    expect(noticeWords(now)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 market' });
    expect(link.invoked('orders.submit')).toHaveLength(1);
    expect(link.received('tools.invoke')[0]).toMatchObject({
      name: 'orders.submit',
      idempotencyKey: expect.any(String),
      deadline: expect.any(Number),
    });
  });

  it('every order action taken while the runtime is unreachable is not sent and never goes later', async () => {
    link = runtimeLink({});
    await link.open();
    await link.cut();
    const working = wireOrder({ request: { orderType: 'limit', limitPrice: 20_600 } });
    const actions: [ToolName, Promise<ActionResult>][] = [
      ['orders.submit', submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2)],
      ['orders.modify', modifyOrderPrice('paper', working, 20_610)],
      ['orders.cancel', cancelOrder(working)],
      ['orders.cancel_all', cancelAll('paper-main', 'NQZ6.CME', 'NQ Z6')],
      ['orders.flatten', flatten('paper-main', 'NQZ6.CME', 'NQ Z6')],
      ['orders.breakeven', breakeven('paper-main', 'NQZ6.CME', 'NQ Z6', null, 2)],
      ['orders.reverse', reverse('paper', 'paper-main', 'NQZ6.CME', null, 'Reverse NQ Z6', 2)],
      ['orders.merge_brackets', mergeBrackets('paper-main', 'NQZ6.CME', 'NQ Z6')],
    ];
    await link.restore();
    for (const [tool, result] of actions) {
      expect({ tool, said: noticeWords(await result) }).toEqual({ tool, said: NOT_SENT });
      expect({ tool, invoked: link.invoked(tool) }).toEqual({ tool, invoked: [] });
    }
  });

  it('the ticket’s orders and exits are off and say why while the runtime is unreachable, and on once it is back', async () => {
    link = runtimeLink({});
    await link.open();
    quoteStore.apply(NQ_QUOTE);
    const { result } = renderHook(() => useTicketModel(NQ_CHART, LONG_1, NQ_TICKET));
    const offNow = () => ({
      buy: result.current.off('buy', 'market'),
      sell: result.current.off('sell', 'market'),
      flat: result.current.flatOff,
    });
    expect(offNow()).toEqual({ buy: false, sell: false, flat: false });

    await act(() => link!.cut());
    expect(offNow()).toEqual({ buy: true, sell: true, flat: true });
    expect(result.current.tip('buy', 'market')).toBe('Orders are off until the runtime reconnects');
    expect(result.current.flatTip).toBe('Orders are off until the runtime reconnects');

    await act(() => link!.restore());
    expect(offNow()).toEqual({ buy: false, sell: false, flat: false });
  });

  it('an Approve clicked while the runtime is unreachable is not sent, says so, and never goes once it is back', async () => {
    link = runtimeLink({});
    await link.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(
      <QueryClientProvider client={queryClient}>
        <ApprovalCard approval={DRAFT_BUY_2_NQ} more={0} sessionTitle={null} />
      </QueryClientProvider>,
    );
    const approve = screen.getByRole('button', { name: 'Approve on paper' });
    await act(() => vi.advanceTimersByTimeAsync(MOTION.armMs));
    expect(approve.getAttribute('aria-disabled')).toBeNull();
    vi.useRealTimers();
    await act(() => link!.cut());
    fireEvent.click(approve);
    await act(() => link!.restore());
    expect((await screen.findByRole('alert')).textContent).toBe('The runtime is not connected. Nothing sent.');
    expect(link.received('approvals.resolve')).toEqual([]);
  });

  it('an order whose answer never comes says so in one plain sentence, whether it waited out or the link dropped', async () => {
    const restore = useOrderFreshMs(50);
    link = runtimeLink({ 'orders.submit': () => 'no answer' }, { requestTimeoutMs: 50 });
    await link.open();

    expect(noticeWords(await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2))).toEqual(NO_ANSWER);
    resetOrderIntents();

    const lost = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await link.cut();
    expect(noticeWords(await lost)).toEqual(NO_ANSWER);
    expect(link.invoked('orders.submit')).toHaveLength(2);
    restore();
  });

  it('a click while the runtime is hung is not sent late or twice, and the ticket says what happened', async () => {
    const restore = useOrderFreshMs(80);
    link = runtimeLink({ 'orders.submit': filled }, { requestTimeoutMs: 80 });
    await link.open();
    quoteStore.apply(NQ_QUOTE);
    const { result } = renderHook(() => useTicketModel(NQ_CHART, LONG_1, NQ_TICKET));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    link.hold();
    const first = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await act(async () => {
      result.current.press('buy', 'market');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(noticeWords(await first)).toEqual(NO_ANSWER);
    expect(result.current.off('buy', 'market')).toBe(true);
    expect(noticeWords(await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2))).toEqual({
      title: 'Not sent',
      detail: 'Already sending this order',
    });
    expect(link.received('tools.invoke')).toHaveLength(1);
    const late = onceLate();
    await act(async () => {
      link!.release();
    });
    expect(noticeWords(await late)).toEqual(TOO_LATE);
    expect(link.invoked('orders.submit')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.off('buy', 'market')).toBe(false);
    restore();
  });

  it('a request that is only slow, still inside its deadline, goes once', async () => {
    const restore = useOrderFreshMs(200);
    link = runtimeLink({ 'orders.submit': filled }, { requestTimeoutMs: 200 });
    await link.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    link.hold();
    const clicked = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await vi.advanceTimersByTimeAsync(30);
    link.release();
    expect(noticeWords(await clicked)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 market' });
    expect(link.invoked('orders.submit')).toHaveLength(1);
    restore();
  });

  it('the same click twice while the first is still open is one order', async () => {
    const restore = useOrderFreshMs(200);
    link = runtimeLink({ 'orders.submit': filled }, { requestTimeoutMs: 200 });
    await link.open();
    link.hold();
    const a = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    const b = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    link.release();
    expect(noticeWords(await a)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 market' });
    expect(noticeWords(await b)).toEqual({ title: 'Not sent', detail: 'Already sending this order' });
    expect(link.received('tools.invoke')).toHaveLength(1);
    restore();
  });

  it('a held-back second click has its own Not sent and leaves the first click’s note', async () => {
    const restore = useOrderFreshMs(200);
    link = runtimeLink({ 'orders.submit': filled }, { requestTimeoutMs: 200 });
    await link.open();
    const chart = { layoutId: 'L', tileId: 'chart-1' };
    chartToasts(chart).clear();
    link.hold();
    const first = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    const second = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    link.release();
    const firstNote = await first;
    const secondNote = await second;
    expect(noticeWords(firstNote)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 market' });
    expect(noticeWords(secondNote)).toEqual({ title: 'Not sent', detail: 'Already sending this order' });
    expect(secondNote.key).not.toBe(firstNote.key);
    noteOnChart(chart, firstNote);
    noteOnChart(chart, secondNote);
    expect(
      chartToasts(chart)
        .getSnapshot()
        .filter((t) => t.state === 'open')
        .map((t) => t.title),
    ).toEqual(['Filled at 20,641.50', 'Not sent']);
    expect(link.received('tools.invoke')).toHaveLength(1);
    chartToasts(chart).clear();
    restore();
  });

  it('a held-back repeat leaves the No answer warning up', async () => {
    const restore = useOrderFreshMs(40);
    link = runtimeLink({ 'orders.submit': () => 'no answer' }, { requestTimeoutMs: 40 });
    await link.open();
    const chart = { layoutId: 'L', tileId: 'chart-1' };
    chartToasts(chart).clear();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await vi.advanceTimersByTimeAsync(60);
    const firstNote = await first;
    const secondNote = await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    expect(noticeWords(firstNote)).toEqual(NO_ANSWER);
    expect(noticeWords(secondNote)).toEqual({ title: 'Not sent', detail: 'Already sending this order' });
    expect(secondNote.key).not.toBe(firstNote.key);
    noteOnChart(chart, firstNote);
    noteOnChart(chart, secondNote);
    expect(
      chartToasts(chart)
        .getSnapshot()
        .filter((t) => t.state === 'open')
        .map((t) => [t.title, t.detail]),
    ).toEqual([
      ['No answer from the runtime', 'Check Orders before sending it again'],
      ['Not sent', 'Already sending this order'],
    ]);
    expect(link.received('tools.invoke')).toHaveLength(1);
    chartToasts(chart).clear();
    restore();
  });

  it('an Approve clicked while the runtime is hung is not sent late or twice', async () => {
    const restore = useOrderFreshMs(80);
    link = runtimeLink({}, { requestTimeoutMs: 80 });
    await link.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    render(
      <QueryClientProvider client={queryClient}>
        <ApprovalCard approval={DRAFT_BUY_2_NQ} more={0} sessionTitle={null} />
      </QueryClientProvider>,
    );
    const approve = screen.getByRole('button', { name: 'Approve on paper' });
    await act(() => vi.advanceTimersByTimeAsync(MOTION.armMs));
    expect(approve.getAttribute('aria-disabled')).toBeNull();
    link.hold();
    fireEvent.click(approve);
    await act(() => vi.advanceTimersByTimeAsync(120));
    fireEvent.click(approve);
    expect(link.received('approvals.resolve')).toHaveLength(1);
    await act(async () => {
      link!.release();
    });
    expect(screen.getByRole('alert').textContent).toBe(LATE_ORDER);
    expect(link.received('approvals.resolve')).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(MOTION.armMs));
    expect(approve.getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.click(approve);
    });
    expect(link.received('approvals.resolve')).toHaveLength(2);
    restore();
  });

  it('two buy limits of the same size at different prices are two orders', async () => {
    link = runtimeLink({ 'orders.submit': filled });
    await link.open();
    link.hold();
    const high = submitOrder('paper', BUY_LIMIT_20600, 'Buy 1 NQ Z6 limit 20,600', 2);
    const low = submitOrder('paper', BUY_LIMIT_20500, 'Buy 1 NQ Z6 limit 20,500', 2);
    link.release();
    expect(noticeWords(await high)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 limit 20,600' });
    expect(noticeWords(await low)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 limit 20,500' });
    expect(link.invoked('orders.submit')).toEqual([
      expect.objectContaining({ limitPrice: 20_600 }),
      expect.objectContaining({ limitPrice: 20_500 }),
    ]);
    expect(orderIntentKey('orders.submit', BUY_LIMIT_20600)).not.toBe(orderIntentKey('orders.submit', BUY_LIMIT_20500));
    expect(orderIntentKey('orders.submit', BUY_1_NQ)).not.toBe(orderIntentKey('orders.submit', SELL_1_NQ));
  });

  it('a click on a page that reads its events late waits for its real answer, held all the while', async () => {
    const restore = useOrderFreshMs(80);
    link = runtimeLink({ 'orders.submit': filled }, { requestTimeoutMs: 80 });
    await link.open();
    quoteStore.apply(NQ_QUOTE);
    const { result } = renderHook(() => useTicketModel(NQ_CHART, LONG_1, NQ_TICKET));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    link.pulse(0);
    link.lagBehind();
    const first = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    for (let ms = 1; ms <= 20; ms += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
        link!.pulse(ms);
      });
    }
    expect(result.current.off('buy', 'market')).toBe(true);
    const again = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    link.catchUp();
    expect(noticeWords(await first)).toEqual({ title: 'Filled at 20,641.50', detail: 'Buy 1 NQ Z6 market' });
    expect(noticeWords(await again)).toEqual({ title: 'Not sent', detail: 'Already sending this order' });
    expect(link.invoked('orders.submit')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.off('buy', 'market')).toBe(false);
    restore();
  });

  it('a lost reply unlocks the ticket in bounded time and leaves the other side free', async () => {
    const restore = useOrderFreshMs(400);
    let silent = true;
    link = runtimeLink({ 'orders.submit': () => (silent ? 'no answer' : filled()) }, { requestTimeoutMs: 40 });
    await link.open();
    quoteStore.apply(NQ_QUOTE);
    const { result } = renderHook(() => useTicketModel(NQ_CHART, LONG_1, NQ_TICKET));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const lost = submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2);
    await act(async () => {
      result.current.press('buy', 'market');
    });
    let notice: Awaited<typeof lost> | undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(orderFreshMs());
      notice = await lost;
    });
    expect(noticeWords(notice!)).toEqual(NO_ANSWER);
    expect(result.current.off('buy', 'market')).toBe(true);
    expect(result.current.off('sell', 'market')).toBe(false);
    expect(link.invoked('orders.submit')).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(orderHoldBoundMs() - orderFreshMs() - 1);
    });
    expect(result.current.off('buy', 'market')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.off('buy', 'market')).toBe(false);
    expect(result.current.off('sell', 'market')).toBe(false);
    vi.useRealTimers();
    silent = false;
    expect(noticeWords(await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 market', 2))).toEqual({
      title: 'Filled at 20,641.50',
      detail: 'Buy 1 NQ Z6 market',
    });
    expect(link.invoked('orders.submit')).toHaveLength(2);
    restore();
  });
});
