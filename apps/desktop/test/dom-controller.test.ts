import type { CompactLevel, Order, Position } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { groupBrackets } from '../src/chart/brackets.ts';
import { FlowHub, type Emitter, type InstrumentFlow } from '../src/market/flow/hub.ts';
import { DomController, type DomActions, type DomContext } from '../src/orderflow/dom/domController.ts';
import { DEFAULT_DOM_PARAMS, ladderTags, type AccountGate, type Strip } from '../src/orderflow/dom/ladderModel.ts';
import { BAR_STEPS, LadderView } from '../src/orderflow/dom/ladderView.ts';
import { beginPlacement } from '../src/chart/placement.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';

const T0 = Date.parse('2026-10-02T14:42:00-04:00');
const ROW_H = 20;
const ROWS = 11;
const source = { provider: 'rithmic-test' };

const next = (changed: Emitter) =>
  new Promise<void>((resolve) => {
    const off = changed.on(() => {
      off();
      resolve();
    });
  });

interface Rig {
  flow: InstrumentFlow;
  ctrl: DomController;
  root: HTMLDivElement;
  ctx: DomContext;
  now: { t: number };
  actions: { [K in keyof DomActions]: ReturnType<typeof vi.fn> };
  strip: () => Strip | null;
  depth: (
    seq: number,
    kind: 'snapshot' | 'delta' | 'heartbeat',
    bids: CompactLevel[],
    asks: CompactLevel[],
  ) => Promise<void>;
  print: (seq: number, price: number, size: number, side: number) => Promise<void>;
  cell: (row: number, cls: 'bid' | 'ask' | 'p') => HTMLElement;
  pointer: (type: string, el: Element, row: number) => void;
}

const ES = 'ESZ6.CME';
const controllers: DomController[] = [];

function order(side: 'buy' | 'sell', price: number, qty = 1): Order {
  return {
    id: `o-${side}-${String(price)}`,
    brokerOrderId: null,
    draftId: null,
    request: {
      accountId: 'paper-main',
      instrument: ES,
      side,
      qty,
      orderType: 'limit',
      limitPrice: price,
      stopPrice: null,
      tif: 'day',
      bracket: null,
      clientOrderId: null,
      reduceOnly: false,
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
    createdAt: T0,
    updatedAt: T0,
  };
}

async function rig(
  gate: AccountGate = { kind: 'open', offPaper: false },
  orders: Order[] = [],
  positions: Position[] = [],
): Promise<Rig> {
  const rt = fakeRuntime();
  const now = { t: T0 };
  const hub = new FlowHub({ now: () => now.t });
  const { flow } = hub.acquire('ES', 0.25, 2);
  flow.useBook();
  flow.useTrades();
  const book = await vi.waitFor(() => rt.sub('market.depth'));
  const prints = await vi.waitFor(() => rt.sub('market.trades'));
  const root = document.createElement('div');
  document.body.appendChild(root);
  Object.defineProperty(root, 'clientHeight', { value: ROWS * ROW_H });
  root.setPointerCapture = () => undefined;
  const brackets = groupBrackets(orders, positions, [], new Set([ES, 'ES']));
  const ctx: DomContext = {
    params: { ...DEFAULT_DOM_PARAMS, volumeColumn: 'off' },
    gate,
    tags: ladderTags(brackets, 0.25),
    position: null,
    placing: null,
    quote: { bid: null, ask: null, last: null },
    dropped: () => null,
    closed: null,
    placingLine: () => ({ hint: '', error: null }),
    hoverTrade: (side, price) => ({
      side,
      price,
      kind: 'limit',
      qty: 1,
      risk: null,
      refusal: null,
      pnl: null,
      oco: null,
    }),
    decimals: 2,
    who: null,
  };
  let strip: Strip | null = null;
  const actions = {
    trade: vi.fn(() => Promise.resolve(null)),
    close: vi.fn(),
    endPlacement: vi.fn(),
    move: vi.fn(() => Promise.resolve(true)),
    spawn: vi.fn(),
    showDraft: vi.fn(),
    pickAccount: vi.fn(),
    setRowTicks: vi.fn(),
    cancelAll: vi.fn(),
    flatten: vi.fn(),
    strip: vi.fn((s: Strip | null) => {
      strip = s;
    }),
    edge: vi.fn(),
    columns: vi.fn(),
    loading: vi.fn(),
  };
  const view = new LadderView(root, root);
  const ctrl = new DomController(
    view,
    () => ctx,
    actions,
    () => ROW_H,
  );
  controllers.push(ctrl);
  ctrl.setFlow(flow, null);
  let tradeSeq = 0;
  const r: Rig = {
    flow,
    ctrl,
    root,
    ctx,
    now,
    actions,
    strip: () => strip,
    depth: (seq, kind, bids, asks) => {
      const took = next(flow.bookChanged);
      book.event(
        { instrument: ES, ts: 0, seq, kind, levels: 10, bids, asks, source },
        seq === 1 && kind === 'snapshot' ? 0 : seq,
      );
      return took;
    },
    print: (seq, price, size, side) => {
      const took = next(flow.tradesChanged);
      prints.event(
        { instrument: ES, seq, trades: [[now.t * 1e6, price, size, side]], source, aggressorSource: 'exchange' },
        tradeSeq++,
      );
      return took;
    },
    cell: (row, cls) => root.children[row]!.querySelector<HTMLElement>(`.${cls}`)!,
    pointer: (type, el, row) => {
      const e = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: row * ROW_H + 5, button: 0 });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      el.dispatchEvent(e);
    },
  };
  return r;
}

