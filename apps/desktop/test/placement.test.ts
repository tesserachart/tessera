import type { Order, OrderRole, Position, Side } from '@tessera/protocol';
import { TOKENS } from '@tessera/ui';
import { describe, expect, it } from 'vitest';
import { bracketPalette, bracketTags, groupBrackets, type ChartMath } from '../src/chart/brackets.ts';
import {
  GHOST_ID,
  beginPlacement,
  entryKindAt,
  riskQty,
  dragRole,
  exitInput,
  legHostOf,
  legMoveError,
  placeAfterEntry,
  placeAt,
  placeGuide,
  placeKey,
  placementGhost,
  armedUnsentOn,
  chartHint,
  placeHint,
  placedTargetTicks,
  placementLimit,
  placementFor,
  placementHost,
  replaceInput,
  spawnPlan,
  withGhost,
  type PlaceBase,
  type PlaceQuote,
} from '../src/chart/placement.ts';

const NQ = 'NQZ6.CME';
const ids = new Set([NQ, 'NQ']);
const math: ChartMath = { decimals: 2, tick: 0.25, multiplier: 20 };
const pal = bracketPalette(TOKENS);
const q: PlaceQuote = { bid: 20650, ask: 20650.25, last: 20650 };

const base = (over: Partial<PlaceBase> = {}): PlaceBase => ({
  accountId: 'paper-main',
  environment: 'paper',
  instrument: NQ,
  symbol: 'NQ Z6',
  side: 'buy',
  qty: 2,
  kind: 'market',
  tick: 0.25,
  decimals: 2,
  mode: 'qty',
  risk: 250,
  tickValue: 5,
  stopTicks: null,
  targetTicks: null,
  ...over,
});

let n = 0;
function order(o: {
  side: Side;
  type: 'limit' | 'stop';
  price: number;
  qty?: number;
  role?: OrderRole;
  parent?: string | null;
  status?: Order['status'];
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
      tif: 'day',
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
  unrealizedPnl: { amount: 0, currency: 'USD' },
  mark: 20650,
  openedAt: 1_759_430_000_000,
});

