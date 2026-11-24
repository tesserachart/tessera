import type { AccountUpdate, Order, Position, Side } from '@tessera/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRACKET_ON } from './support/oco.ts';
import { groupBrackets } from '../src/chart/brackets.ts';
import { bindChartKeys, liveOrderKeys, orderKeyCommands, takenKeys } from '../src/chart/ticket/commands.ts';
import { runOrderKey } from '../src/chart/ticket/orderKeys.ts';
import { quickOrder, reverseBracket, reverseOf, reverseTip, type TicketSend } from '../src/chart/ticket/send.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import { bindTileKeys, type DomKeys } from '../src/orderflow/tileKeys.ts';
import {
  DEFAULT_ORDER_KEYS,
  keyConflicts,
  orderHotkeysOf,
  orderHotkeysValue,
  shortcutOfEvent,
  type OrderHotkeys,
  type OrderKeyAction,
} from '../src/shell/orderHotkeys.ts';
import { endPlacement, placementStore } from '../src/state/placement.ts';
import { DEFAULT_TICKET } from '../src/state/tickets.ts';
import { read } from '../src/app/store.ts';
import { wireOrder } from './support/orders.ts';
import { pause } from './support/pause.ts';
import { setTestServices, type FakeClient } from './support/runtime.tsx';

const target = { layoutId: 'L1', tileId: 'chart-1' };
vi.mock(import('../src/workspace/controller.ts'), async (original) => ({
  ...(await original()),
  activeChartTarget: () => target,
}));

const on: OrderHotkeys = { enabled: true, keys: DEFAULT_ORDER_KEYS };
const off: OrderHotkeys = { enabled: false, keys: DEFAULT_ORDER_KEYS };

/** On a Mac ⌥W types ∑; its place is still KeyW. */
function press(key: string, code: string, mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }) {
  return {
    key,
    code,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  endPlacement();
});

describe('off until the user turns them on', () => {
  it('reads anything it cannot as off, with the default keys', () => {
    for (const v of [undefined, null, 'on', { enabled: 'yes' }, { keys: { buyMarket: 'alt+w' } }])
      expect(orderHotkeysOf(v)).toEqual(off);
    expect(orderHotkeysOf({ enabled: true, keys: { flatten: 'f12', reverse: 7, junk: 'alt+j' } })).toEqual({
      enabled: true,
      keys: { ...DEFAULT_ORDER_KEYS, flatten: 'f12' },
    });
  });

  it('binds keys that do nothing while off, and prints none in the tooltips', () => {
    const order = vi.fn();
    const unbind = bindChartKeys(target.tileId, { breakeven: vi.fn(), canBreakeven: () => false, order });
    const registry = new CommandRegistry();
    registry.registerAll(orderKeyCommands(off, []));
    expect(registry.handleKey(press('w', 'KeyW', { alt: true }), 'chart', 'other', false)).toBeNull();
    expect(order).not.toHaveBeenCalled();
    expect(liveOrderKeys(off, [], 'other')).toEqual({});
    expect(liveOrderKeys(on, [], 'other')).toEqual(DEFAULT_ORDER_KEYS);
    unbind();
  });
});

