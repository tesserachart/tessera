import type { AccountUpdate, Side } from '@tessera/protocol';
import { PlatformProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BracketSection } from '../src/chart/ticket/BracketSection.tsx';
import { OrderGrid } from '../src/chart/ticket/OrderGrid.tsx';
import { DayReadout } from '../src/chart/ticket/Ticket.tsx';
import { TicketOrders } from '../src/chart/ticket/TicketOrders.tsx';
import type { PositionReadout, TradeRow } from '../src/chart/ticket/tradeRows.ts';
import type { TicketModel } from '../src/chart/ticket/useTicketModel.ts';
import type { ReadoutStale } from '../src/shell/freshness.ts';
import { planOco, type OcoConfig, type OcoMarket } from '../src/shell/oco.ts';
import { BRACKET_ON } from './support/oco.ts';
import type { GridOrder } from '../src/shell/ticket.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { DEFAULT_TICKET, ticketOf, ticketsStore } from '../src/state/tickets.ts';
import { read } from '../src/app/store.ts';

afterEach(cleanup);

const nq: OcoMarket = { tick: 0.25, tickValue: 5, decimals: 2, qty: 1, balance: 50_000 };

function bracket(over: Partial<Parameters<typeof BracketSection>[0]> = {}) {
  const onChange = vi.fn<(oco: OcoConfig) => void>();
  const onOpen = vi.fn<(open: boolean) => void>();
  const onRulesOpen = vi.fn<(open: boolean) => void>();
  const oco = over.oco ?? BRACKET_ON;
  const props = {
    oco,
    onChange,
    plan: planOco(oco, nq),
    market: nq,
    entry: 20_660.25,
    riskSizing: false,
    open: true,
    onOpen,
    rulesOpen: false,
    onRulesOpen,
    ...over,
  };
  const view = render(<BracketSection {...props} />);
  return { ...view, onChange, onOpen, onRulesOpen };
}

