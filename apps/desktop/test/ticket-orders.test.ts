import type { Order, OrderRole, OrderStatus, Position, Side } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { groupBrackets, type ChartMath } from '../src/chart/brackets.ts';
import { cancelSelection, positionReadout, tradeRows, workingCount } from '../src/chart/ticket/tradeRows.ts';
import { submittedWords } from '../src/shell/tradeActions.ts';

const NQ = 'NQZ6.CME';
const ids = new Set([NQ, 'NQ']);
const math: ChartMath = { decimals: 2, tick: 0.25, multiplier: 20 };

let n = 0;
function order(o: {
  side: Side;
  type: 'limit' | 'stop' | 'market';
  price: number | null;
  qty?: number;
  role?: OrderRole;
  parent?: string | null;
  status?: OrderStatus;
  id?: string;
}): Order {
  n += 1;
  return {
    id: o.id ?? `o${String(n)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: NQ,
      side: o.side,
      qty: o.qty ?? 1,
      orderType: o.type,
      limitPrice: o.type === 'limit' ? o.price : null,
      stopPrice: o.type === 'stop' ? o.price : null,
      tif: 'gtc',
      bracket: null,
      clientOrderId: null,
      reduceOnly: o.role === 'stop_loss' || o.role === 'take_profit',
    },
    role: o.role ?? 'entry',
    parentId: o.parent ?? null,
    status: o.status ?? 'working',
    filledQty: 0,
    avgFillPrice: null,
    queueAhead: null,
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
  unrealizedPnl: { amount: -295, currency: 'USD' },
  mark: 20651,
  openedAt: 1_759_430_000_000,
});

describe('the ticket’s trade under its verbs', () => {
  it('reads the position over its legs, each leg with its money and its own ×', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'e1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20674.75, role: 'take_profit', parent: 'e1' });
    const rows = tradeRows(groupBrackets([sl, tp], [position(1, 20651)], [], ids), math);
    expect(rows.map((r) => [r.kind, r.words, r.money])).toEqual([
      ['position', 'Long 1 @ 20,651.00', -295],
      ['leg', 'Stop 20,640.75', -205],
      ['leg', 'Target 20,674.75', 475],
    ]);
    expect(rows[0]!.cancels).toEqual([]);
    expect(rows[1]!.cancels).toEqual([sl]);
    expect(rows[2]!.cancels).toEqual([tp]);
    expect(rows[0]!.instrument).toBe(NQ);
    expect(workingCount(rows)).toBe(2);
  });

  it('a working entry carries its held legs, which go with it', () => {
    const e = order({ side: 'buy', type: 'limit', price: 20600, qty: 2, id: 'e2' });
    const sl = order({
      side: 'sell',
      type: 'stop',
      price: 20590,
      qty: 2,
      role: 'stop_loss',
      parent: 'e2',
      status: 'held',
    });
    const tp = order({
      side: 'sell',
      type: 'limit',
      price: 20620,
      qty: 1,
      role: 'take_profit',
      parent: 'e2',
      status: 'held',
    });
    const rows = tradeRows(groupBrackets([e, sl, tp], [], [], ids), math);
    expect(rows.map((r) => [r.kind, r.words, r.held])).toEqual([
      ['order', 'Buy limit 2 @ 20,600.00', false],
      ['leg', 'Stop 20,590.00', true],
      ['leg', 'Target 1 @ 20,620.00', true],
    ]);
    expect(rows[0]!.cancels).toEqual([e]);
    expect(rows[1]!.cancels).toEqual([]);
    expect(workingCount(rows)).toBe(1);
  });

  it('leaves the position’s own row to the panel’s read-out and keeps its stop and target', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'e1' });
    const e = order({ side: 'buy', type: 'limit', price: 20600, id: 'e3' });
    const held = order({ side: 'sell', type: 'stop', price: 20590, role: 'stop_loss', parent: 'e3', status: 'held' });
    const brackets = groupBrackets([sl, e, held], [position(1, 20651)], [], ids);
    const rows = tradeRows(brackets, math, { position: false });
    expect(rows.map((r) => [r.kind, r.of, r.words])).toEqual([
      ['leg', 'position', 'Stop 20,640.75'],
      ['order', null, 'Buy limit 1 @ 20,600.00'],
      ['leg', 'order', 'Stop 20,590.00'],
    ]);
    expect(positionReadout(brackets, math)).toEqual({
      words: '+1 @ 20,651.00',
      qty: 1,
      pnl: -295,
      instrument: NQ,
    });
    expect(positionReadout(groupBrackets([], [position(-3, 20651)], [], ids), math)).toMatchObject({
      words: '−3 @ 20,651.00',
      qty: -3,
    });
    expect(positionReadout([], math)).toEqual({ words: 'Flat', qty: 0, pnl: null, instrument: null });
  });

  it('says no money where the contract’s value is unknown, and nothing at all when flat', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss' });
    const rows = tradeRows(groupBrackets([sl], [position(1, 20651)], [], ids), { ...math, multiplier: null });
    expect(rows[1]).toMatchObject({ words: 'Stop 20,640.75', money: null });
    expect(tradeRows(groupBrackets([], [], [], ids), math)).toEqual([]);
  });
});

describe('what the panel’s Cancel takes (the open position’s protection stays)', () => {
  const sel = (orders: Order[], positions: Position[]) =>
    cancelSelection(tradeRows(groupBrackets(orders, positions, [], ids), math, { position: false }));

  it('on a long, leaves its stop and target and takes the working entry (its held legs go with it)', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'f1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20674.75, role: 'take_profit', parent: 'f1' });
    const e = order({ side: 'buy', type: 'limit', price: 20600, id: 'e10' });
    const held = order({ side: 'sell', type: 'stop', price: 20590, role: 'stop_loss', parent: 'e10', status: 'held' });
    expect(sel([sl, tp, e, held], [position(1, 20651)])).toEqual({ orders: [e], kept: 2 });
  });

  it('on a short, the same: its buy stop above and buy target below stay', () => {
    const sl = order({ side: 'buy', type: 'stop', price: 20661, role: 'stop_loss', parent: 'f2' });
    const tp = order({ side: 'buy', type: 'limit', price: 20630, role: 'take_profit', parent: 'f2' });
    const e = order({ side: 'sell', type: 'stop', price: 20620, id: 'e11' });
    expect(sel([sl, tp, e], [position(-2, 20651)])).toEqual({ orders: [e], kept: 2 });
  });

  it('takes a working entry’s legs that already work, and every order when there is no position', () => {
    const e = order({ side: 'buy', type: 'limit', price: 20600, id: 'e12', status: 'partially_filled' });
    const leg = order({ side: 'sell', type: 'stop', price: 20590, role: 'stop_loss', parent: 'e12' });
    const lone = order({ side: 'sell', type: 'limit', price: 20700 });
    const all = sel([e, leg, lone], []);
    expect(all.kept).toBe(0);
    expect(new Set(all.orders)).toEqual(new Set([e, leg, lone]));
  });

  it('has nothing to cancel when only the position’s protection works', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640.75, role: 'stop_loss', parent: 'f3' });
    expect(sel([sl], [position(1, 20651)])).toEqual({ orders: [], kept: 1 });
    expect(sel([], [position(1, 20651)])).toEqual({ orders: [], kept: 0 });
  });
});

describe('the panel in grow mode (decision 0015)', () => {
  it('a working add says it joins the position’s bracket; never in each-entry mode or on a flat contract', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640, qty: 2, role: 'stop_loss', parent: 'e1' });
    const tp = order({ side: 'sell', type: 'limit', price: 20700, qty: 2, role: 'take_profit', parent: 'e1' });
    const add = order({ side: 'buy', type: 'limit', price: 20645, qty: 3, id: 'e2' });
    const brackets = groupBrackets([sl, tp, add], [position(2, 20651)], [], ids);
    const rows = tradeRows(brackets, math, { position: false, mode: 'grow' });
    expect(rows.map((r) => [r.words, r.joins ?? false])).toEqual([
      ['Stop 20,640.00', false],
      ['Target 20,700.00', false],
      ['Buy limit 3 @ 20,645.00', true],
    ]);
    expect(tradeRows(brackets, math, { position: false, mode: 'per_entry' }).some((r) => r.joins)).toBe(false);
    expect(tradeRows(brackets, math, { position: false }).some((r) => r.joins)).toBe(false);
    const flat = groupBrackets([add], [], [], ids);
    expect(tradeRows(flat, math, { mode: 'grow' }).some((r) => r.joins)).toBe(false);
  });

  it('a grown bracket lists one stop and one target of the whole size; each-entry pairs say their sizes', () => {
    const grown = groupBrackets(
      [
        order({ side: 'sell', type: 'stop', price: 20544.75, qty: 31, role: 'stop_loss', parent: 'e1' }),
        order({ side: 'sell', type: 'limit', price: 20806, qty: 31, role: 'take_profit', parent: 'e1' }),
      ],
      [position(31, 20555.87)],
      [],
      ids,
    );
    expect(tradeRows(grown, math, { position: false, mode: 'grow' }).map((r) => r.words)).toEqual([
      'Stop 20,544.75',
      'Target 20,806.00',
    ]);
    const each = groupBrackets(
      [
        order({ side: 'sell', type: 'stop', price: 20544.75, qty: 13, role: 'stop_loss', parent: 'e1' }),
        order({ side: 'sell', type: 'stop', price: 20531, qty: 5, role: 'stop_loss', parent: 'e2' }),
        order({ side: 'sell', type: 'limit', price: 20806, qty: 13, role: 'take_profit', parent: 'e1' }),
        order({ side: 'sell', type: 'limit', price: 20806.75, qty: 5, role: 'take_profit', parent: 'e2' }),
      ],
      [position(18, 20555.87)],
      [],
      ids,
    );
    expect(tradeRows(each, math, { position: false, mode: 'per_entry' }).map((r) => r.words)).toEqual([
      'Stop 13 @ 20,544.75',
      'Stop 5 @ 20,531.00',
      'Target 13 @ 20,806.00',
      'Target 5 @ 20,806.75',
    ]);
  });
});

describe('what a send says (decision 0015)', () => {
  it('an add sent without its legs joins the position’s bracket; an entry with its legs names them as the chart tags do', () => {
    const input = {
      accountId: 'paper-main',
      instrument: NQ,
      side: 'buy' as const,
      qty: 2,
      orderType: 'limit' as const,
      limitPrice: 20617.5,
      bracket: { stopLoss: 20607.5, takeProfit: 20637.5 },
    };
    const what = 'Buy 2 NQ Z6 limit 20,617.50';
    const add = order({ side: 'buy', type: 'limit', price: 20617.5, qty: 2 });
    expect(submittedWords(what, input, { order: add, bracket: [] }, 2)).toBe(
      "Buy 2 NQ Z6 limit 20,617.50, joining the position's bracket",
    );
    const stop = order({ side: 'sell', type: 'stop', price: 20607.5, qty: 2, role: 'stop_loss', parent: add.id });
    const target = order({ side: 'sell', type: 'limit', price: 20637.5, qty: 2, role: 'take_profit', parent: add.id });
    const own: Order = { ...add, request: { ...add.request, bracket: input.bracket } };
    expect(submittedWords(what, input, { order: own, bracket: [target, stop] }, 2)).toBe(
      'Buy 2 NQ Z6 limit 20,617.50 · SL 20,607.50 · TP 20,637.50',
    );
    expect(submittedWords(what, input, { order: own, bracket: [stop] }, 2)).toBe(
      'Buy 2 NQ Z6 limit 20,617.50 · SL 20,607.50',
    );
    const unpriced = order({ side: 'sell', type: 'market', price: null, qty: 2, role: 'take_profit', parent: add.id });
    expect(submittedWords(what, input, { order: own, bracket: [stop, unpriced] }, 2)).toBe(
      'Buy 2 NQ Z6 limit 20,617.50 · SL 20,607.50 · TP 20,637.50',
    );
    const { bracket: _none, ...plain } = input;
    expect(submittedWords('Buy 2 NQ Z6 at market', plain, { order: add, bracket: [] }, 2)).toBe(
      'Buy 2 NQ Z6 at market',
    );
    const inTicks = {
      ...plain,
      orderType: 'market' as const,
      bracket: { stopLoss: null, takeProfit: null, stopTicks: 40 },
    };
    expect(submittedWords('Buy 2 NQ Z6 at market', inTicks, { order: add, bracket: [] }, 2)).toBe(
      "Buy 2 NQ Z6 at market, joining the position's bracket",
    );
    const native: Order = { ...add, request: { ...add.request, bracket: inTicks.bracket } };
    expect(submittedWords('Buy 2 NQ Z6 at market', inTicks, { order: native, bracket: [] }, 2)).toBe(
      'Buy 2 NQ Z6 at market · SL 40 ticks from the fill',
    );
  });
});
