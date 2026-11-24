import { describe, expect, it } from 'vitest';
import {
  bracketErrors,
  bracketShort,
  breakevenWords,
  legFieldText,
  legHelp,
  rulesShort,
  trailWords,
} from '../src/chart/ticket/bracket.ts';
import { ocoBracket, planOco, type OcoMarket } from '../src/shell/oco.ts';
import { BRACKET_ON } from './support/oco.ts';
import { takesOrderType } from '../src/shell/orderEntry.ts';
import {
  GRID_ORDERS,
  gridKind,
  gridPress,
  gridTip,
  gridWord,
  orderInput,
  parsePrice,
  sendSurface,
  stopLimitPrice,
  toTick,
  type GridTipContext,
} from '../src/shell/ticket.ts';

const NQ: OcoMarket = { tick: 0.25, tickValue: 5, decimals: 2, qty: 2, balance: 124_820 };

describe('the trading panel’s ticket', () => {
  it('sends an entry with the bracket its OCO gives it; a close carries none', () => {
    const oco = {
      ...BRACKET_ON,
      stop: { on: true, unit: 'ticks' as const, value: 40 },
      target: { on: true, unit: 'ticks' as const, value: 80 },
    };
    const bracket = ocoBracket('buy', 20641.25, oco, NQ);
    const buy = orderInput({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      kind: 'market',
      price: null,
      qty: 2,
      bracket,
    });
    expect(buy).toEqual({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 2,
      orderType: 'market',
      tif: 'day',
      bracket: { stopLoss: 20631.25, takeProfit: 20661.25 },
    });
    const limit = orderInput({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'sell',
      kind: 'limit',
      price: 20650,
      qty: 2,
      bracket: ocoBracket('sell', 20650, oco, NQ),
    });
    expect(limit.limitPrice).toBe(20650);
    expect(limit.bracket).toEqual({ stopLoss: 20660, takeProfit: 20630 });
    const close = orderInput({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'sell',
      kind: 'market',
      price: null,
      qty: 2,
      bracket,
      reduceOnly: true,
    });
    expect(close.bracket).toBeUndefined();
    expect(close.reduceOnly).toBe(true);
  });

  it('every environment sends on a click, confirmed off paper', () => {
    expect(sendSurface('paper')).toEqual({ armed: true, holdConfirmed: false });
    expect(sendSurface('eval')).toEqual({ armed: true, holdConfirmed: true });
    expect(sendSurface('live')).toEqual({ armed: true, holdConfirmed: true });
  });

  it('reads typed prices onto the tick', () => {
    expect(parsePrice('20,615.30', 0.25)).toBe(20615.25);
    expect(parsePrice('487.5', 0.01)).toBe(487.5);
    expect(parsePrice('', 0.25)).toBeNull();
    expect(parsePrice('abc', 0.25)).toBeNull();
    expect(toTick(0.1 + 0.2, 0.01)).toBe(0.3);
  });
});

describe('a chart’s ticket at the moment of risk', () => {
  it('says what the folded bracket does, stop on the click when sizing by risk', () => {
    const oco = {
      ...BRACKET_ON,
      on: true,
      stop: { ...BRACKET_ON.stop, on: true },
      target: { ...BRACKET_ON.target, on: true },
    };
    const plan = { stopTicks: 40, targetTicks: 80 } as Parameters<typeof bracketShort>[1];
    expect(bracketShort(oco, plan, { riskSizing: false })).toBe('40 t · 80 t');
    expect(bracketShort(oco, plan, { riskSizing: true })).toBe('Stop on click · 80 t');
    expect(bracketShort({ ...oco, on: false }, plan, { riskSizing: true })).toBe('');
  });
});

const ctx = (over: Partial<GridTipContext> = {}): GridTipContext => ({
  size: { qty: 2 },
  touch: '20,630.25',
  limitTicks: 2,
  bracket: true,
  why: null,
  ...over,
});

