import { describe, expect, it } from 'vitest';
import { bracketShort } from '../src/chart/ticket/bracket.ts';
import { draftEditInput } from '../src/chart/draftEdit.ts';
import { DEFAULT_OCO, planOco, type OcoMarket } from '../src/shell/oco.ts';

const draft = {
  accountId: 'eval-50k',
  instrument: 'NQZ6.CME',
  side: 'buy',
  qty: 2,
  orderType: 'limit',
  limitPrice: 20615,
  bracket: { stopLoss: 20598, takeProfit: 20700 },
};

describe('a draft’s leg dragged on the chart (spec §4.5)', () => {
  it('puts the dragged price where the leg lives, and nothing else changes', () => {
    expect(draftEditInput(draft, 'stop', 20590.25)).toEqual({
      ...draft,
      bracket: { stopLoss: 20590.25, takeProfit: 20700 },
    });
    expect(draftEditInput(draft, 'target', 20710)).toEqual({
      ...draft,
      bracket: { stopLoss: 20598, takeProfit: 20710 },
    });
    expect(draftEditInput(draft, 'entry', 20612.5)).toEqual({ ...draft, limitPrice: 20612.5 });
    expect(draft.limitPrice).toBe(20615);
  });

  it('a leg set as ticks from the fill becomes the price it is dragged to', () => {
    const inTicks = {
      ...draft,
      orderType: 'market',
      limitPrice: null,
      bracket: { stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 },
    };
    expect(draftEditInput(inTicks, 'stop', 20590.25)).toEqual({
      ...inTicks,
      bracket: { stopLoss: 20590.25, takeProfit: null, targetTicks: 80 },
    });
  });

  it('moves a stop entry’s trigger, and a stop-limit keeps its limit’s distance', () => {
    expect(
      draftEditInput({ ...draft, orderType: 'stop', stopPrice: 20650, limitPrice: null }, 'entry', 20660),
    ).toMatchObject({
      stopPrice: 20660,
    });
    expect(
      draftEditInput({ ...draft, orderType: 'stop_limit', stopPrice: 20650, limitPrice: 20652 }, 'entry', 20660),
    ).toMatchObject({ stopPrice: 20660, limitPrice: 20662 });
  });

  it('cannot move what the draft does not have: a market entry, a leg it has no price for', () => {
    expect(draftEditInput({ ...draft, orderType: 'market', limitPrice: null }, 'entry', 20600)).toBeNull();
    expect(draftEditInput({ ...draft, bracket: { stopLoss: null, takeProfit: 20700 } }, 'stop', 20590)).toBeNull();
    expect(draftEditInput({ ...draft, bracket: null }, 'target', 20590)).toBeNull();
    expect(draftEditInput('not an order', 'stop', 1)).toBeNull();
  });
});

describe('the panel’s bracket, folded', () => {
  const nq: OcoMarket = { tick: 0.25, tickValue: 5, decimals: 2, qty: 1, balance: 50_000 };
  it('says its legs in ticks, the stop on the click by risk, and nothing when it is off (its switch says so)', () => {
    const on = { ...DEFAULT_OCO, on: true };
    expect(bracketShort(on, planOco(on, nq), { riskSizing: false })).toBe('40 t · 80 t');
    expect(bracketShort({ ...on, on: false }, null, { riskSizing: false })).toBe('');
    expect(bracketShort(on, planOco(on, nq), { riskSizing: true })).toBe('Stop on click · 80 t');
    const usd = { ...on, target: { ...on.target, unit: 'usd' as const, value: 400 } };
    expect(bracketShort(usd, planOco(usd, nq), { riskSizing: true })).toBe('Stop on click · $400.00');
    expect(bracketShort(usd, planOco(usd, nq), { riskSizing: false })).toBe('40 t · 80 t');
    expect(
      bracketShort({ ...on, stop: { ...on.stop, on: false }, target: { ...on.target, on: false } }, null, {
        riskSizing: false,
      }),
    ).toBe('No legs');
  });
});
