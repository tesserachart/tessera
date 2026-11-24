import type { AccountUpdate, Fill, Money, Order, Position, Side } from '@tessera/protocol';

const usd = (amount: number): Money => ({ amount, currency: 'USD' });

function sampleAccount(
  id: string,
  displayName: string,
  connection: string,
  balance: number,
  day: number,
): AccountUpdate {
  return {
    account: {
      id,
      displayName,
      environment: 'paper',
      brokerId: 'rithmic',
      connectionId: connection,
      programId: null,
      ruleSetId: null,
      currency: 'USD',
      restrictions: { noCopyTrading: false, blockedInstruments: [], loosenNextSession: false },
      groupId: null,
      externalRefMasked: null,
    },
    summary: {
      accountId: id,
      balance: usd(balance),
      netLiq: usd(balance + day),
      dayPnl: usd(day),
      realizedToday: usd(day),
      feesToday: usd(0),
      unrealizedToday: usd(0),
      openPnl: usd(0),
      buyingPower: usd(balance),
      asOf: 0,
    },
    risk: null,
  };
}

export const SAMPLE_ACCOUNTS: readonly AccountUpdate[] = [
  sampleAccount('sample-1', 'Paper 50K Main', 'Rithmic Paper Trading', 50_000, 1_250),
  sampleAccount('sample-2', 'Evaluation 150K', 'Rithmic Paper Trading', 150_000, -420),
  sampleAccount('sample-3', 'Paper 25K', 'Rithmic Paper Trading', 25_000, 0),
];

export const SAMPLE_RESTING = 'Long 1 NQ Z6 · 1 working';

function samplePosition(instrument: string, qty: number, avgPrice: number, mark: number): Position {
  return {
    accountId: 'sample-1',
    instrument,
    qty,
    avgPrice,
    mark,
    unrealizedPnl: usd((mark - avgPrice) * qty * 20),
    realizedPnl: usd(250),
    openedAt: 0,
  };
}

export const SAMPLE_POSITIONS: readonly Position[] = [
  samplePosition('NQZ6.CME', 2, 21_480.25, 21_502.75),
  samplePosition('ESZ6.CME', -1, 6_012.5, 6_004.25),
];

export const SAMPLE_ORDERS: readonly Order[] = [
  {
    id: 'sample-order',
    brokerOrderId: null,
    draftId: null,
    role: 'stop_loss',
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
    request: {
      accountId: 'sample-1',
      instrument: 'NQZ6.CME',
      side: 'sell',
      qty: 2,
      orderType: 'stop',
      limitPrice: null,
      stopPrice: 21_440.25,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: true,
    },
  },
];

function sampleFill(id: string, instrument: string, side: Side, price: number): Fill {
  return {
    id,
    brokerFillId: null,
    orderId: null,
    accountId: 'sample-1',
    instrument,
    side,
    qty: 1,
    price,
    ts: 0,
    fee: usd(0),
    realizedPnl: usd(125),
    source: 'paper',
  };
}

export const SAMPLE_FILLS: readonly Fill[] = [
  sampleFill('sample-fill-1', 'NQZ6.CME', 'buy', 21_480.25),
  sampleFill('sample-fill-2', 'ESZ6.CME', 'sell', 6_012.5),
];