describe('the order grid (owner, 8 Oct: "buy limit, buy stop, sell limit, sell stop … none of this auto")', () => {
  it('has a Buy and a Sell for each order, each named for what it places', () => {
    expect(GRID_ORDERS).toEqual(['market', 'touch', 'limit', 'stop', 'stop_limit']);
    expect(GRID_ORDERS.map((o) => gridWord('buy', o))).toEqual([
      'Buy market',
      'Buy bid',
      'Buy limit',
      'Buy stop',
      'Buy stop limit',
    ]);
    expect(GRID_ORDERS.map((o) => gridWord('sell', o))).toEqual([
      'Sell market',
      'Sell ask',
      'Sell limit',
      'Sell stop',
      'Sell stop limit',
    ]);
    expect(GRID_ORDERS.map(gridKind)).toEqual(['market', 'limit', 'limit', 'stop', 'stop_limit']);
  });

  it('sends at market and at the touch now by contracts; by risk, and every priced order, arms the chart', () => {
    expect(gridPress('market', false)).toBe('send');
    expect(gridPress('touch', false)).toBe('send');
    expect(gridPress('market', true)).toBe('arm');
    expect(gridPress('touch', true)).toBe('arm');
    for (const o of ['limit', 'stop', 'stop_limit'] as const) {
      expect(gridPress(o, false)).toBe('arm');
      expect(gridPress(o, true)).toBe('arm');
    }
  });

  it('says in each tooltip what the button does, or why it cannot', () => {
    expect(gridTip('buy', 'market', ctx())).toBe('Buy 2 at market now, with its bracket');
    expect(gridTip('sell', 'market', ctx({ bracket: false }))).toBe('Sell 2 at market now');
    expect(gridTip('buy', 'market', ctx({ size: { risk: '$250.00' } }))).toBe(
      'Buy at market: click its stop on the chart; $250.00 at risk sizes it and sends it',
    );
    expect(gridTip('buy', 'touch', ctx())).toBe('Buy 2 at the bid, a limit at 20,630.25 sent now, with its bracket');
    expect(gridTip('sell', 'touch', ctx({ touch: null }))).toBe('Sell at the ask: no price yet');
    expect(gridTip('buy', 'limit', ctx())).toBe(
      'Buy limit 2: click its price on the chart; through the ask it goes in at the ask',
    );
    expect(gridTip('sell', 'stop', ctx({ size: { risk: '$250.00' } }))).toBe(
      'Sell stop: click its price on the chart, below the bid; then click its stop: $250.00 at risk sizes it',
    );
    expect(gridTip('buy', 'stop_limit', ctx())).toBe(
      'Buy stop limit 2: click its stop on the chart, above the ask; its limit 2 ticks above it',
    );
    expect(gridTip('sell', 'stop_limit', ctx({ limitTicks: 1 }))).toBe(
      'Sell stop limit 2: click its stop on the chart, below the bid; its limit 1 tick below it',
    );
    expect(gridTip('sell', 'stop_limit', ctx({ limitTicks: 0 }))).toMatch(/its limit at the stop$/);
    expect(gridTip('buy', 'limit', ctx({ why: 'No price for NQ Z6 yet' }))).toBe('No price for NQ Z6 yet');
  });

  it('sends a stop limit with its stop and its limit, the limit past the stop on the side it fills', () => {
    expect(stopLimitPrice('buy', 20660, 2, 0.25)).toBe(20660.5);
    expect(stopLimitPrice('sell', 20640, 2, 0.25)).toBe(20639.5);
    expect(stopLimitPrice('sell', 20640, 0, 0.25)).toBe(20640);
    const input = orderInput({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      kind: 'stop_limit',
      price: 20660,
      limit: 20660.5,
      qty: 1,
      bracket: null,
    });
    expect(input).toEqual({
      accountId: 'paper-main',
      instrument: 'NQZ6.CME',
      side: 'buy',
      qty: 1,
      orderType: 'stop_limit',
      limitPrice: 20660.5,
      stopPrice: 20660,
      tif: 'day',
    });
  });

  it('offers a stop limit only where the account’s connection takes one (open while that is not known)', () => {
    const account = { id: 'a', connectionId: 'c', environment: 'paper' as const };
    const conn = (orderTypes: string[]) => [{ id: 'c', broker: { orderTypes } }] as never;
    expect(takesOrderType(account, conn(['market', 'limit', 'stop', 'stop_limit']), 'stop_limit')).toBe(true);
    expect(takesOrderType(account, conn(['market', 'limit', 'stop']), 'stop_limit')).toBe(false);
    expect(takesOrderType(account, undefined, 'stop_limit')).toBe(true);
    expect(takesOrderType(null, conn(['market']), 'stop_limit')).toBe(true);
  });
});

describe('the panel’s bracket in words', () => {
  const nq: OcoMarket = { tick: 0.25, tickValue: 5, decimals: 2, qty: 1, balance: 50_000 };

  it('says under each leg where it lands and what it is in the units its field does not show', () => {
    expect(legHelp(40, 'ticks', nq, 20620.25)).toBe('20,620.25 · $200.00');
    expect(legHelp(40, 'usd', nq, 20620.25)).toBe('20,620.25 · 40 t');
    expect(legHelp(40, 'points', nq, null)).toBe('40 t · $200.00');
    expect(legHelp(null, 'ticks', nq, 20620.25)).toBe('—');
    expect(legFieldText({ unit: 'ticks', value: 40.4 })).toBe('40');
    expect(legFieldText({ unit: 'usd', value: 12.5 })).toBe('12.5');
    expect(legFieldText({ unit: 'pct', value: 0.12345 })).toBe('0.1235');
  });

  it('names the rules in force while folded, and says each in its tooltip', () => {
    expect(rulesShort(BRACKET_ON)).toBe('');
    const on = {
      ...BRACKET_ON,
      breakeven: { on: true, trigger: 20, offset: 1 },
      trail: { on: true, ticks: 12, trigger: 0, step: 1 },
    };
    expect(rulesShort(on)).toBe('Breakeven 20 · Trail 12');
    expect(breakevenWords(on)).toBe('At 20 ticks of profit, the stop moves to the entry + 1, once');
    expect(trailWords(on)).toBe('The stop follows 12 ticks behind the best price, only tighter');
    expect(trailWords({ ...on, trail: { on: true, ticks: 12, trigger: 30, step: 4 } })).toBe(
      'From 30 ticks of profit, the stop follows 12 ticks behind the best price, 4 ticks at a time, only tighter',
    );
  });

  it('says everything that keeps it from going in one line, each leg named, once each', () => {
    const bad = {
      ...BRACKET_ON,
      stop: { on: true, unit: 'usd' as const, value: 1 },
      trail: { on: true, ticks: 0, trigger: 0, step: 1 },
    };
    expect(bracketErrors(planOco(bad, nq), ['Stop 1 is above the market'])).toEqual([
      'Stop: under 1 tick (one tick is $5.00 at 1)',
      'Trailing under 1 tick',
      'Stop 1 is above the market',
    ]);
    expect(bracketErrors(planOco(BRACKET_ON, nq))).toEqual([]);
  });
});