let restore: (() => void) | null = null;
beforeEach(() => {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const box = (top: number, height: number) =>
      ({
        left: 0,
        right: 300,
        top,
        bottom: top + height,
        width: 300,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    if (this.classList.contains('r') && this.parentElement) {
      const i = [...this.parentElement.children].indexOf(this);
      return box(i * ROW_H, ROW_H);
    }
    if (this.parentElement === document.body) return box(0, ROWS * ROW_H);
    return box(0, 0);
  };
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
  restore = () => {
    HTMLElement.prototype.getBoundingClientRect = real;
  };
});
afterEach(() => {
  for (const c of controllers.splice(0)) c.dispose();
  restore?.();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const BOOK: { bids: CompactLevel[]; asks: CompactLevel[] } = {
  bids: [
    [5812, 10],
    [5811.75, 20],
    [5811.5, 200],
  ],
  asks: [
    [5812.25, 8],
    [5812.5, 12],
  ],
};

async function live(r: Rig) {
  await r.depth(1, 'snapshot', BOOK.bids, BOOK.asks);
  await r.print(1, 5812, 2, 1);
  r.ctrl.frame();
}

describe('the DOM ladder live loop', () => {
  it('reports itself loading until the first book, with nothing in the strip, then live', async () => {
    const r = await rig();
    r.ctrl.frame();
    expect(r.actions.loading).toHaveBeenLastCalledWith(true);
    expect(r.strip()).toBeNull();
    await live(r);
    expect(r.actions.loading).toHaveBeenLastCalledWith(false);
    expect(r.actions.loading).toHaveBeenCalledTimes(2);
  });

  it('writes the rows from the book: the last price in the middle row, sizes in their cells', async () => {
    const r = await rig();
    await live(r);
    expect(r.root.children).toHaveLength(ROWS);
    const mid = r.root.children[5]!;
    expect(mid.className).toContain('is-last');
    expect(mid.className).toContain('is-bb');
    expect(mid.querySelector('.px')!.textContent).toBe('5,812.00');
    expect(mid.querySelector('.bid .sz')!.textContent).toBe('10');
    expect(r.root.children[4]!.querySelector('.ask .sz')!.textContent).toBe('8');
    expect(r.root.children[7]!.querySelector<HTMLElement>('.bid .bar')!.className).toBe(`bar w${String(BAR_STEPS)}`);
    expect(r.root.classList.contains('is-stale')).toBe(false);
  });

  it('shows what else it measures as its settings ask: traded at bid and ask, pulled and stacked, the last size', async () => {
    const r = await rig();
    await live(r);
    expect(r.root.classList.contains('has-traded')).toBe(false);
    expect(r.root.style.getPropertyValue('--lad-cols').split(' ').length).toBeGreaterThan(2);
    r.ctx.params = { ...r.ctx.params, traded: 'recent', pullStack: 10 };
    await r.print(2, 5812, 3, -1);
    r.ctrl.frame();
    expect(r.root.classList.contains('has-traded')).toBe(true);
    expect(r.root.classList.contains('has-ps')).toBe(true);
    const mid = r.root.children[5]!;
    expect(mid.querySelector('.tr.sold')!.textContent).toBe('3');
    expect(mid.querySelector('.tr.bought')!.textContent).toBe('2');
    expect(mid.querySelector('.p .ls')!.textContent).toBe('3');
    expect(r.root.children[4]!.querySelector('.p .ls')!.textContent).toBe('');
  });

  it('a press that holds sends once at the row price, through the trade action', async () => {
    const r = await rig();
    await live(r);
    const bid = r.cell(7, 'bid');
    r.pointer('pointerdown', bid, 7);
    r.pointer('pointerup', bid, 7);
    await Promise.resolve();
    expect(r.actions.trade).toHaveBeenCalledTimes(1);
    expect(r.actions.trade).toHaveBeenCalledWith('buy', 5811.5);
    const ask = r.cell(3, 'ask');
    r.pointer('pointerdown', ask, 3);
    r.pointer('pointerup', ask, 3);
    expect(r.actions.trade).toHaveBeenLastCalledWith('sell', 5812.5);
  });

  it('a press that straddles a scroll, or ends on another row, sends nothing and the strip says why', async () => {
    const r = await rig();
    await live(r);
    const bid = r.cell(7, 'bid');
    r.pointer('pointerdown', bid, 7);
    r.ctrl.scroll(1);
    r.ctrl.frame();
    r.pointer('pointerup', r.cell(7, 'bid'), 7);
    r.ctrl.frame();
    expect(r.actions.trade).not.toHaveBeenCalled();
    expect(r.strip()?.left).toBe('Price moved; nothing sent');

    r.pointer('pointerdown', r.cell(7, 'bid'), 7);
    r.pointer('pointerup', r.cell(8, 'bid'), 8);
    r.ctrl.frame();
    expect(r.actions.trade).not.toHaveBeenCalled();
    expect(r.strip()?.left).toBe('Released off the row; nothing sent');
  });

  it('with no depth message for 2 s the sizes dim and entries go inert; a heartbeat brings it back', async () => {
    const r = await rig();
    await live(r);
    r.now.t += 2500;
    r.ctrl.frame();
    expect(r.root.classList.contains('is-stale')).toBe(true);
    expect(r.root.classList.contains('is-inert')).toBe(true);
    expect(r.strip()?.left).toBe('Book 2.5 s behind');
    r.pointer('pointerdown', r.cell(7, 'bid'), 7);
    r.pointer('pointerup', r.cell(7, 'bid'), 7);
    r.ctrl.frame();
    expect(r.actions.trade).not.toHaveBeenCalled();
    expect(r.strip()?.left).toBe('Book stale; nothing sent');
    await r.depth(1, 'heartbeat', [], []);
    r.ctrl.frame();
    expect(r.root.classList.contains('is-stale')).toBe(false);
  });

  it('auto-centres when the price leaves the middle half, but never while the pointer is over the ladder', async () => {
    const r = await rig();
    await live(r);
    const top = r.ctrl.windowNow!.top;
    r.pointer('pointermove', r.cell(2, 'p'), 2);
    await r.print(2, 5813.5, 1, 1);
    r.ctrl.frame();
    expect(r.ctrl.windowNow!.top).toBe(top);
    expect(r.ctrl.wouldRecentre()).toBe(true);
    r.root.dispatchEvent(new MouseEvent('pointerleave'));
    r.ctrl.frame();
    expect(r.ctrl.rowOf(r.flow.grid.toTick(5813.5))).toBe(5);
  });

  it('holds the window under its row menu, and auto-centres once the pointer moves outside after it', async () => {
    const r = await rig();
    await live(r);
    const top = r.ctrl.windowNow!.top;
    r.pointer('pointermove', r.cell(2, 'p'), 2);
    r.ctrl.menuOpened();
    r.root.dispatchEvent(new MouseEvent('pointerleave'));
    await r.print(2, 5813.5, 1, 1);
    r.ctrl.frame();
    expect(r.ctrl.windowNow!.top).toBe(top);
    r.ctrl.menuClosed();
    r.ctrl.frame();
    expect(r.ctrl.windowNow!.top).toBe(top);
    document.dispatchEvent(new MouseEvent('pointermove', { clientX: 900, clientY: 900 }));
    r.ctrl.frame();
    expect(r.ctrl.rowOf(r.flow.grid.toTick(5813.5))).toBe(5);
  });

  it('a scroll pauses auto-centre until Space, and an edge marker shows where the price went', async () => {
    const r = await rig();
    await live(r);
    r.ctrl.scroll(-8);
    r.ctrl.frame();
    expect(r.actions.edge).toHaveBeenLastCalledWith([
      expect.objectContaining({ key: 'last', where: 'above', text: '5,812.00', label: 'Last price 5,812.00: centre' }),
    ]);
    await r.print(2, 5812.25, 1, 1);
    r.ctrl.frame();
    expect(r.ctrl.rowOf(r.flow.grid.toTick(5812.25))).toBeLessThan(0);
    r.ctrl.centre();
    r.ctrl.frame();
    expect(r.ctrl.rowOf(r.flow.grid.toTick(5812.25))).toBe(5);
    expect(r.actions.edge).toHaveBeenLastCalledWith([]);
  });

  it('marks an order below the ladder at its edge, and a click on the mark shows it and holds the view there', async () => {
    const r = await rig(undefined, [order('buy', 5790, 1)]);
    await live(r);
    const away = r.flow.grid.toTick(5790);
    expect(r.ctrl.rowOf(away)).toBeGreaterThan(10);
    expect(r.actions.edge).toHaveBeenLastCalledWith([
      expect.objectContaining({ where: 'below', role: 'entry', text: 'Buy 1 5,790.00', tick: away }),
    ]);
    const tag = r.root.querySelector<HTMLElement>('.tag');
    expect(tag).toBeNull();
    r.ctrl.show(away);
    r.ctrl.frame();
    expect(r.root.querySelector<HTMLElement>('.bid .tag')!.title).toBe('Your buy limit 1 · first in the queue');
    await r.print(2, 5812.25, 1, 1);
    r.ctrl.frame();
    expect(r.ctrl.rowOf(away)).toBeGreaterThanOrEqual(0);
    expect(r.actions.edge).toHaveBeenLastCalledWith([expect.objectContaining({ key: 'last', where: 'above' })]);
  });

  it('on an account Tessera only reads, the cells take no press and the tags have no ×', async () => {
    const r = await rig(
      { kind: 'readonly', why: 'Tessera reads this Apex account; orders are placed on its platform.' },
      [order('buy', 5811.75, 2)],
    );
    await live(r);
    expect(r.root.classList.contains('is-inert')).toBe(true);
    const tag = r.root.children[6]!.querySelector('.bid .tag')!;
    expect(tag.querySelector('.q')!.textContent).toBe('2');
    expect(tag.querySelector('.x')).toBeNull();
    r.pointer('pointerdown', r.cell(7, 'bid'), 7);
    r.pointer('pointerup', r.cell(7, 'bid'), 7);
    expect(r.actions.trade).not.toHaveBeenCalled();
    r.pointer('pointermove', r.cell(7, 'bid'), 7);
    r.ctrl.frame();
    expect(r.strip()?.left).toBe('Tessera reads this Apex account');
  });

  it('× on an order tag cancels it; a sell order sits in the ask gutter', async () => {
    const r = await rig({ kind: 'open', offPaper: false }, [order('sell', 5812.5, 3)]);
    await live(r);
    const tag = r.root.children[3]!.querySelector('.ask .tag')!;
    expect(tag.textContent).toContain('3');
    const x = tag.querySelector('.x')!;
    const e = new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 3 * ROW_H + 5 });
    x.dispatchEvent(e);
    expect(r.actions.close).toHaveBeenCalledTimes(1);
    expect((r.actions.close.mock.calls[0]![0] as { qty: number }).qty).toBe(3);
  });

  it('dragging an order tag to another row moves its orders by the rows it crossed; Esc ends a drag unsent', async () => {
    const r = await rig({ kind: 'open', offPaper: false }, [order('buy', 5811.75, 2)]);
    await live(r);
    const tag = r.root.children[6]!.querySelector('.bid .tag')!;
    r.pointer('pointerdown', tag, 6);
    r.pointer('pointermove', r.cell(8, 'bid'), 8);
    r.ctrl.frame();
    expect(r.root.children[8]!.querySelector('.bid .tag.is-ghost')).not.toBeNull();
    expect(r.root.children[6]!.querySelector('.bid .tag.is-moving')).not.toBeNull();
    r.pointer('pointerup', r.cell(8, 'bid'), 8);
    expect(r.actions.move).toHaveBeenCalledTimes(1);
    const [moved, from, to] = r.actions.move.mock.calls[0]! as [{ qty: number }, number, number];
    expect(moved.qty).toBe(2);
    expect(from).toBe(5811.75);
    expect(to).toBe(5811.25);
    await Promise.resolve();
    r.ctrl.frame();
    expect(r.root.children[8]!.querySelector('.bid .tag.is-ghost')).not.toBeNull();

    r.pointer('pointerdown', r.root.children[6]!.querySelector('.bid .tag')!, 6);
    r.pointer('pointermove', r.cell(9, 'bid'), 9);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    r.pointer('pointerup', r.cell(9, 'bid'), 9);
    expect(r.actions.move).toHaveBeenCalledTimes(1);
  });

  it('shows another account’s order dimmed under its name, and a press on it trades on that account, moving nothing', async () => {
    const r = await rig();
    await live(r);
    const theirs = { ...order('buy', 5811.75), request: { ...order('buy', 5811.75).request, accountId: 'paper-2' } };
    const account = { id: 'paper-2', name: 'Paper 2' };
    r.ctx.tags = ladderTags(groupBrackets([theirs], [], [], new Set([ES])), 0.25).map((t) => ({
      ...t,
      key: `paper-2:${t.key}`,
      orders: [],
      account,
    }));
    r.ctrl.frame();
    const tag = r.root.children[6]!.querySelector<HTMLElement>('.bid .tag.is-elsewhere')!;
    expect(tag.textContent).toBe('Paper 2 · 1');
    expect(tag.title).toBe('Trade on Paper 2');
    expect(tag.querySelector('.x')).toBeNull();
    r.pointer('pointerdown', tag, 6);
    r.pointer('pointermove', r.cell(8, 'bid'), 8);
    r.pointer('pointerup', r.cell(8, 'bid'), 8);
    expect(r.actions.pickAccount).toHaveBeenCalledWith('paper-2');
    expect(r.actions.move).not.toHaveBeenCalled();
    expect(r.actions.trade).not.toHaveBeenCalled();
  });

  it('dragging the position tag makes a leg at the row it is let go on', async () => {
    const r = await rig(
      { kind: 'open', offPaper: false },
      [],
      [
        {
          accountId: 'paper-main',
          instrument: ES,
          qty: 2,
          avgPrice: 5812,
          realizedPnl: { amount: 0, currency: 'USD' },
          unrealizedPnl: { amount: 0, currency: 'USD' },
          mark: 5812,
          openedAt: T0,
        },
      ],
    );
    await live(r);
    const pos = r.root.children[5]!.querySelector('.bid .tag.is-position')!;
    expect(pos.textContent).toContain('+2');
    r.pointer('pointerdown', pos, 5);
    r.pointer('pointermove', r.cell(9, 'bid'), 9);
    r.pointer('pointerup', r.cell(9, 'bid'), 9);
    expect(r.actions.spawn).toHaveBeenCalledWith(5811);
  });

  it('Esc during a press sends nothing', async () => {
    const r = await rig();
    await live(r);
    r.pointer('pointerdown', r.cell(7, 'bid'), 7);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    r.pointer('pointerup', r.cell(7, 'bid'), 7);
    expect(r.actions.trade).not.toHaveBeenCalled();
  });

  it('dropping the book clears the last instrument’s prices so a new name cannot wear them', async () => {
    const r = await rig();
    await live(r);
    expect(r.root.textContent).toContain('5,812.00');
    r.ctrl.setFlow(null, null);
    r.ctrl.frame();
    expect(r.root.textContent).not.toContain('5,812.00');
    expect(r.root.querySelectorAll('.r').length).toBe(0);
  });

  it('a connection without an order book: no trade cells, the strip says so', async () => {
    const r = await rig();
    r.flow.depthError = 'Paper offers no depth for ES';
    r.ctrl.frame();
    expect(r.root.classList.contains('is-nobook')).toBe(true);
    expect(r.strip()).toMatchObject({ left: 'This connection has no order book', action: { label: 'Connections' } });
  });

  it('names the account on the strip when more than one account can trade', async () => {
    const r = await rig();
    r.ctx.who = 'Apex 50K eval';
    await live(r);
    r.pointer('pointermove', r.cell(7, 'bid'), 7);
    r.ctrl.frame();
    expect(r.strip()).toMatchObject({ left: 'Buy limit 1 · 5,811.50', who: 'Apex 50K eval' });
  });

  describe('a right-click drops the order in hand', () => {
    const chord = (el: Element, row: number) => {
      const e = new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        clientX: 10,
        clientY: row * ROW_H + 5,
        button: 2,
        buttons: 3,
      });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      el.dispatchEvent(e);
    };
    const rightDown = (el: Element) =>
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2, buttons: 2 }));
    const menu = (el: Element) => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      el.dispatchEvent(e);
      return e;
    };

    it('a right press while dragging a tag moves nothing; let go without it, the tag moves', async () => {
      const r = await rig({ kind: 'open', offPaper: false }, [order('buy', 5811.75, 2)]);
      await live(r);
      const tag = () => r.root.children[6]!.querySelector('.bid .tag')!;
      r.pointer('pointerdown', tag(), 6);
      r.pointer('pointermove', r.cell(8, 'bid'), 8);
      chord(r.cell(8, 'bid'), 8);
      r.pointer('pointerup', r.cell(8, 'bid'), 8);
      expect(menu(r.cell(8, 'bid')).defaultPrevented).toBe(true);
      expect(r.actions.move).not.toHaveBeenCalled();

      r.pointer('pointerdown', tag(), 6);
      r.pointer('pointermove', r.cell(8, 'bid'), 8);
      r.pointer('pointerup', r.cell(8, 'bid'), 8);
      expect(r.actions.move).toHaveBeenCalledTimes(1);
    });

    it('a right press while pressing a bid sends nothing; let go without it, the bid sends', async () => {
      const r = await rig();
      await live(r);
      r.pointer('pointerdown', r.cell(7, 'bid'), 7);
      chord(r.cell(7, 'bid'), 7);
      r.pointer('pointerup', r.cell(7, 'bid'), 7);
      expect(r.actions.trade).not.toHaveBeenCalled();

      r.pointer('pointerdown', r.cell(7, 'bid'), 7);
      r.pointer('pointerup', r.cell(7, 'bid'), 7);
      expect(r.actions.trade).toHaveBeenCalledWith('buy', 5811.5);
    });

    it('a right press in the ladder ends its placement and opens no menu; with nothing in hand the menu opens', async () => {
      const r = await rig();
      await live(r);
      expect(menu(r.cell(7, 'bid')).defaultPrevented).toBe(false);
      expect(r.actions.endPlacement).not.toHaveBeenCalled();

      r.ctx.placing = beginPlacement({
        accountId: 'paper-main',
        environment: 'paper',
        instrument: ES,
        symbol: 'ES Z6',
        side: 'buy',
        qty: 1,
        kind: 'limit',
        tick: 0.25,
        decimals: 2,
        mode: 'qty',
        risk: 250,
        tickValue: 12.5,
        stopTicks: null,
        targetTicks: null,
      });
      const outside = document.createElement('div');
      document.body.appendChild(outside);
      rightDown(outside);
      expect(menu(outside).defaultPrevented).toBe(false);
      expect(r.actions.endPlacement).not.toHaveBeenCalled();

      rightDown(r.cell(7, 'bid'));
      expect(r.actions.endPlacement).toHaveBeenCalledTimes(1);
      expect(menu(r.cell(7, 'bid')).defaultPrevented).toBe(true);
    });
  });
});
