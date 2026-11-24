import type { Order, OrderRequest } from '@tessera/protocol';

let n = 0;

export function wireOrder(over: Partial<Omit<Order, 'request'>> & { request?: Partial<OrderRequest> } = {}): Order {
  n += 1;
  const { request, ...rest } = over;
  return {
    id: `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 1,
      orderType: 'market',
      limitPrice: null,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
      ...request,
    },
    role: 'entry',
    parentId: null,
    status: 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
    triggeredAt: null,
    environment: 'paper',
    reason: null,
    createdAt: 0,
    updatedAt: 0,
    ...rest,
  };
}