describe('only on the focused chart or DOM ladder, never while typing', () => {
  it('sends from the chart with the focus, and never from the panel, the desk or a field', () => {
    const order = vi.fn<(a: OrderKeyAction) => void>();
    const unbind = bindChartKeys(target.tileId, { breakeven: vi.fn(), canBreakeven: () => false, order });
    const registry = new CommandRegistry();
    registry.registerAll(orderKeyCommands(on, []));
    const altW = press('∑', 'KeyW', { alt: true });
    expect(registry.handleKey(altW, 'chart', 'mac', false)).toBe('chart.order.buyMarket');
    expect(order).toHaveBeenLastCalledWith('buyMarket');
    for (const zone of ['ticket', 'global', 'agent', 'sidebar'] as const)
      expect(registry.handleKey(altW, zone, 'mac', false), zone).toBeNull();
    expect(registry.handleKey(altW, 'chart', 'mac', true)).toBeNull();
    expect(registry.handleKey({ ...altW, repeat: true }, 'chart', 'mac', false)).toBe('chart.order.buyMarket');
    expect(order).toHaveBeenCalledOnce();
    for (const [key, code, action] of [
      ['q', 'KeyQ', 'buyBid'],
      ['s', 'KeyS', 'sellMarket'],
      ['a', 'KeyA', 'sellAsk'],
      ['z', 'KeyZ', 'reverse'],
      ['x', 'KeyX', 'flatten'],
      ['c', 'KeyC', 'cancelAll'],
    ] as const) {
      registry.handleKey(press(key, code, { alt: true }), 'chart', 'other', false);
      expect(order).toHaveBeenLastCalledWith(action);
    }
    unbind();
    expect(registry.handleKey(altW, 'chart', 'mac', false)).toBeNull();
  });

  it('sends from the DOM ladder with the focus only', () => {
    const el = document.createElement('div');
    el.tabIndex = 0;
    document.body.append(el);
    const order = vi.fn<(a: OrderKeyAction) => void>();
    const keys = { order, sends: () => true } as unknown as DomKeys;
    const unbind = bindTileKeys('dom', el, keys);
    const registry = new CommandRegistry();
    registry.registerAll(orderKeyCommands(on, []));
    const altX = press('x', 'KeyX', { alt: true });
    el.focus();
    el.blur();
    expect(registry.handleKey(altX, 'dom', 'other', false)).toBeNull();
    el.focus();
    expect(registry.handleKey(altX, 'dom', 'other', false)).toBe('dom.order.flatten');
    expect(order).toHaveBeenCalledWith('flatten');
    expect(registry.handleKey(altX, 'dom', 'other', true)).toBeNull();
    unbind();
  });

  it('keeps every order key out of ⌘K', () => {
    expect(orderKeyCommands(on, []).every((c) => c.hidden && (c.zone === 'chart' || c.zone === 'dom'))).toBe(true);
  });
});

