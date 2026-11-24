import type { Order, OrderRole, OrderStatus, Position, Side } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BRACKET_ON } from './support/oco.ts';
import { breakevenDone, breakevenOf, breakevenOffset, breakevenTip } from '../src/chart/breakeven.ts';
import { groupBrackets } from '../src/chart/brackets.ts';
import { breakeven } from '../src/shell/tradeActions.ts';
import { setTestServices, type FakeClient } from './support/runtime.tsx';

const NQ = 'NQZ6.CME';
const ids = new Set([NQ]);
const TICK = 0.25;

let n = 0;
function stop(side: Side, price: number, o: { role?: OrderRole; status?: OrderStatus; offset?: number } = {}): Order {
  n += 1;
  return {
    id: `s${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: NQ,
      side,
      qty: 1,
      orderType: 'stop',
      limitPrice: null,
      stopPrice: price,
      tif: 'gtc',
      bracket: null,
      clientOrderId: null,
      reduceOnly: true,
    },
    role: o.role ?? 'stop_loss',
    parentId: `e${String(n)}`,
    status: o.status ?? 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
    ...(o.offset !== undefined
      ? { stopRules: { breakeven: { triggerTicks: 20, offsetTicks: o.offset }, breakevenDone: false } }
      : {}),
    triggeredAt: null,
    environment: 'paper',
    reason: null,
    createdAt: 1_759_430_000_000,
    updatedAt: 1_759_430_000_000,
  };
}

const position = (qty: number, avg: number): Position => ({
  accountId: 'paper-main',
  instrument: NQ,
  qty,
  avgPrice: avg,
  realizedPnl: { amount: 0, currency: 'USD' },
  unrealizedPnl: null,
  mark: null,
  openedAt: 1_759_430_000_000,
});

function pos(orders: Order[], p: Position | null) {
  return groupBrackets(orders, p ? [p] : [], [], ids).find((b) => b.kind === 'position') ?? null;
}

describe('Breakeven before the press', () => {
  it('is off without a position, with its stop on its way, and with every stop at or past breakeven, saying why', () => {
    expect(breakevenOf(null, TICK, null).why).toBe('No position');
    expect(
      breakevenOf(pos([stop('sell', 20_590, { status: 'pending_submit' })], position(2, 20_600)), TICK, null).why,
    ).toBe('Stop is on its way to the broker');
    expect(breakevenOf(pos([stop('sell', 20_600.25)], position(2, 20_600)), TICK, 1).why).toBe(
      'Stop is already at or past breakeven',
    );
    expect(breakevenOf(pos([stop('sell', 20_600), stop('sell', 20_610)], position(2, 20_600)), TICK, 0).why).toBe(
      'Stops are already at or past breakeven',
    );
  });

  it('is on for a position without a stop, offering one at breakeven: the entry plus the offset', () => {
    const target: Order = {
      ...stop('sell', 20_700),
      role: 'take_profit',
      request: { ...stop('sell', 20_700).request, orderType: 'limit', limitPrice: 20_700, stopPrice: null },
    };
    const bare = breakevenOf(pos([target], position(2, 20_600)), TICK, 4);
    expect(bare).toMatchObject({ why: null, price: 20_601, offset: 4, newStop: true });
    expect(bare.stops).toHaveLength(0);
    expect(breakevenTip(bare, 2)).toBe('Place a stop at breakeven: 20,601.00, the entry + 4 ticks');
    const short = breakevenOf(pos([], position(-3, 20_600.1)), TICK, null);
    expect(breakevenTip(short, 2)).toBe('Place a stop at breakeven: 20,600.00, the entry');
    const held = breakevenOf(pos([stop('sell', 20_590, { status: 'held' })], position(2, 20_600)), TICK, null);
    expect(held).toMatchObject({ why: null, newStop: true });
  });

  it('is on with a stop behind breakeven: the entry plus the offset, toward profit, long and short', () => {
    const long = breakevenOf(pos([stop('sell', 20_590)], position(2, 20_600)), TICK, 4);
    expect(long).toMatchObject({ why: null, price: 20_601, offset: 4 });
    expect(long.stops).toHaveLength(1);
    expect(breakevenTip(long, 2)).toBe('Move the stop to breakeven: 20,601.00, the entry + 4 ticks');
    const short = breakevenOf(pos([stop('buy', 20_612.5)], position(-3, 20_600)), TICK, 1);
    expect(short).toMatchObject({ why: null, price: 20_599.75 });
    expect(breakevenTip(short, 2)).toBe('Move the stop to breakeven: 20,599.75, the entry + 1 tick');
    expect(breakevenOf(pos([stop('sell', 20_590)], position(3, 20_600.1)), TICK, 0).price).toBe(20_600.25);
    expect(breakevenOf(pos([stop('buy', 20_612)], position(-3, 20_600.1)), TICK, 0).price).toBe(20_600);
  });

  it('moves every pair’s stop behind it to the position’s average, and takes the stops’ own offset unless asked', () => {
    const both = breakevenOf(pos([stop('sell', 20_560), stop('sell', 20_580)], position(18, 20_597.25)), TICK, null);
    expect(both.stops).toHaveLength(2);
    expect(breakevenTip(both, 2)).toBe('Move the 2 stops to breakeven: 20,597.25, the entry (the position’s average)');
    const ruled = pos([stop('sell', 20_590, { offset: 2 })], position(1, 20_600));
    expect(breakevenOf(ruled, TICK, null).price).toBe(20_600.5);
    expect(breakevenOf(ruled, TICK, 0).price).toBe(20_600);
  });

  it('asks the panel’s offset only while its bracket and breakeven rule are on', () => {
    expect(breakevenOffset(BRACKET_ON)).toBeNull();
    expect(breakevenOffset({ ...BRACKET_ON, breakeven: { on: true, trigger: 20, offset: 3 } })).toBe(3);
    expect(breakevenOffset({ ...BRACKET_ON, on: false, breakeven: { on: true, trigger: 20, offset: 3 } })).toBeNull();
    expect(breakevenOffset(null)).toBeNull();
  });
});

describe('the press', () => {
  it('asks orders.breakeven as an exit and says what moved, or the runtime’s refusal as it is', async () => {
    const out = {
      summary: 'Moved the stop',
      price: 20_601,
      entry: 20_600,
      offsetTicks: 4,
      moved: [stop('sell', 20_601)],
      kept: 0,
    };
    const request = vi.fn().mockResolvedValue({ callId: 'c1', status: 'ok', ok: true, output: out });
    const client = { request } as unknown as FakeClient;
    setTestServices(client);
    const r = await breakeven('paper-main', NQ, 'NQ Z6', 4, 2);
    expect(r).toMatchObject({ tone: 'ok', text: 'Stop to breakeven 20,601.00 on NQ Z6' });
    expect(request.mock.calls[0]!.slice(0, 2)).toMatchObject([
      'tools.invoke',
      {
        name: 'orders.breakeven',
        input: { accountId: 'paper-main', instrument: NQ, offsetTicks: 4 },
        surface: { armed: true, holdConfirmed: false },
        idempotencyKey: expect.any(String),
        deadline: expect.any(Number),
      },
    ]);
    await breakeven('paper-main', NQ, 'NQ Z6', null, 2);
    expect(request.mock.lastCall![1].input).toEqual({ accountId: 'paper-main', instrument: NQ });
    const why = 'Paper (Tessera Paper): Price hasn’t passed your entry (20,600.00) yet; the stop stays at 20,598.00.';
    request.mockResolvedValueOnce({
      callId: 'c2',
      status: 'error',
      ok: false,
      error: { code: 'rejected', message: why, retryable: false },
    });
    expect(await breakeven('paper-main', NQ, 'NQ Z6', 0, 2)).toMatchObject({ tone: 'err', text: why });
  });

  it('says the stop it placed for a position that had none', () => {
    const out = {
      summary: 'Placed a stop at breakeven, 20,600.00 (the entry)',
      price: 20_600,
      entry: 20_600,
      offsetTicks: 0,
      moved: [],
      placed: { ...stop('sell', 20_600), role: 'exit' as const, parentId: null },
      kept: 0,
    };
    expect(breakevenDone(out, 'NQ Z6', 2)).toBe('Stop placed at breakeven 20,600.00 on NQ Z6');
  });

  it('says several stops and the ones already past it', () => {
    const out = {
      summary: '',
      price: 20_597.5,
      entry: 20_597.25,
      offsetTicks: 1,
      moved: [stop('sell', 20_597.5), stop('sell', 20_597.5)],
      kept: 1,
    };
    expect(breakevenDone(out, 'NQ Z6', 2)).toBe('2 stops to breakeven 20,597.50 on NQ Z6; 1 already past it stays');
  });
});
