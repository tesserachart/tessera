import { QueryClientProvider } from '@tanstack/react-query';
import type { AccountUpdate, Approval, HealthUpdate, OrderInput, Position, Quote } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { queryClient } from '../src/app/queries.ts';
import { useTicketModel, type TicketInstrument } from '../src/chart/ticket/useTicketModel.ts';
import type { TicketTrade } from '../src/chart/ticket/useTicketTrade.ts';
import { quoteStore } from '../src/market/quotes.ts';
import { ApprovalCard } from '../src/shell/ApprovalCard.tsx';
import { noticeWords } from '../src/shell/noticeWords.ts';
import { useStaleNotices } from '../src/shell/staleNotices.ts';
import { MARKET_WAITS } from '../src/shell/ticket.ts';
import { submitOrder } from '../src/shell/tradeActions.ts';
import { DEFAULT_TICKET } from '../src/state/tickets.ts';
import { deskToasts } from '../src/workspace/dock/deskToasts.ts';
import { wireOrder } from './support/orders.ts';
import { providerHealth } from './support/providers.ts';
import { Refusal, runtimeLink, type RuntimeLink } from './support/runtimeLink.ts';

const NQ = 'NQZ6.CME';
const TEN_MINUTES_NS = 600_000_000_000;

const MOCK = providerHealth({
  providerId: 'mock',
  displayName: 'Mock market',
  latencyMs: 0,
  lastMessageAt: 1,
  checkedAt: 1,
});
const LIVE: HealthUpdate = { providers: [MOCK], pricesDown: [] };
const DROPPED: HealthUpdate = {
  providers: [{ ...MOCK, status: 'degraded', message: 'Connection lost (simulated outage). Reconnecting.' }],
  pricesDown: ['mock'],
};

const GATE =
  'Mock market dropped and is reconnecting. New market orders wait until its prices are back; Flat, closes and Reverse still go. Nothing sent.';
const REASON = GATE.replace(/\. Nothing sent\.$/, '');

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
  source: { provider: 'mock' },
};

const BUY_1_NQ: OrderInput = {
  accountId: 'paper-main',
  instrument: NQ,
  side: 'buy',
  qty: 1,
  orderType: 'market',
  tif: 'day',
};

const ACCOUNT = {
  account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper', currency: 'USD' },
  summary: { netLiq: { amount: 100_000, currency: 'USD' }, dayPnl: { amount: 0, currency: 'USD' } },
  risk: null,
} as unknown as AccountUpdate;

const NQ_IDS = new Set([NQ]);
const NQ_CHART = { layoutId: 'L1', tileId: 'chart-1', instrument: NQ };
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

const FLAT_TRADE: TicketTrade = {
  setup: DEFAULT_TICKET,
  update: ACCOUNT,
  positions: [],
  orders: [],
  env: 'paper',
  entry: { open: true },
};

const MARKET_DRAFT: Approval = {
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
      qty: 1,
      orderType: 'market',
      limitPrice: null,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
    },
    environment: 'paper',
    restatement: 'BUY 1 NQZ6 MKT DAY',
    referencePrice: 20_641.5,
    estPrice: 20_641.5,
    estValue: null,
    estFees: null,
    riskToStop: null,
    buyingPowerAfter: null,
    positionAfter: 1,
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

const filled = () => ({ order: wireOrder({ status: 'filled', filledQty: 1, avgFillPrice: 20_641.5 }), bracket: [] });

let link: RuntimeLink | null = null;

afterEach(() => {
  cleanup();
  link?.client.close();
  link = null;
  deskToasts.clear();
});

async function desk(l: RuntimeLink): Promise<RuntimeLink> {
  link = l;
  await l.open();
  quoteStore.apply(NQ_QUOTE);
  return l;
}

const openToasts = () => deskToasts.getSnapshot().filter((t) => t.state === 'open');