describe('remapped in Settings, with conflicts refused', () => {
  it('clashes with nothing the desk, the chart or the DOM answers to, on a Mac and elsewhere', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry, { focusComposer: () => undefined });
    const taken = takenKeys(registry.all());
    expect(taken.length).toBeGreaterThan(30);
    expect(keyConflicts(DEFAULT_ORDER_KEYS, taken, 'mac')).toEqual({});
    expect(keyConflicts(DEFAULT_ORDER_KEYS, taken, 'other')).toEqual({});
    expect(registry.get('chart.order.reverse')?.shortcut).toBe('alt+z');
    expect(registry.get('dom.order.buyBid')?.shortcut).toBe('alt+q');
  });

  it('says why a key cannot be one', () => {
    const taken = [
      { shortcut: 'alt+t', zone: 'chart', title: 'Trend line' },
      { shortcut: 'mod+shift+f', zone: 'dom', title: 'Flatten the ladder’s instrument' },
      { shortcut: 'alt+j', zone: 'agent', title: 'Something of the analyst’s' },
    ];
    const withKey = (action: OrderKeyAction, key: string) =>
      keyConflicts({ ...DEFAULT_ORDER_KEYS, [action]: key }, taken, 'mac');
    expect(withKey('sellMarket', 'alt+w')).toEqual({
      buyMarket: 'Also Sell market’s key',
      sellMarket: 'Also Buy market’s key',
    });
    expect(withKey('flatten', 'x').flatten).toBe('Add ⌥, ⌃ or ⌘: a plain key types');
    expect(withKey('flatten', 'shift+x').flatten).toBe('Add ⌥, ⌃ or ⌘: a plain key types');
    expect(withKey('flatten', 'mod+w').flatten).toBe('Kept by the browser or the system');
    expect(withKey('flatten', 'escape').flatten).toBe('Kept for moving and closing');
    expect(withKey('reverse', 'alt+t').reverse).toBe('Taken by Trend line');
    expect(withKey('flatten', 'mod+shift+f').flatten).toBe('Taken by Flatten the ladder’s instrument');
    expect(withKey('reverse', 'alt+j')).toEqual({});
    expect(withKey('flatten', 'f9')).toEqual({});
    expect(keyConflicts({ ...DEFAULT_ORDER_KEYS, flatten: 'x' }, taken, 'other').flatten).toBe(
      'Add Alt or Ctrl: a plain key types',
    );
    expect(withKey('flatten', 'f12').flatten).toBe('Kept by the browser or the system');
    expect(withKey('flatten', 'mod+shift+9')).toEqual({});
  });

  it('leaves a key with a problem unbound, the others working', () => {
    const cmds = orderKeyCommands({ enabled: true, keys: { ...DEFAULT_ORDER_KEYS, flatten: 'alt+w' } }, []);
    const byId = Object.fromEntries(cmds.map((c) => [c.id, c]));
    expect(byId['chart.order.flatten']!.shortcut).toBeUndefined();
    expect(byId['chart.order.buyMarket']!.shortcut).toBeUndefined();
    expect(byId['chart.order.reverse']!.shortcut).toBe('alt+z');
  });

  it('records a key from its place, with its modifiers, as the platform names them', () => {
    expect(shortcutOfEvent(press('∑', 'KeyW', { alt: true }), 'mac')).toBe('alt+w');
    expect(shortcutOfEvent(press('F9', 'F9', { meta: true, shift: true }), 'mac')).toBe('mod+shift+f9');
    expect(shortcutOfEvent(press('F9', 'F9', { ctrl: true, shift: true }), 'other')).toBe('mod+shift+f9');
    expect(shortcutOfEvent(press('Alt', 'AltLeft', { alt: true }), 'other')).toBeNull();
  });

  it('stores only the keys moved from their defaults, a key back at its default as null', () => {
    expect(orderHotkeysValue({ enabled: true, keys: { ...DEFAULT_ORDER_KEYS, flatten: 'f12' } })).toEqual({
      enabled: true,
      keys: {
        buyMarket: null,
        buyBid: null,
        sellMarket: null,
        sellAsk: null,
        reverse: null,
        flatten: 'f12',
        cancelAll: null,
      },
    });
  });
});

const NQ = 'NQZ6.CME';
const account = {
  account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper', currency: 'USD' },
  summary: { netLiq: { amount: 50_000, currency: 'USD' }, dayPnl: { amount: 0, currency: 'USD' } },
  risk: null,
} as unknown as AccountUpdate;

function position(qty: number, avg: number): Position {
  return {
    accountId: 'paper-main',
    instrument: NQ,
    qty,
    avgPrice: avg,
    realizedPnl: { amount: 0, currency: 'USD' },
    unrealizedPnl: null,
    mark: null,
    openedAt: 1_759_430_000_000,
  };
}

function ticket(over: Partial<TicketSend> = {}, p: Position | null = null, orders: Order[] = []): TicketSend {
  return {
    account,
    instrument: NQ,
    symbol: 'NQ Z6',
    math: { tick: 0.25, tickValue: 5, decimals: 2 },
    setup: { ...DEFAULT_TICKET, qty: 2 },
    oco: BRACKET_ON,
    quote: { bid: 20_630, ask: 20_630.25, last: 20_630.25 },
    brackets: groupBrackets(orders, p ? [p] : [], [], new Set([NQ])),
    mode: 'grow',
    tile: target,
    ...over,
  };
}

function runtime(output: unknown = {}) {
  const request = vi.fn().mockResolvedValue({ callId: 'c1', status: 'ok', ok: true, output });
  const client = { request } as unknown as FakeClient;
  setTestServices(client);
  return { request, client };
}