describe('placing by clicks (Buy or Sell picks the side, the chart places)', () => {
  it('contracts, market: the next click sends it, with the OCO legs as ticks from wherever it fills', () => {
    const p = beginPlacement(base({ stopTicks: 40, targetTicks: 80 }));
    expect(p.stage).toBe('send');
    const step = placeAt(p, 20600, q, false);
    expect(step.kind).toBe('send');
    if (step.kind !== 'send') return;
    expect(step.input).toMatchObject({ side: 'buy', qty: 2, orderType: 'market' });
    expect(step.input.bracket).toEqual({ stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 });
  });

  it('contracts, limit: it goes at the click as the kind picked, never one the click chose', () => {
    const p = beginPlacement(base({ kind: 'limit', stopTicks: 40 }));
    expect(p.stage).toBe('entry');
    const step = placeAt(p, 20640.1, q, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') expect(step.input).toMatchObject({ orderType: 'limit', limitPrice: 20640, qty: 2 });
    const above = placeAt(p, 20660, q, false);
    expect(above.kind).toBe('send');
    if (above.kind === 'send') {
      expect(above.input).toMatchObject({ orderType: 'limit', limitPrice: 20650.25 });
      expect(above.input.bracket).toEqual({ stopLoss: null, takeProfit: null, stopTicks: 40 });
    }
    expect(placeGuide(p, 20660, q, false)).toMatchObject({
      price: 20650.25,
      error: null,
      note: 'Buy limit at the ask, 20,650.25: it fills now',
    });
    const sell = placeAt(beginPlacement(base({ kind: 'limit', side: 'sell' })), 20600, q, false);
    if (sell.kind === 'send') expect(sell.input).toMatchObject({ orderType: 'limit', limitPrice: 20650 });
  });

  it('contracts, stop: a buy stop above the ask goes at the click; under it, it is refused in words', () => {
    const p = beginPlacement(base({ kind: 'stop' }));
    const step = placeAt(p, 20660, q, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') expect(step.input).toMatchObject({ orderType: 'stop', stopPrice: 20660 });
    const under = placeAt(p, 20640, q, false);
    expect(under.kind).toBe('error');
    expect(under.next?.error).toMatch(/trigger at once/);
    const sell = placeAt(beginPlacement(base({ kind: 'stop', side: 'sell' })), 20640, q, false);
    if (sell.kind === 'send') expect(sell.input).toMatchObject({ orderType: 'stop', stopPrice: 20640 });
    expect(entryKindAt('buy', 20640, q)).toBe('limit');
  });

  it('contracts, stop limit: the click is its stop, its limit the ticket’s ticks past it, its legs from the limit', () => {
    const p = beginPlacement(base({ kind: 'stop_limit', limitTicks: 2, stopTicks: 40, targetTicks: 80 }));
    expect(p.stage).toBe('entry');
    expect(placeHint(p)).toBe("Click the buy stop limit's stop, above the ask, its limit 2 ticks above · Esc cancels");
    const step = placeAt(p, 20660, q, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') {
      expect(step.input).toMatchObject({ orderType: 'stop_limit', stopPrice: 20660, limitPrice: 20660.5, qty: 2 });
      expect(step.input.bracket).toEqual({ stopLoss: 20650.5, takeProfit: 20680.5 });
      expect(step.what).toBe('Buy 2 NQ Z6 stop 20,660.00 limit 20,660.50');
    }
    const under = placeAt(p, 20640, q, false);
    expect(under.kind === 'error' && under.next.error).toMatch(/^A buy stop limit at 20,640.00 is through the ask/);
    const sell = placeAt(beginPlacement(base({ kind: 'stop_limit', side: 'sell', limitTicks: 0 })), 20640, q, false);
    if (sell.kind === 'send') expect(sell.input).toMatchObject({ stopPrice: 20640, limitPrice: 20640 });
    expect(placementLimit({ kind: 'stop_limit', side: 'sell', entry: 20640, tick: 0.25, limitTicks: 3 })).toBe(
      20639.25,
    );
    expect(placementLimit({ kind: 'stop', side: 'sell', entry: 20640, tick: 0.25 })).toBeNull();
    const armed = { ...p, stage: 'stop' as const, entry: 20660, mode: 'risk' as const };
    const ghost = placementGhost(armed, 20650, [], q);
    expect(ghost?.host).toMatchObject({ entry: { type: 'stop limit', price: 20660 } });
  });

  it('risk, stop limit: the money sizes it from the limit, the worst it fills at', () => {
    const p = beginPlacement(base({ kind: 'stop_limit', mode: 'risk', risk: 200, limitTicks: 2 }));
    const first = placeAt(p, 20660, q, false);
    expect(first.kind).toBe('next');
    if (first.kind !== 'next') return;
    const second = placeAt(first.next, 20650.5, q, false);
    expect(second.kind === 'send' && second.input).toMatchObject({ qty: 1, stopPrice: 20660, limitPrice: 20660.5 });
  });

  it('risk, market: the click is the stop and the money sizes it; too far for one contract says so', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 300, targetTicks: 80 }));
    expect(p.stage).toBe('stop');
    const step = placeAt(p, 20640.25, q, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') {
      expect(step.input.qty).toBe(1);
      expect(step.input.bracket).toEqual({ stopLoss: 20640.25, takeProfit: null, targetTicks: 80 });
    }
    const far = placeAt(beginPlacement(base({ mode: 'risk', risk: 100 })), 20600, q, false);
    expect(far.kind).toBe('error');
    expect(riskQty({ risk: 1000, tick: 0.25, tickValue: 5 }, 20650, 20640)).toBe(5);
  });

  it('risk: $1,000 to a 28.25-point MNQ stop is 17 contracts, the money over the points times $2 a point', () => {
    const mnq = { tick: 0.25, tickValue: 0.5 };
    expect(riskQty({ ...mnq, risk: 1000 }, 20641.25, 20669.5)).toBe(17);
    expect(riskQty({ ...mnq, risk: 1_000_000 }, 20641.25, 20669.5)).toBe(17_699);
    const p = beginPlacement(base({ mode: 'risk', risk: 1000, side: 'sell', ...mnq, symbol: 'MNQ Z6' }));
    const step = placeAt(p, 20669.5, { bid: 20641.25, ask: 20641.5, last: 20641.25 }, false);
    expect(step.kind === 'send' && step.input).toMatchObject({ side: 'sell', qty: 17, bracket: { stopLoss: 20669.5 } });
  });

  it('risk: money too small for one contract to the stop is refused and says so, never sent as one', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 150 }));
    const step = placeAt(p, 20640.25, q, false);
    expect(step.kind).toBe('error');
    expect(step.kind === 'error' && step.next.error).toBe(
      'One contract to this stop risks $200.00, over the $150.00 at risk: click it closer',
    );
    expect(placeGuide(p, 20640.25, q, false).error).toBe(step.kind === 'error' ? step.next.error : null);
    expect(placeHint(beginPlacement(base({ mode: 'risk', risk: 1_000_000 })))).toBe(
      'Click the stop: $1,000,000.00 at risk sizes it · Esc cancels',
    );
  });

  it('risk, limit: the entry click, then the stop click sizes and sends it', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 500, kind: 'limit' }));
    const first = placeAt(p, 20640, q, false);
    expect(first.kind).toBe('next');
    if (first.kind !== 'next') return;
    expect(first.next.stage).toBe('stop');
    const second = placeAt(first.next, 20630, q, false);
    expect(second.kind).toBe('send');
    if (second.kind === 'send') expect(second.input).toMatchObject({ orderType: 'limit', limitPrice: 20640, qty: 2 });
  });

  it('names Enter the way the trader’s keyboard does in the stop step', () => {
    const p = { ...beginPlacement(base({ kind: 'limit' })), stage: 'stop' as const, entry: 20600 };
    expect(placeHint(p, 'other')).toBe(
      'Click to place the stop: the buy limit goes with it · Enter without a stop · Esc cancels',
    );
    expect(placeHint(p, 'mac')).toBe(
      'Click to place the stop: the buy limit goes with it · ⏎ without a stop · Esc cancels',
    );
  });

  it('risk, an add in grow mode: counted to the position’s stop, no stop clicked, the hint says so', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 300, targetTicks: 80, joinStop: 20640.25 }));
    expect(p.stage).toBe('send');
    expect(placeHint(p)).toBe(
      "Click the chart to buy at market: $300.00 at risk to the position's stop 20,640.25 · Esc cancels",
    );
    const step = placeAt(p, 20600, q, false);
    expect(step.kind).toBe('send');
    if (step.kind === 'send') {
      expect(step.input.qty).toBe(1);
      expect(step.input.bracket).toEqual({ stopLoss: 20640.25, takeProfit: null, targetTicks: 80 });
      expect(step.what).toBe('Buy 1 NQ Z6 at market');
    }
    const limit = beginPlacement(base({ mode: 'risk', risk: 500, kind: 'limit', joinStop: 20630.25 }));
    expect(limit.stage).toBe('entry');
    expect(placeHint(limit)).toBe(
      "Click the buy limit's price (above the ask it goes at the ask): $500.00 at risk to the position's stop 20,630.25 · Esc cancels",
    );
    const at = placeAt(limit, 20640.25, q, false);
    expect(at.kind === 'send' && at.input).toMatchObject({ orderType: 'limit', limitPrice: 20640.25, qty: 2 });
    const far = placeAt(beginPlacement(base({ mode: 'risk', risk: 50, joinStop: 20600 })), 20600, q, false);
    expect(far.kind === 'error' && far.next.error).toBe(
      "One contract to the position's stop risks $1,005.00, over the $50.00 at risk: raise the risk or move the stop",
    );
    const through = placeAt(beginPlacement(base({ mode: 'risk', risk: 500, joinStop: 20660 })), 20600, q, false);
    expect(through.kind).toBe('error');
    expect(beginPlacement(base({ joinStop: 20640.25 })).stage).toBe('send');
    expect(placeHint(beginPlacement(base({ joinStop: 20640.25 })))).toBe(
      'Click the chart to buy 2 at market · Esc cancels',
    );
  });

  it('risk: a target in money is the whole position’s, counted in ticks at the size the stop sets', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 500, kind: 'limit', targetTicks: 20, targetMoney: 100 }));
    const first = placeAt(p, 20640.25, q, false);
    if (first.kind !== 'next') throw new Error(first.kind);
    const second = placeAt(first.next, 20630.25, q, false);
    expect(second.kind).toBe('send');
    if (second.kind === 'send') {
      expect(second.input.qty).toBe(2);
      expect(second.input.bracket).toEqual({ stopLoss: 20630.25, takeProfit: 20642.75 });
    }
    expect(placedTargetTicks({ mode: 'risk', targetTicks: 20, tickValue: 5, qty: 2 })).toBe(20);
    expect(placedTargetTicks({ mode: 'qty', targetTicks: 8, targetMoney: 100, tickValue: 5, qty: 5 })).toBe(8);
    expect(placedTargetTicks({ mode: 'risk', targetTicks: 1, targetMoney: 6, tickValue: 5, qty: 5 })).toBe(1);
    expect(placedTargetTicks({ mode: 'risk', targetTicks: 30, targetMoney: 149, tickValue: 5, qty: 3 })).toBe(9);
    expect(placedTargetTicks({ mode: 'risk', targetTicks: null, targetMoney: 100, tickValue: 5, qty: 2 })).toBeNull();
  });

  it('risk: the pointer says before the click that a stop too far for one contract will be refused', () => {
    const p = beginPlacement(base({ mode: 'risk', risk: 100 }));
    const far = placeGuide(p, 20600, q, false);
    expect(far).toEqual({
      price: 20600,
      role: 'stop',
      error: 'One contract to this stop risks $1,005.00, over the $100.00 at risk: click it closer',
      note: null,
    });
    const click = placeAt(p, 20600, q, false);
    expect(click.kind === 'error' && click.next.error).toBe(far.error);
    expect(placeGuide(p, 20645.25, q, false).error).toBeNull();
    expect(placeGuide(p, 20642.75, q, false).error).toBe(
      'One contract to this stop risks $150.00, over the $100.00 at risk: click it closer',
    );
    expect(placeGuide(p, 20660, q, false).error).toMatch(/above/);
    expect(placeGuide(beginPlacement(base({ risk: 100 })), 20600, q, false).error).toBeNull();
    expect(
      placeGuide(placeAfterEntry(base({ mode: 'risk', risk: 100 }), 'o-1', 20650.25), 20600, q, true).error,
    ).toBeNull();
  });

  it('a wrong-side stop is refused; Esc ends at any stage', () => {
    const p = beginPlacement(base({ mode: 'risk' }));
    expect(placeAt(p, 20660, q, false).kind).toBe('error');
    expect(placeKey(p, 'Escape')).toEqual({ kind: 'end', next: null });
  });
});

