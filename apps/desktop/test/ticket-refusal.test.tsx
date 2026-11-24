import type { AccountUpdate, Quote } from '@tessera/protocol';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OrderNote } from '../src/chart/ticket/Ticket.tsx';
import { useTicketModel, type TicketInstrument } from '../src/chart/ticket/useTicketModel.ts';
import type { TicketTrade } from '../src/chart/ticket/useTicketTrade.ts';
import { quoteStore } from '../src/market/quotes.ts';
import { resetOrderIntents } from '../src/shell/tradeActions.ts';
import { DEFAULT_TICKET } from '../src/state/tickets.ts';
import { wireOrder } from './support/orders.ts';
import { Refusal, runtimeLink, type RuntimeLink } from './support/runtimeLink.ts';

const MNQ = 'MNQZ6.CME';
const IDS = new Set([MNQ]);
const CHART = { layoutId: 'L1', tileId: 'chart-1', instrument: MNQ };
const QUOTE: Quote = {
  instrument: MNQ,
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
const TICKET = {
  spec: null,
  instrument: MNQ,
  ids: IDS,
  symbol: 'MNQ Z6',
  differs: false,
  as: 'chart',
  charted: { instrument: MNQ, ids: IDS, symbol: 'MNQ Z6', spec: null },
  choices: [],
  unavailable: null,
} satisfies TicketInstrument;

function flat(qty: number): TicketTrade {
  return {
    setup: { ...DEFAULT_TICKET, qty, sizing: 'qty' },
    update: {
      account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper', currency: 'USD' },
      summary: { netLiq: { amount: 1_390_000, currency: 'USD' }, dayPnl: { amount: 0, currency: 'USD' } },
      risk: null,
    } as unknown as AccountUpdate,
    positions: [],
    orders: [],
    env: 'paper',
    entry: { open: true },
  };
}

const MARGIN =
  'Paper (Tessera Paper): 17,704 MNQ need $80,606,312 of margin; the account has $1,390,000 of buying power. Nothing sent.';

let link: RuntimeLink | null = null;
afterEach(() => {
  cleanup();
  link?.client.close();
  link = null;
  resetOrderIntents();
});

describe('the ticket says why the paper account refused an order', () => {
  it('shows the margin refusal in the ticket, and drops it once the size changes', async () => {
    link = runtimeLink({ 'orders.submit': () => new Refusal(MARGIN) });
    await link.open();
    quoteStore.apply(QUOTE);
    const { result, rerender } = renderHook(({ trade }) => useTicketModel(CHART, trade, TICKET), {
      initialProps: { trade: flat(17_704) },
    });
    act(() => result.current.press('sell', 'market'));
    const line = '17,704 MNQ need $80,606,312 of margin; the account has $1,390,000 of buying power · Not sent';
    await waitFor(() => expect(result.current.refusal).toBe(line));
    expect(link.invoked('orders.submit')).toHaveLength(1);

    render(<OrderNote why={null} m={{ lockedLine: null, refusal: result.current.refusal, riskLine: 'Risk' }} />);
    expect(screen.getByRole('status').textContent).toBe(line);

    rerender({ trade: flat(17) });
    expect(result.current.refusal).toBeNull();
  });

  it('drops the refusal once the position changes, as after Flat', async () => {
    link = runtimeLink({ 'orders.submit': () => new Refusal(MARGIN) });
    await link.open();
    quoteStore.apply(QUOTE);
    const held = flat(1);
    const long: TicketTrade = {
      ...held,
      positions: [
        {
          accountId: 'paper-main',
          instrument: MNQ,
          qty: 2,
          avgPrice: 20_641.5,
          realizedPnl: { amount: 0, currency: 'USD' },
          unrealizedPnl: null,
          mark: null,
          openedAt: 1,
        },
      ],
    };
    const { result, rerender } = renderHook(({ trade }) => useTicketModel(CHART, trade, TICKET), {
      initialProps: { trade: long },
    });
    act(() => result.current.press('buy', 'market'));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    rerender({ trade: held });
    expect(result.current.refusal).toBeNull();
  });

  it('a filled order clears the last refusal on that contract', async () => {
    let answer: 'refuse' | 'fill' = 'refuse';
    link = runtimeLink({
      'orders.submit': () =>
        answer === 'refuse'
          ? new Refusal(MARGIN)
          : { order: wireOrder({ status: 'filled', filledQty: 1, avgFillPrice: 20_641.25 }), bracket: [] },
    });
    await link.open();
    quoteStore.apply(QUOTE);
    const { result } = renderHook(() => useTicketModel(CHART, flat(1), TICKET));
    act(() => result.current.press('sell', 'market'));
    await waitFor(() => expect(result.current.refusal).not.toBeNull());
    answer = 'fill';
    act(() => result.current.press('buy', 'market'));
    await waitFor(() => expect(result.current.refusal).toBeNull());
  });
});