describe('a market order refused by the runtime’s price gate', () => {
  it('reads the same on the ticket and on the agent’s card, and leaves the card to approve again', async () => {
    const l = await desk(
      runtimeLink({ 'orders.submit': () => new Refusal(`Paper: ${GATE}`) }, { resolve: () => new Refusal(GATE) }),
    );

    const ticket = noticeWords(await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 at market', 2), 'Paper');
    expect(ticket).toEqual({ title: 'Not sent', detail: REASON });

    render(
      <QueryClientProvider client={queryClient}>
        <ApprovalCard approval={MARKET_DRAFT} more={0} sessionTitle={null} />
      </QueryClientProvider>,
    );
    const approve = screen.getByRole('button', { name: 'Approve on paper' });
    await waitFor(() => expect(approve.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(approve);
    const said = (await screen.findByRole('alert')).textContent;
    expect(said).toBe(GATE);
    expect(said).toContain(ticket.detail);
    expect(l.received('approvals.resolve')).toHaveLength(1);

    const again = screen.getByRole('button', { name: 'Approve on paper' });
    await waitFor(() => expect(again.getAttribute('data-state')).toBe('arming'));
    await waitFor(() => expect(again.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(again);
    await waitFor(() => expect(l.received('approvals.resolve')).toHaveLength(2));
  });
});

describe('the toast while prices are down', () => {
  it('tells the trader the connection dropped and is reconnecting, until its prices are back', async () => {
    const l = await desk(runtimeLink({}));
    renderHook(() => useStaleNotices());
    const open = () => openToasts().map(({ key, title, detail, ms }) => ({ key, title, detail, ms }));
    await act(() => l.publish('health', LIVE));
    expect(open()).toEqual([]);

    await act(() => l.publish('health', DROPPED));
    expect(open()).toEqual([
      {
        key: 'stale:prices:mock',
        title: 'Mock market dropped',
        detail: 'Reconnecting. New market orders wait for live prices',
        ms: null,
      },
    ]);
    await act(() => l.publish('health', DROPPED));
    expect(open()).toHaveLength(1);

    await act(() => l.publish('health', LIVE));
    expect(open()).toEqual([]);
  });

  it('tells the trader the runtime dropped and is reconnecting, until it is back', async () => {
    const l = await desk(runtimeLink({}));
    renderHook(() => useStaleNotices());
    const titles = () => openToasts().map((t) => `${t.title} · ${t.detail ?? ''}`);
    await act(() => l.cut());
    expect(titles()).toEqual(['Runtime dropped · Reconnecting']);
    await act(() => l.restore());
    expect(titles()).toEqual([]);
  });
});

describe('a quiet market', () => {
  it('is not stale: ten minutes without a trade leave the ticket, the toasts and market orders as they are', async () => {
    const l = await desk(runtimeLink({ 'orders.submit': filled }));
    quoteStore.apply({ ...NQ_QUOTE, ts: 1 });
    const { result } = renderHook(() => {
      useStaleNotices();
      return useTicketModel(NQ_CHART, FLAT_TRADE, NQ_TICKET);
    });
    await act(() =>
      l.publish('health', {
        providers: [{ ...MOCK, lastMessageAt: 1, checkedAt: 1 + TEN_MINUTES_NS }],
        pricesDown: [],
      }),
    );
    expect(result.current.stale).toEqual({ position: null, prices: null });
    expect(result.current.off('buy', 'market')).toBe(false);
    expect(openToasts()).toEqual([]);
    expect((await submitOrder('paper', BUY_1_NQ, 'Buy 1 NQ Z6 at market', 2)).tone).toBe('ok');
  });
});

describe('the ticket while prices are down', () => {
  const long1: Position = {
    accountId: 'paper-main',
    instrument: NQ,
    qty: 1,
    avgPrice: 20_641.5,
    realizedPnl: { amount: 0, currency: 'USD' },
    unrealizedPnl: { amount: 0, currency: 'USD' },
    mark: 20_641.25,
    openedAt: 1,
  };

  it('dims a market order that would open, says why, and leaves closes, limits, Flat and Reverse lit', async () => {
    const l = await desk(runtimeLink({}));
    const { result, rerender } = renderHook(({ trade }) => useTicketModel(NQ_CHART, trade, NQ_TICKET), {
      initialProps: { trade: FLAT_TRADE },
    });
    expect(result.current.off('buy', 'market')).toBe(false);

    await act(() => l.publish('health', DROPPED));
    expect(result.current.off('buy', 'market')).toBe(true);
    expect(result.current.off('sell', 'market')).toBe(true);
    expect(result.current.tip('buy', 'market')).toBe(MARKET_WAITS);
    expect(result.current.off('buy', 'touch')).toBe(false);
    expect(result.current.off('sell', 'limit')).toBe(false);

    rerender({ trade: { ...FLAT_TRADE, positions: [long1] } });
    expect(result.current.off('sell', 'market')).toBe(false);
    expect(result.current.off('buy', 'market')).toBe(true);
    expect(result.current.flatOff).toBe(false);
    expect(result.current.revOff).toBe(false);

    await act(() => l.publish('health', LIVE));
    expect(result.current.off('buy', 'market')).toBe(false);
    expect(result.current.tip('buy', 'market')).not.toBe(MARKET_WAITS);
  });
});