describe('the line under a chart’s toasts', () => {
  it('says what the next click places, and only why it would be refused when it would', () => {
    const p = beginPlacement(base({ kind: 'limit' }));
    expect(chartHint(p, null, null)).toEqual({
      text: "Click the buy limit's price (above the ask it goes at the ask) · Esc cancels",
      tone: undefined,
    });
    expect(chartHint(p, null, null, 'Buy limit at the ask, 20,650.25: it fills now')).toEqual({
      text: 'Buy limit at the ask, 20,650.25: it fills now · Esc cancels',
      tone: 'info',
    });
    const why = 'Stop 20,709.50 is above the market (20,637.00): it would send at once';
    expect(chartHint(p, why, null)).toEqual({ text: why, tone: 'err' });
  });

  it('says a drag’s refusal while nothing is being placed, and nothing with nothing to say', () => {
    expect(chartHint(null, null, 'No room for a leg there')).toEqual({ text: 'No room for a leg there', tone: 'err' });
    expect(chartHint(null, null, null)).toBeNull();
  });
});

describe('a leg from a drag', () => {
  it('down from a long is its stop, up its target; a short mirrors; a leg that exists is moved', () => {
    expect(dragRole('buy', 100, 99)).toBe('stop');
    expect(dragRole('buy', 100, 101)).toBe('target');
    expect(dragRole('sell', 100, 99)).toBe('target');
    expect(dragRole('sell', 100, 101)).toBe('stop');
    expect(dragRole('buy', 100, 100)).toBeNull();
    const sl = order({ side: 'sell', type: 'stop', price: 20640, role: 'stop_loss', parent: 'e1' });
    const [b] = groupBrackets([sl], [position(2, 20650)], [], ids);
    expect(spawnPlan(b!, 20650, 20660)).toEqual({ role: 'target', move: null });
    expect(spawnPlan(b!, 20650, 20630)).toEqual({
      role: 'stop',
      move: { tagId: 'position:NQZ6.CME:stop', from: 20640, orders: [sl] },
    });
  });

  it('a position takes a reduce-only exit; a working entry is sent again with its legs', () => {
    const [pos] = groupBrackets([], [position(-3, 20650)], [], ids);
    const host = legHostOf(pos!, 'paper-main');
    expect(host).toMatchObject({ kind: 'position', side: 'sell', qty: 3, instrument: NQ });
    expect(legHostOf(pos!, null)).toBeNull();
    expect(exitInput(host as never, 'stop', 20670)).toEqual({
      accountId: 'paper-main',
      instrument: NQ,
      side: 'buy',
      qty: 3,
      orderType: 'stop',
      stopPrice: 20670,
      tif: 'day',
      reduceOnly: true,
    });
    expect(exitInput(host as never, 'target', 20600, 1)).toMatchObject({
      orderType: 'limit',
      limitPrice: 20600,
      qty: 1,
    });

    const e = order({ side: 'buy', type: 'limit', price: 20600, qty: 2, id: 'e9' });
    const trail = { distanceTicks: 8, triggerTicks: 0, stepTicks: 1 };
    e.request.bracket = { stopLoss: 20580, takeProfit: null, trail };
    const held = order({ side: 'sell', type: 'stop', price: 20585, role: 'stop_loss', parent: 'e9', status: 'held' });
    const [pending] = groupBrackets([e, held], [], [], ids);
    const eh = legHostOf(pending!, 'paper-main');
    expect(eh).toMatchObject({ kind: 'entry', stopLoss: 20585, takeProfit: null });
    expect(replaceInput(eh as never, 'target', 20640)).toEqual({
      accountId: 'paper-main',
      instrument: NQ,
      side: 'buy',
      qty: 2,
      orderType: 'limit',
      limitPrice: 20600,
      tif: 'day',
      bracket: { stopLoss: 20585, takeProfit: 20640, trail },
    });
    e.request.bracket = { stopLoss: null, takeProfit: null, stopTicks: 60, trail };
    expect(replaceInput(eh as never, 'target', 20640).bracket).toEqual({
      stopLoss: 20585,
      takeProfit: 20640,
      trail,
    });
    const exit = order({ side: 'sell', type: 'limit', price: 20700, role: 'take_profit' });
    expect(legHostOf(groupBrackets([exit], [], [], ids)[0]!, 'paper-main')).toBeNull();
  });

  it('a stop or target dragged through the market is refused before anything is sent', () => {
    const sl = order({ side: 'sell', type: 'stop', price: 20640, role: 'stop_loss', parent: 'e1' });
    const [long] = groupBrackets([sl], [position(1, 20650)], [], ids);
    expect(legMoveError(long!, 'stop', 20655, 20652, 2)).toBe(
      'Stop 20,655.00 is above the market (20,652.00): it would stop out at once',
    );
    expect(legMoveError(long!, 'stop', 20652, 20652, 2)).toMatch(/^Stop 20,652.00 is above the market/);
    expect(legMoveError(long!, 'stop', 20651.75, 20652, 2)).toBeNull();
    expect(legMoveError(long!, 'target', 20651, 20652, 2)).toBe(
      'Target 20,651.00 is below the market (20,652.00): it would fill at once',
    );
    expect(legMoveError(long!, 'target', 20660, 20652, 2)).toBeNull();
    expect(legMoveError(long!, 'stop', 20655, null, 2)).toBeNull();
    const [short] = groupBrackets([], [position(-1, 20650)], [], ids);
    expect(legMoveError(short!, 'stop', 20645, 20648, 2)).toMatch(/^Stop 20,645.00 is below the market \(20,648.00\)/);
    expect(legMoveError(short!, 'target', 20645, 20648, 2)).toBeNull();

    const e = order({ side: 'buy', type: 'limit', price: 20600, id: 'e7' });
    const held = order({ side: 'sell', type: 'stop', price: 20590, role: 'stop_loss', parent: 'e7', status: 'held' });
    const [pending] = groupBrackets([e, held], [], [], ids);
    expect(legMoveError(pending!, 'stop', 20605, 20700, 2)).toMatch(
      /^Stop 20,605.00 is above the market \(20,600.00\)/,
    );
    expect(legMoveError(pending!, 'stop', 20595, 20500, 2)).toBeNull();
  });

  it("finds a placement's host: its entry while it works, else the position on its side", () => {
    const e = order({ side: 'buy', type: 'limit', price: 20600, id: 'e5' });
    const p = { ...placeAfterEntry(base({ kind: 'limit' }), 'e5', 20600) };
    expect(placementHost(p, groupBrackets([e], [], [], ids))).toMatchObject({
      host: { kind: 'entry' },
      filled: false,
    });
    expect(placementHost(p, groupBrackets([], [position(1, 20600)], [], ids))).toMatchObject({
      host: { kind: 'position' },
      filled: true,
    });
    expect(placementHost(p, groupBrackets([], [position(-1, 20600)], [], ids))).toBeNull();
  });
});

