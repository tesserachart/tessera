import type { Approval, OrderInput, OrderPreview } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from '../src/shell/ApprovalCard.tsx';
import {
  OrderEditError,
  draftOrderInput,
  editedOrderInput,
  orderEditOf,
  withLegOn,
  withOrderType,
} from '../src/shell/orderEdit.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';
import { BRACKET_ON } from './support/oco.ts';
import { patch } from '../src/app/store.ts';
import { tradeSettingsStore } from '../src/state/tradeSettings.ts';

const NQ = { tick: 0.25, tickValue: 5, decimals: 2 };

const input: OrderInput = {
  accountId: 'paper-main',
  instrument: 'NQZ6.CME',
  side: 'buy',
  qty: 1,
  orderType: 'limit',
  limitPrice: 20_601.25,
  tif: 'day',
};

const preview: OrderPreview = {
  request: {
    ...input,
    limitPrice: 20_601.25,
    stopPrice: null,
    tif: 'day',
    bracket: null,
    clientOrderId: null,
    reduceOnly: false,
  },
  environment: 'paper',
  restatement: 'BUY 1 NQZ6 LMT 20601.25 DAY',
  referencePrice: 20_641.25,
  estPrice: 20_601.25,
  estValue: null,
  estFees: null,
  riskToStop: null,
  buyingPowerAfter: null,
  positionAfter: 1,
  checks: [],
  createdAt: 0,
};

const draft = (over: Partial<Approval> = {}): Approval => ({
  id: 'a_1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'external', clientId: 'other' },
  sessionId: null,
  callId: 'c_1',
  tool: 'orders.submit',
  risk: 'financial',
  input,
  preview,
  previewHash: 'h1',
  draftId: 'd_1',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  createdAt: Date.now(),
  staleAt: Date.now() + 60_000,
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
  ...over,
});

describe('editing a drafted order', () => {
  it('reads only orders.submit inputs that are orders', () => {
    expect(draftOrderInput('orders.submit', input)).toEqual(input);
    expect(draftOrderInput('orders.modify', input)).toBeNull();
    expect(draftOrderInput('orders.submit', { account: 'paper-main', symbol: 'NQ', qty: 1 })).toBeNull();
  });

  it('puts an unchanged edit back exactly as drafted, bracket rules included', () => {
    const drafted: OrderInput = {
      ...input,
      bracket: {
        stopLoss: 20_591.25,
        takeProfit: null,
        targetTicks: 80,
        trail: { distanceTicks: 12, triggerTicks: 24, stepTicks: 4 },
      },
    };
    expect(editedOrderInput(drafted, orderEditOf(drafted, NQ), NQ)).toEqual(drafted);
  });

  it('switching to a stop moves the price it has to the stop and drops the limit', () => {
    const e = withOrderType(orderEditOf(input, NQ), 'stop', NQ, 20_641.3);
    const { limitPrice: _, ...rest } = input;
    expect(editedOrderInput(input, e, NQ)).toEqual({ ...rest, orderType: 'stop', stopPrice: 20_601.25 });
    const market = orderEditOf({ ...rest, orderType: 'market' }, NQ);
    expect(withOrderType(market, 'limit', NQ, 20_641.3).limitPrice).toBe('20,641.25');
  });

  it('a leg turned on starts at the trader’s distance from the entry, or from the fill on a market order', () => {
    const sell = { ...orderEditOf(input, NQ), side: 'sell' as const };
    expect(withLegOn(sell, 'stop', true, NQ, 40).stop).toEqual({ on: true, at: { kind: 'price', text: '20,611.25' } });
    const market = withOrderType(orderEditOf(input, NQ), 'market', NQ, null);
    expect(withLegOn(market, 'target', true, NQ, 80).target).toEqual({ on: true, at: { kind: 'ticks', ticks: 80 } });
  });

  it('a stop turned off takes its breakeven and trailing with it, and no legs means no bracket', () => {
    const drafted: OrderInput = {
      ...input,
      bracket: {
        stopLoss: 20_591.25,
        takeProfit: 20_621.25,
        breakeven: { triggerTicks: 20, offsetTicks: 1 },
        trail: { distanceTicks: 8, triggerTicks: 0, stepTicks: 1 },
      },
    };
    const noStop = withLegOn(orderEditOf(drafted, NQ), 'stop', false, NQ, 40);
    expect(editedOrderInput(drafted, noStop, NQ).bracket).toEqual({ stopLoss: null, takeProfit: 20_621.25 });
    const none = withLegOn(noStop, 'target', false, NQ, 80);
    expect(editedOrderInput(drafted, none, NQ)).not.toHaveProperty('bracket');
  });

  it('says what is missing instead of sending an order without its price', () => {
    const e = { ...orderEditOf(input, NQ), limitPrice: '' };
    expect(() => editedOrderInput(input, e, NQ)).toThrow(new OrderEditError('Enter a limit price'));
    const leg = { ...orderEditOf(input, NQ), stop: { on: true, at: { kind: 'price' as const, text: 'x' } } };
    expect(() => editedOrderInput(input, leg, NQ)).toThrow('Enter the stop’s price');
  });
});

