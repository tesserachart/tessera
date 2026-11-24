import type { DraftInfo, Order, OrderPreview, OrderRequest } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { orderPreviewOf, ordersElsewhere, reduceDrafts, reduceOrders } from '../src/app/orders.ts';
import { assetClassLabel, venueLabel } from '../src/chart/identity.ts';
import { orderLines } from '../src/chart/orderLines.ts';
import { workingWords } from '../src/accounts/figures.ts';
import { paperAccount } from './support/accounts.ts';

const request = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  accountId: 'paper-main',
  instrument: 'QQQ',
  side: 'sell',
  qty: 100,
  orderType: 'limit',
  limitPrice: 489.9,
  stopPrice: null,
  tif: 'day',
  bracket: null,
  clientOrderId: null,
  reduceOnly: false,
  ...over,
});

const order = (id: string, status: Order['status'], over: Partial<OrderRequest> = {}, filledQty = 0): Order => ({
  id,
  brokerOrderId: null,
  draftId: null,
  request: request(over),
  role: 'entry',
  parentId: null,
  status,
  filledQty,
  avgFillPrice: null,
  queueAhead: null,
  triggeredAt: null,
  environment: 'paper',
  reason: null,
  createdAt: 1,
  updatedAt: 1,
});

const preview = (req: OrderRequest): OrderPreview => ({
  request: req,
  environment: 'paper',
  restatement: 'BUY 25 QQQ LMT 487.25 DAY',
  referencePrice: 487.85,
  estPrice: 487.25,
  estValue: null,
  estFees: null,
  riskToStop: null,
  buyingPowerAfter: null,
  positionAfter: null,
  checks: [],
  createdAt: 1,
});

const draft = (id: string, live: boolean, req: OrderRequest): DraftInfo => ({
  draftId: id,
  approvalId: `a_${id}`,
  tool: 'orders.submit',
  account: 'paper-main',
  environment: 'paper',
  instrument: req.instrument,
  preview: preview(req),
  live,
  status: live ? 'live' : 'cancelled',
  origin: { kind: 'agent', sessionId: 's1', provider: 'codex' },
  createdAt: 1,
  staleAt: 60,
  error: null,
});

describe('orders and drafts', () => {
  it('keeps open orders only; a fill or cancel removes the line', () => {
    let m = reduceOrders(new Map(), { order: order('o1', 'working') });
    m = reduceOrders(m, { order: order('o2', 'pending_submit') });
    expect([...m.keys()]).toEqual(['o1', 'o2']);
    m = reduceOrders(m, { order: order('o1', 'filled') });
    m = reduceOrders(m, { order: order('o2', 'cancelled') });
    expect(m.size).toBe(0);
  });

  it('groups the open orders of every account but the ticket’s, by account, in the accounts’ order', () => {
    const on = (id: string, accountId: string) => ({ ...order(id, 'working'), request: request({ accountId }) });
    const accounts = [
      paperAccount('paper-main'),
      paperAccount('paper-2', 'Paper 2'),
      paperAccount('paper-3', 'Paper 3'),
    ];
    const orders = [on('a', 'paper-3'), on('b', 'paper-main'), on('c', 'paper-2'), on('d', 'paper-3')];
    expect(
      ordersElsewhere(orders, 'paper-main', accounts).map((g) => [g.account.name, g.orders.map((o) => o.id)]),
    ).toEqual([
      ['Paper 2', ['c']],
      ['Paper 3', ['a', 'd']],
    ]);
    expect(ordersElsewhere(orders, 'paper-2', accounts).map((g) => g.account.id)).toEqual(['paper-main', 'paper-3']);
    expect([workingWords(0), workingWords(3)]).toEqual(['', '3 working']);
  });

  it('keeps drafts while they await a decision', () => {
    const req = request({ side: 'buy', qty: 25, limitPrice: 487.25 });
    let m = reduceDrafts(new Map(), draft('d1', true, req));
    expect(m.has('d1')).toBe(true);
    m = reduceDrafts(m, draft('d1', false, req));
    expect(m.size).toBe(0);
  });

  it('reads order previews and ignores drafts of other tools', () => {
    const req = request();
    expect(orderPreviewOf(draft('d1', true, req))?.request.qty).toBe(100);
    expect(orderPreviewOf({ ...draft('d2', true, req), preview: { amount: 5 } })).toBeNull();
    expect(orderPreviewOf({ ...draft('d3', true, req), preview: null })).toBeNull();
  });

  it('turns orders and drafts on the chart instrument into labelled lines', () => {
    const orders = [
      order('o1', 'working'),
      order('o2', 'partially_filled', { side: 'buy', orderType: 'stop', stopPrice: 480, limitPrice: null }, 40),
      order('o3', 'working', { orderType: 'market', limitPrice: null }),
      order('o4', 'working', { instrument: 'SPY' }),
    ];
    const drafts = [
      draft(
        'd1',
        true,
        request({ side: 'buy', qty: 25, limitPrice: 487.25, bracket: { stopLoss: 485.3, takeProfit: 489.9 } }),
      ),
    ];
    const lines = orderLines(orders, drafts, new Set(['QQQ']), 2);
    expect(lines).toEqual([
      {
        id: 'order:o1',
        price: 489.9,
        side: 'sell',
        qty: 100,
        label: 'Sell limit 489.90',
        note: 'working',
        draft: false,
      },
      {
        id: 'order:o2',
        price: 480,
        side: 'buy',
        qty: 60,
        label: 'Buy stop 480.00',
        note: 'partly filled',
        draft: false,
      },
      {
        id: 'draft:d1',
        price: 487.25,
        side: 'buy',
        qty: 25,
        role: 'entry',
        label: 'Buy limit 487.25',
        note: 'draft',
        draft: true,
      },
      {
        id: 'draft:d1:stop',
        price: 485.3,
        side: 'sell',
        qty: 25,
        role: 'stop',
        label: 'Stop 485.30',
        note: 'on fill',
        draft: true,
      },
      {
        id: 'draft:d1:target',
        price: 489.9,
        side: 'sell',
        qty: 25,
        role: 'target',
        label: 'Target 489.90',
        note: 'on fill',
        draft: true,
      },
    ]);
    const market = orderLines(
      [],
      [draft('d2', true, request({ orderType: 'market', limitPrice: null }))],
      new Set(['QQQ']),
      2,
    );
    expect(market[0]).toMatchObject({ price: 487.25, label: 'Sell market' });
  });

  it('prices a draft’s legs on the whole quantity, as design/screens/v4 shows them', () => {
    const nq = request({
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 2,
      limitPrice: 20615,
      bracket: { stopLoss: 20598, takeProfit: 20700 },
    });
    const lines = orderLines([], [draft('d1', true, nq)], new Set(['NQZ6.CME']), 2, 20);
    expect(lines.map((l) => [l.label, l.note])).toEqual([
      ['Buy limit 20,615.00', 'draft'],
      ['Stop 20,598.00', '−$680.00'],
      ['Target 20,700.00', '+$3,400.00'],
    ]);
  });
});

describe('instrument identity', () => {
  it('labels venues and asset classes from the catalog', () => {
    expect(venueLabel('NASDAQ')).toBe('Nasdaq');
    expect(venueLabel('CME')).toBe('CME');
    expect(assetClassLabel('etf')).toBe('ETF');
    expect(assetClassLabel('future')).toBe('Future');
  });
});