describe('ghosts', () => {
  it('a new leg is drawn on its host with its money, and no ×', () => {
    const [b] = groupBrackets([], [position(1, 20650)], [], ids);
    const drawn = withGhost([b!], { host: { id: b!.id }, legs: [{ role: 'stop', price: 20640 }] });
    const tags = bracketTags(drawn, math, pal, { fanned: null, preview: null });
    expect(tags.map((t) => t.text)).toEqual(['Long 1 · 20,650.00 · $0.00', 'SL 20,640.00 · −$200.00 · 40t']);
    expect(tags[1]!.close).toBeNull();
    expect(tags[1]!.drag).toEqual([]);
  });

  it("a placement's entry is drawn where it would rest until it is sent, with the stop placed", () => {
    const p = beginPlacement(base({ kind: 'limit', qty: 1 }));
    const g = placementGhost(p, 20600.1, [], q);
    expect(g).toEqual({ host: { entry: { side: 'buy', price: 20600, qty: 1, type: 'limit' } }, legs: [] });
    const s = { ...p, stage: 'stop' as const, entry: 20600 };
    const drawn = withGhost([], placementGhost(s, 20590, [], q));
    expect(drawn[0]!.id).toBe(GHOST_ID);
    const tags = bracketTags(drawn, math, pal, { fanned: null, preview: null });
    expect(tags.map((t) => t.text)).toEqual(['Buy limit 1 · 20,600.00', 'SL 20,590.00 · −$200.00 · 40t']);
    expect(tags.every((t) => t.close === null && t.drag.length === 0)).toBe(true);
    const after = placeAfterEntry(base(), 'm1', 20650);
    const [pos] = groupBrackets([], [position(2, 20650)], [], ids);
    expect(placementGhost(after, 20640, [pos!], q)).toEqual({
      host: { id: pos!.id },
      legs: [{ role: 'stop', price: 20640 }],
    });
  });
});