describe('the panel’s bracket', () => {
  it('shows its legs as rows: on or off, the unit, the distance, and where each lands under its name', () => {
    const { container } = bracket();
    const legs = [...container.querySelectorAll('.tk-leg')];
    expect(legs.map((l) => l.getAttribute('data-role'))).toEqual(['stop', 'target']);
    expect(legs[0]!.querySelector('.help')?.textContent).toBe('20,650.25 · $200.00');
    expect(legs[1]!.querySelector('.help')?.textContent).toBe('20,680.25 · $400.00');
    expect(screen.getByRole('textbox', { name: 'Stop distance' })).toHaveProperty('value', '40');
    expect(screen.getByRole('switch', { name: 'Bracket' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Breakeven')).toBeNull();
    expect(container.querySelector('.tk-err')).toBeNull();
  });

  it('converts a leg to the unit picked from its field’s menu and takes a distance as typed', () => {
    const { onChange } = bracket();
    const unit = screen.getByRole('button', { name: 'Stop unit: Ticks' });
    expect(unit.textContent).toBe('t');
    fireEvent.keyDown(unit, { key: 'Enter' });
    expect(screen.getAllByRole('menuitemradio').map((r) => [r.textContent, r.getAttribute('aria-checked')])).toEqual([
      ['Tickst', 'true'],
      ['Pointspt', 'false'],
      ['Dollars$', 'false'],
      ['% of the balance%', 'false'],
    ]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Dollars/ }));
    expect(onChange.mock.lastCall![0].stop).toEqual({ on: true, unit: 'usd', value: 200 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Target distance' }), { target: { value: '60' } });
    expect(onChange.mock.lastCall![0].target).toEqual({ on: true, unit: 'ticks', value: 60 });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Stop distance' }), { key: 'ArrowUp', shiftKey: true });
    expect(onChange.mock.lastCall![0].stop.value).toBe(44);
  });

  it('folds as the user leaves it, saying its legs in a few words; off, it is its head and switch alone', () => {
    const folded = bracket({ open: false });
    expect(folded.container.querySelector('.tk-leg')).toBeNull();
    expect(folded.container.querySelector('.tk-fold .sum')?.textContent).toBe('40 t · 80 t');
    fireEvent.click(screen.getByRole('button', { name: /Bracket/ }));
    expect(folded.onOpen).toHaveBeenCalledWith(true);
    cleanup();
    const off = bracket({ oco: { ...BRACKET_ON, on: false } });
    expect(off.container.querySelector('.tk-sec-body')).toBeNull();
    expect(off.container.querySelector('.tk-fold .chev')).toBeNull();
    expect(screen.getByRole('button', { name: /Bracket/ })).toHaveProperty('disabled', true);
  });

  it('by risk, the stop is the one clicked on the chart', () => {
    const { container } = bracket({ riskSizing: true });
    const stop = container.querySelector('.tk-leg[data-role="stop"]');
    expect(stop?.textContent).toBe('StopClicked on the chart');
    expect(screen.queryByRole('textbox', { name: 'Stop distance' })).toBeNull();
  });

  it('by risk, a target in ticks or points stays a distance: no price or money before a stop or size exists', () => {
    for (const target of [BRACKET_ON.target, { on: true, unit: 'points' as const, value: 20 }]) {
      const { container } = bracket({ riskSizing: true, oco: { ...BRACKET_ON, target } });
      const row = container.querySelector('.tk-leg[data-role="target"]')!;
      expect(row.querySelector('.help'), target.unit).toBeNull();
      expect(row.textContent, target.unit).not.toMatch(/\$|20,6\d\d/);
      expect(screen.getByRole('textbox', { name: 'Target distance' })).toHaveProperty('value', String(target.value));
      cleanup();
    }
  });

  it('by risk, a target in money is the whole size’s until the stop is clicked', () => {
    const oco = { ...BRACKET_ON, target: { on: true, unit: 'usd' as const, value: 400 } };
    const { container } = bracket({ riskSizing: true, oco });
    expect(container.querySelector('.tk-leg[data-role="target"] .help')?.textContent).toBe('For the whole size');
    expect(screen.getByRole('button', { name: 'Target unit: Dollars' }).textContent).toBe('$');
  });

  it('offers % of the balance only with the balance known', () => {
    bracket({ market: { ...nq, balance: null } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Target unit: Ticks' }), { key: 'Enter' });
    expect(screen.getByRole('menuitemradio', { name: /% of the balance/ }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: /Points/ }).getAttribute('aria-disabled')).toBeNull();
  });

  it('keeps breakeven and trailing under More, their sentences in tooltips, and names the rules in force folded', () => {
    const on = { ...BRACKET_ON, breakeven: { on: true, trigger: 20, offset: 1 } };
    const folded = bracket({ oco: on });
    expect(folded.container.querySelector('.tk-more .sum')?.textContent).toBe('Breakeven 20');
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(folded.onRulesOpen).toHaveBeenCalledWith(true);
    cleanup();
    const { onChange, container } = bracket({ oco: on, rulesOpen: true });
    expect(container.querySelectorAll('.tk-rule')).toHaveLength(3);
    expect(container.textContent).not.toMatch(/ticks of profit/);
    for (const name of [
      'Trailing distance in ticks',
      'Ticks of profit before trailing starts',
      'Trailing step in ticks',
    ])
      expect(screen.getByRole('textbox', { name })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Breakeven trigger in ticks' }), { target: { value: '24' } });
    expect(onChange.mock.lastCall![0].breakeven).toEqual({ on: true, trigger: 24, offset: 1 });
    cleanup();
    const trailing = { ...on, trail: { on: true, ticks: 20, trigger: 0, step: 1 } };
    const t = bracket({ oco: trailing, rulesOpen: true });
    fireEvent.change(screen.getByRole('textbox', { name: 'Ticks of profit before trailing starts' }), {
      target: { value: '30' },
    });
    expect(t.onChange.mock.lastCall![0].trail).toEqual({ on: true, ticks: 20, trigger: 30, step: 1 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Trailing step in ticks' }), { target: { value: '4' } });
    expect(t.onChange.mock.lastCall![0].trail).toEqual({ on: true, ticks: 20, trigger: 0, step: 4 });
  });

  it('says what keeps it from going in one quiet line, folded or not', () => {
    const bad = { ...BRACKET_ON, stop: { on: true, unit: 'usd' as const, value: 1 } };
    const { container } = bracket({ oco: bad, open: false, extraErrors: ['Target 1 is below the market'] });
    expect(container.querySelectorAll('.tk-err')).toHaveLength(1);
    expect(container.querySelector('.tk-err')?.textContent).toBe(
      'Stop: under 1 tick (one tick is $5.00 at 1) · Target 1 is below the market',
    );
  });
});

function model(over: Partial<Record<string, unknown>> = {}) {
  const press = vi.fn<(side: Side, o: GridOrder) => void>();
  const cancelHere = vi.fn();
  const flattenHere = vi.fn();
  const breakevenHere = vi.fn();
  const reverseHere = vi.fn();
  const m = {
    setup: { ...DEFAULT_TICKET },
    symbol: 'NQ Z6',
    dp: 2,
    bid: 20_630.25,
    ask: 20_630.5,
    armed: (side: Side, o: GridOrder) => side === 'sell' && o === 'stop_limit',
    press,
    off: (side: Side, o: GridOrder) => side === 'buy' && o === 'stop',
    tip: (side: Side, o: GridOrder) => `${side} ${o}`,
    position: { words: 'Long 1', qty: 1, pnl: null, instrument: 'NQZ6.CME' },
    cancelOff: true,
    flatOff: false,
    beOff: false,
    cancelTip: 'No working NQ Z6 orders',
    flatTip: 'Close the long 1 NQ Z6 at market and cancel its orders',
    beTip: 'Move the stop to breakeven: 20,631.25, the entry + 4 ticks',
    revOff: false,
    revTip: 'Reverse the long 1 NQ Z6 to short 1 at market, with the bracket',
    stale: { position: null, prices: null },
    cancelHere,
    flattenHere,
    breakevenHere,
    reverseHere,
    ...over,
  } as unknown as TicketModel;
  return { m, press, cancelHere, flattenHere, breakevenHere, reverseHere };
}

describe('the order grid', () => {
  it('lays a Buy and a Sell out for each order, then Cancel, Breakeven, Reverse and Flat', () => {
    const { m } = model();
    const { container } = render(<OrderGrid m={m} tileId="chart-1" />);
    const rows = [...container.querySelectorAll('.tk-grid-row')].map((r) =>
      [...r.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent),
    );
    expect(rows).toEqual([
      ['Buy market', 'Sell market'],
      ['Buy bid 20,630.25', 'Sell ask 20,630.50'],
      ['Buy limit', 'Sell limit'],
      ['Buy stop', 'Sell stop'],
      ['Buy stop limit', 'Sell stop limit'],
      ['Cancel', 'Breakeven', 'Reverse', 'Flat'],
    ]);
    expect(screen.getByRole('button', { name: 'Buy limit' }).getAttribute('data-side')).toBe('buy');
    expect(screen.getByRole('button', { name: 'Flat' }).getAttribute('data-side')).toBeNull();
  });

  it('shows the armed one pressed, what is off as off, and hands a press to the model', () => {
    const { m, press, cancelHere, flattenHere } = model();
    render(<OrderGrid m={m} tileId="chart-1" />);
    const armed = screen.getByRole('button', { name: 'Sell stop limit' });
    expect(armed.getAttribute('aria-pressed')).toBe('true');
    expect(armed.classList.contains('is-armed')).toBe(true);
    expect(screen.getByRole('button', { name: 'Buy stop' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Buy bid 20,630.25' }));
    expect(press).toHaveBeenCalledWith('buy', 'touch');
    fireEvent.click(armed);
    expect(press).toHaveBeenLastCalledWith('sell', 'stop_limit');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelHere).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Flat' }));
    expect(flattenHere).toHaveBeenCalledOnce();
  });

  it('offers Breakeven as an exit beside Cancel and Flat: on, it acts on click; off, it does nothing', () => {
    const on = model();
    const view = render(<OrderGrid m={on.m} tileId="chart-1" />);
    const be = screen.getByRole('button', { name: 'Breakeven' });
    expect(be.getAttribute('data-side')).toBeNull();
    expect(be).toHaveProperty('disabled', false);
    fireEvent.click(be);
    expect(on.breakevenHere).toHaveBeenCalledOnce();
    view.unmount();
    const off = model({ beOff: true, beTip: 'No position' });
    render(<OrderGrid m={off.m} tileId="chart-1" />);
    expect(screen.getByRole('button', { name: 'Breakeven' })).toHaveProperty('disabled', true);
  });

  it('fills Flat only while a position is open: with resting orders alone it is as quiet as Cancel', () => {
    const resting = model({
      position: { words: 'Flat', qty: 0, pnl: null, instrument: null },
      cancelOff: false,
      flatTip: 'Cancel the working NQ Z6 orders',
      beOff: true,
      revOff: true,
    });
    const view = render(<OrderGrid m={resting.m} tileId="chart-1" />);
    const flat = screen.getByRole('button', { name: 'Flat' });
    expect(flat).toHaveProperty('disabled', false);
    expect(flat.className).toBe(screen.getByRole('button', { name: 'Cancel' }).className);
    view.unmount();
    render(<OrderGrid m={model().m} tileId="chart-1" />);
    expect(screen.getByRole('button', { name: 'Flat' }).className).not.toBe(
      screen.getByRole('button', { name: 'Cancel' }).className,
    );
  });

  it('offers Reverse beside Breakeven: on with a position, it acts on click; flat, it is off and says why', () => {
    const on = model();
    const view = render(<OrderGrid m={on.m} tileId="chart-1" />);
    const rev = screen.getByRole('button', { name: 'Reverse' });
    expect(rev.getAttribute('data-side')).toBeNull();
    fireEvent.click(rev);
    expect(on.reverseHere).toHaveBeenCalledOnce();
    view.unmount();
    const off = model({ revOff: true, revTip: 'No position' });
    render(<OrderGrid m={off.m} tileId="chart-1" />);
    expect(screen.getByRole('button', { name: 'Reverse' })).toHaveProperty('disabled', true);
  });

  it('prints each button’s order key in its tooltip once order keys are on, and none while they are off', async () => {
    const { m } = model();
    const grid = () =>
      render(
        <PlatformProvider value="mac">
          <OrderGrid m={m} tileId="chart-1" />
        </PlatformProvider>,
      );
    const hover = async (name: string, text: string) => {
      const hit = screen.getByRole('button', { name }).parentElement!;
      fireEvent.pointerMove(hit);
      fireEvent.focus(hit);
      await screen.findAllByText(text);
    };
    grid();
    await hover('Flat', 'Close the long 1 NQ Z6 at market and cancel its orders');
    expect(screen.queryByText('⌥X')).toBeNull();
    cleanup();
    putRuntimeSettings({ 'trade.orderHotkeys': { enabled: true, keys: { reverse: 'alt+e' } } }, false);
    try {
      for (const [name, text, key] of [
        ['Buy market', 'buy market', '⌥W'],
        ['Sell ask 20,630.50', 'sell touch', '⌥A'],
        ['Reverse', 'Reverse the long 1 NQ Z6 to short 1 at market, with the bracket', '⌥E'],
        ['Flat', 'Close the long 1 NQ Z6 at market and cancel its orders', '⌥X'],
      ] as const) {
        grid();
        await hover(name, text);
        expect((await screen.findAllByText(key)).length, name).toBeGreaterThan(0);
        cleanup();
      }
      grid();
      await hover('Buy limit', 'buy limit');
      expect(screen.queryByText(/^⌥/)).toBeNull();
    } finally {
      putRuntimeSettings({ 'trade.orderHotkeys': { enabled: false, keys: {} } }, false);
    }
  });

  it('says what Breakeven does, or why it is off, with its key, in its tooltip', async () => {
    const { m } = model({ beOff: true, beTip: 'Stop is already at or past breakeven' });
    render(<OrderGrid m={m} tileId="chart-1" />);
    const hit = screen.getByRole('button', { name: 'Breakeven' }).parentElement!;
    fireEvent.pointerMove(hit);
    fireEvent.focus(hit);
    const tip = await screen.findAllByText('Stop is already at or past breakeven');
    expect(tip.length).toBeGreaterThan(0);
  });

  it('sets how far past its stop a stop limit’s limit goes, in whole ticks, on this ticket', () => {
    const { m } = model();
    render(<OrderGrid m={m} tileId="chart-9" />);
    const field = screen.getByRole('textbox', { name: /Stop limit’s limit/ });
    expect(field).toHaveProperty('value', '2');
    fireEvent.change(field, { target: { value: '3' } });
    expect(ticketOf(read(ticketsStore).tickets, 'chart-9').stopLimitTicks).toBe(3);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(ticketOf(read(ticketsStore).tickets, 'chart-9').stopLimitTicks).toBe(1);
  });

  it('dims the bid and ask once their prices stop coming in, and leaves the orders the model allows lit', () => {
    const { m } = model({ stale: { position: null, prices: { trust: 'stale', words: 'No live prices' } } });
    const { container } = render(<OrderGrid m={m} tileId="chart-1" />);
    const trust = [...container.querySelectorAll('.tk-grid-row')].map((r) => r.getAttribute('data-trust'));
    expect(trust).toEqual([null, 'stale', null, null, null, null]);
    expect(screen.getByRole('button', { name: 'Buy market' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Sell ask 20,630.50' })).toHaveProperty('disabled', false);
  });
});

describe('the ticket’s read-out', () => {
  const update = {
    account: { id: 'paper-main', displayName: 'Paper' },
    summary: { dayPnl: { amount: 842, currency: 'USD' } },
  } as unknown as AccountUpdate;
  const long2: PositionReadout = { words: 'Long 2 @ 20,603.00', qty: 2, pnl: 130, instrument: 'NQZ6.CME' };
  const shown = (stale: ReadoutStale) => {
    const { container } = render(<DayReadout update={update} position={long2} stale={stale} />);
    return Object.fromEntries(
      [...container.querySelectorAll('.t-readout-row')].map((r) => [
        r.querySelector('dt')!.textContent,
        {
          note: r.querySelector('.note')?.textContent ?? null,
          trust: r.getAttribute('data-trust'),
          tone: r.querySelector('.v')!.getAttribute('data-tone'),
        },
      ]),
    );
  };

  it('reads a live position plainly and its P/L in colour', () => {
    const rows = shown({ position: null, prices: null });
    expect(rows.Position).toEqual({ note: null, trust: null, tone: null });
    expect(rows['Open P/L']).toEqual({ note: null, trust: null, tone: 'up' });
    expect(rows.Today).toEqual({ note: null, trust: null, tone: 'up' });
  });

  it('says how far behind the position is beside it, and takes the colour off its P/L', () => {
    const behind = { trust: 'behind', words: '2 min behind' } as const;
    const rows = shown({ position: behind, prices: behind });
    expect(rows.Position).toEqual({ note: '2 min behind', trust: 'behind', tone: null });
    expect(rows['Open P/L']).toEqual({ note: null, trust: 'behind', tone: null });
    expect(rows.Today).toEqual({ note: null, trust: 'behind', tone: null });
  });

  it('keeps the position itself live when only its prices stopped, and says so beside it', () => {
    const rows = shown({ position: null, prices: { trust: 'stale', words: 'No live prices' } });
    expect(rows.Position).toEqual({ note: 'No live prices', trust: null, tone: null });
    expect(rows['Open P/L']).toEqual({ note: null, trust: 'stale', tone: null });
  });
});

describe('what works on the contract', () => {
  const row = (over: Partial<TradeRow>): TradeRow => ({
    key: 'k',
    instrument: 'NQZ6.CME',
    kind: 'leg',
    of: 'position',
    words: 'Stop 20,620.50',
    money: -200,
    role: 'stop',
    held: false,
    cancels: [],
    ...over,
  });

  it('lists each order with its ×, no Flatten or Cancel all of its own (the grid has them)', () => {
    const onCancel = vi.fn();
    const rows = [
      row({ key: 'a', cancels: [{ id: 'sl' } as never] }),
      row({
        key: 'b',
        kind: 'order',
        of: null,
        words: 'Buy limit 1 @ 20,600.00',
        money: null,
        cancels: [{ id: 'e' } as never],
      }),
      row({ key: 'c', of: 'order', words: 'Stop 20,590.00', held: true }),
    ];
    const { container } = render(<TicketOrders rows={rows} symbol="NQ Z6" onCancel={onCancel} />);
    expect(screen.queryByRole('button', { name: /Flatten|Cancel all/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Cancel / })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel buy limit 1 @ 20,600.00' }));
    expect(onCancel).toHaveBeenCalledWith([{ id: 'e' }], 'Buy limit 1 @ 20,600.00');
    expect([...container.querySelectorAll('.tk-row')].map((r) => r.getAttribute('data-of'))).toEqual([
      'position',
      null,
      'order',
    ]);
  });

  it('reads only on an account Tessera only reads', () => {
    render(<TicketOrders rows={[row({ cancels: [{ id: 'sl' } as never] })]} symbol="NQ Z6" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