describe('the draft card’s Edit on an order', () => {
  let request: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    request = vi.fn().mockResolvedValue({ approval: draft(), replacement: null });
    patch(tradeSettingsStore, { lastOco: { 'paper-main|NQ': BRACKET_ON } });
  });
  afterEach(() => {
    cleanup();
    patch(tradeSettingsStore, { lastOco: {} });
  });

  const mount = (a: Approval) =>
    render(
      <TestRuntime client={{ request: request as FakeClient['request'] }}>
        <ApprovalCard approval={a} more={0} sessionTitle={null} />
      </TestRuntime>,
    );
  const resolved = () => request.mock.calls.filter(([m]) => m === 'approvals.resolve').map(([, p]) => p as object);

  it('edits with the ticket’s controls, starting from the stop and target Approve would send', () => {
    mount(draft({ draftId: 'd_edit' }));
    expect(screen.getByRole('group', { name: 'Draft' }).textContent).toContain('Stop20,591.25');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('region', { name: 'Edit the draft' });
    expect(within(form).getByRole('button', { name: 'Buy' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(form).getByRole('button', { name: 'Limit' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(form).getByRole('textbox', { name: 'Limit price' })).toHaveProperty('value', '20,601.25');
    expect(within(form).getByRole('checkbox', { name: 'Stop' })).toHaveProperty('checked', true);
    expect(within(form).getByRole('textbox', { name: 'Stop price' })).toHaveProperty('value', '20,591.25');
    expect(within(form).getByRole('checkbox', { name: 'Target' })).toHaveProperty('checked', true);
    expect(within(form).getByRole('textbox', { name: 'Target price' })).toHaveProperty('value', '20,621.25');
    expect(within(form).queryByRole('textbox', { name: 'Side' })).toBeNull();

    fireEvent.click(within(form).getAllByRole('button', { name: 'Up a tick' })[0]!);
    fireEvent.click(within(form).getByRole('checkbox', { name: 'Target' }));
    act(() => fireEvent.click(within(form).getByRole('button', { name: 'Save' })));

    expect(resolved()).toMatchObject([
      {
        approvalId: 'a_1',
        decision: 'edit',
        previewHash: 'h1',
        input: { ...input, limitPrice: 20_601.5, bracket: { stopLoss: 20_591.25, takeProfit: null } },
      },
    ]);
  });

  it('keeps a leg the trader turned off in the form off: the edited draft gets nothing from the bracket', async () => {
    const edited = { ...input, bracket: { stopLoss: 20_591.25, takeProfit: null } };
    const { unmount } = mount(draft({ draftId: 'd_off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Target' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    unmount();
    mount(
      draft({
        id: 'a_2',
        draftId: 'd_off',
        input: edited,
        preview: { ...preview, request: { ...preview.request, bracket: { stopLoss: 20_591.25, takeProfit: null } } },
      }),
    );
    const card = screen.getByRole('group', { name: 'Draft' });
    expect(card.textContent).toContain('Stop20,591.25');
    expect(card.textContent).not.toContain('from your bracket');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('checkbox', { name: 'Target' })).toHaveProperty('checked', false);
  });

  it('still fills the legs of a draft whose edit failed', async () => {
    request = vi.fn(async (method: string) => {
      if (method === 'approvals.resolve') throw new Error('The draft changed; look again');
      return { approval: draft(), replacement: null };
    });
    mount(draft({ draftId: 'd_fail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Target' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Target' })).toHaveProperty('checked', false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('group', { name: 'Draft' }).textContent).toContain('stop and target from your bracket');
  });

  it('closes without a new draft when nothing changed, and keeps a missing price on the form', () => {
    mount(draft());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(resolved()).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Edit the draft' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Limit price' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(resolved()).toEqual([]);
    expect(screen.getByRole('alert').textContent).toBe('Enter a limit price');
  });
});