describe('which chart takes a placement’s clicks', () => {
  const ids = new Set([NQ, 'NQ']);
  const A1 = { layoutId: 'ws-a', tileId: 'chart-1' };
  it('only the chart whose ticket armed it, on its account and instrument', () => {
    const p = { ...beginPlacement(base()), ...A1 };
    expect(placementFor(p, 'paper-main', ids, A1)).toBe(p);
    expect(placementFor(p, 'paper-main', ids, { ...A1, tileId: 'chart-2' })).toBeNull();
    expect(placementFor(p, 'eval-50k', ids, A1)).toBeNull();
    expect(placementFor(p, 'paper-main', new Set(['ESZ6.CME']), A1)).toBeNull();
    expect(placementFor(null, 'paper-main', ids, A1)).toBeNull();
  });

  it('another workspace’s tile of the same id never takes it', () => {
    const p = { ...beginPlacement(base()), ...A1 };
    expect(placementFor(p, 'paper-main', ids, { layoutId: 'ws-b', tileId: 'chart-1' })).toBeNull();
  });

  it('a placement started without a tile is taken by any chart of its account and instrument', () => {
    const p = beginPlacement(base());
    expect(p.tileId).toBeUndefined();
    expect(placementFor(p, 'paper-main', ids, { ...A1, tileId: 'chart-2' })).toBe(p);
    expect(placementFor(p, null, ids, { ...A1, tileId: 'chart-2' })).toBeNull();
  });

  it('the arming ticket drops what it armed only while nothing of it is at the broker', () => {
    const p = { ...beginPlacement(base()), ...A1 };
    expect(armedUnsentOn(p, A1)).toBe(true);
    expect(armedUnsentOn(p, { ...A1, layoutId: 'ws-b' })).toBe(false);
    expect(armedUnsentOn(p, { ...A1, tileId: 'chart-2' })).toBe(false);
    expect(armedUnsentOn({ ...p, busy: true }, A1)).toBe(false);
    expect(armedUnsentOn({ ...placeAfterEntry(base(), 'm1', 20650), ...A1 }, A1)).toBe(false);
    expect(armedUnsentOn(beginPlacement(base()), A1)).toBe(false);
    expect(armedUnsentOn(null, A1)).toBe(false);
  });
});