describe('a market entry’s bracket is its distances, never prices from the quote the page last saw', () => {
  const bracketOf = (t: TicketSend, side: Side, o: 'market' | 'touch') => {
    const out = quickOrder(t, side, o);
    if (!('input' in out)) throw new Error(out.error);
    return out.input.bracket;
  };
  const wide = {
    ...BRACKET_ON,
    stop: { ...BRACKET_ON.stop, value: 160 },
    target: { ...BRACKET_ON.target, value: 320 },
  };

  it('sends 40/80 and 160/320 ticks, buying or selling, from a fresh page or a lagging one', () => {
    const fresh = { bid: 20_623.75, ask: 20_624, last: 20_624 };
    const lagging = { bid: 20_688.25, ask: 20_688.5, last: 20_688.5 };
    for (const quote of [fresh, lagging]) {
      for (const side of ['buy', 'sell'] as const) {
        expect(bracketOf(ticket({ quote }), side, 'market')).toEqual({
          stopLoss: null,
          takeProfit: null,
          stopTicks: 40,
          targetTicks: 80,
        });
        expect(bracketOf(ticket({ quote, oco: wide }), side, 'market')).toEqual({
          stopLoss: null,
          takeProfit: null,
          stopTicks: 160,
          targetTicks: 320,
        });
      }
    }
  });

  it('a limit that joins the touch rests, so its legs stay prices from its own price', () => {
    expect(bracketOf(ticket(), 'buy', 'touch')).toEqual({ stopLoss: 20_620, takeProfit: 20_650 });
  });
});

describe('a key sends what its button sends', () => {
  it('reverses a long to a short of its size at market, with the panel’s bracket as ticks from the short’s fill', async () => {
    const out = {
      summary: 'Reversed long 2 NQZ6 to short 2 at 20,630.00',
      side: 'sell' as Side,
      qty: 2,
      cancelled: [],
      closing: wireOrder({ role: 'exit', status: 'filled', request: { side: 'sell', qty: 2 } }),
      entry: wireOrder({ status: 'filled', avgFillPrice: 20_630, request: { side: 'sell', qty: 2 } }),
      bracket: [],
    };
    const { request } = runtime(out);
    const report = vi.fn();
    const t = ticket({}, position(2, 20_600));
    expect(reverseTip(reverseOf(t.brackets[0]!), 'NQ Z6', true)).toBe(
      'Reverse the long 2 NQ Z6 to short 2 at market, with the bracket',
    );
    runOrderKey('reverse', t, report);
    await pause();
    expect(request.mock.calls[0]!.slice(0, 2)).toMatchObject([
      'tools.invoke',
      {
        name: 'orders.reverse',
        input: {
          accountId: 'paper-main',
          instrument: NQ,
          bracket: { stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 },
        },
        surface: { armed: true, holdConfirmed: false },
        idempotencyKey: expect.any(String),
        deadline: expect.any(Number),
      },
    ]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: 'ok',
        text: 'Reverse the long 2 NQ Z6: short 2 at 20,630.00',
        what: 'Reverse the long 2 NQ Z6',
      }),
    );
  });

  it('reverses a short to a long, and does nothing but say so when flat', async () => {
    const t = ticket({}, position(-1, 20_650));
    const view = reverseOf(t.brackets[0]!);
    expect(view).toEqual({ why: null, side: 'buy', qty: 1 });
    expect(reverseBracket(t, view)).toEqual({ stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 });
    const { request } = runtime();
    const report = vi.fn();
    runOrderKey('reverse', ticket(), report);
    await pause();
    expect(request).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({ tone: 'info', text: 'Reverse: no NQ Z6 position' });
    expect(reverseOf(null).why).toBe('No position');
  });

  it('buys at market for the panel’s size with its bracket; by risk it arms the chart as the button does', async () => {
    const filled = wireOrder({ status: 'filled', avgFillPrice: 20_630.25, request: { qty: 2 } });
    const legs = [
      wireOrder({ role: 'stop_loss', request: { side: 'sell', orderType: 'stop', stopPrice: 20_620.25 } }),
      wireOrder({ role: 'take_profit', request: { side: 'sell', orderType: 'limit', limitPrice: 20_650.25 } }),
    ];
    const { request } = runtime({ order: filled, bracket: legs });
    const report = vi.fn();
    runOrderKey('buyMarket', ticket(), report);
    await pause();
    expect(request.mock.calls[0]![1]).toMatchObject({
      name: 'orders.submit',
      input: {
        accountId: 'paper-main',
        instrument: NQ,
        side: 'buy',
        qty: 2,
        orderType: 'market',
        bracket: { stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 },
      },
    });
    expect(report.mock.calls[0]![0]).toMatchObject({
      tone: 'ok',
      text: 'Buy 2 NQ Z6 at market · SL 20,620.25 · TP 20,650.25: filled at 20,630.25',
      order: filled,
      what: 'Buy 2 NQ Z6 at market · SL 20,620.25 · TP 20,650.25',
    });
    request.mockClear();
    runOrderKey('sellAsk', ticket({ setup: { ...DEFAULT_TICKET, sizing: 'risk', risk: 250 } }), report);
    await pause();
    expect(request).not.toHaveBeenCalled();
    expect(read(placementStore).placing).toMatchObject({
      side: 'sell',
      kind: 'limit',
      entry: 20_630.25,
      mode: 'risk',
      tileId: 'chart-1',
    });
  });

  it('joins the bid with a limit, flattens and cancels as exits, and says why when nothing can go', async () => {
    const working = { status: 'working', avgFillPrice: null, request: { bracket: null } };
    const { request } = runtime({ order: working, bracket: [{}, {}] });
    const report = vi.fn();
    runOrderKey('buyBid', ticket(), report);
    await pause();
    expect(request.mock.calls[0]![1].input).toMatchObject({ side: 'buy', orderType: 'limit', limitPrice: 20_630 });
    request.mockClear();
    request.mockResolvedValue({ callId: 'c2', status: 'ok', ok: true, output: { flat: true } });
    runOrderKey('flatten', ticket({}, position(2, 20_600)), report);
    await pause();
    expect(request.mock.calls[0]![1]).toMatchObject({
      name: 'orders.flatten',
      input: { accountId: 'paper-main', instrument: NQ },
      surface: { armed: true, holdConfirmed: false },
      idempotencyKey: expect.any(String),
      deadline: expect.any(Number),
    });
    request.mockClear();
    runOrderKey('flatten', ticket(), report);
    runOrderKey('cancelAll', ticket(), report);
    await pause();
    expect(request).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({ tone: 'info', text: 'Nothing to flatten on NQ Z6' });
    expect(report).toHaveBeenCalledWith({ tone: 'info', text: 'No working NQ Z6 orders' });
    runOrderKey('sellMarket', { why: 'Tessera only reads this account.' }, report);
    expect(report).toHaveBeenLastCalledWith({
      tone: 'err',
      text: 'Sell market: Tessera only reads this account. Nothing sent.',
    });
    runOrderKey('sellAsk', ticket({ quote: { bid: 20_630, ask: null, last: 20_630 } }), report);
    expect(report).toHaveBeenLastCalledWith({ tone: 'err', text: 'Sell ask: No ask for NQ Z6 yet. Nothing sent.' });
    runOrderKey('buyMarket', ticket({ quote: { bid: null, ask: null, last: null } }), report);
    expect(report).toHaveBeenLastCalledWith({
      tone: 'err',
      text: 'Buy market: No price for NQ Z6 yet. Nothing sent.',
    });
    await pause();
    expect(request).not.toHaveBeenCalled();
  });
});
