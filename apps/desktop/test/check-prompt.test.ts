import { describe, expect, it } from 'vitest';
import { placementCheck, ticketCheck } from '../src/analyst/checkPrompt.ts';
import type { Placement } from '../src/chart/placement.ts';

const base: Placement = {
  accountId: 'paper-main',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  symbol: 'NQ Z6',
  side: 'buy',
  qty: 2,
  kind: 'limit',
  tick: 0.25,
  decimals: 2,
  stage: 'entry',
  entry: null,
  orderId: null,
  stop: null,
  error: null,
  busy: false,
  mode: 'qty',
  risk: 0,
  tickValue: 5,
  stopTicks: 68,
  targetTicks: 340,
};

describe('⌘I with an order in hand (spec §9)', () => {
  it('names the whole order once the entry has a price', () => {
    expect(placementCheck({ ...base, entry: 20615 })).toBe(
      'Check: Buy 2 NQ Z6 limit 20,615.00, stop 20,598.00, target 20,700.00, risk $680.00',
    );
  });

  it('names the legs in ticks before the entry is clicked', () => {
    expect(placementCheck(base)).toBe('Check: Buy 2 NQ Z6 limit, stop 68 t, target 340 t, risk $680.00');
  });

  it('uses the clicked stop and sizes by risk when the ticket does', () => {
    expect(
      placementCheck({ ...base, side: 'sell', mode: 'risk', risk: 250, entry: 20615, stop: 20630, targetTicks: null }),
    ).toBe('Check: Sell NQ Z6 limit 20,615.00, stop 20,630.00, risk $250.00');
  });

  it('says what a focused ticket holds when nothing is armed: its size and contract (its grid names each kind)', () => {
    expect(ticketCheck({ qty: 2, symbol: 'NQ Z6', sizing: 'qty', risk: 0 })).toBe('Check: 2 NQ Z6');
    expect(ticketCheck({ qty: 2, symbol: 'NQ Z6', entry: 'market', sizing: 'qty', risk: 0 })).toBe(
      'Check: 2 NQ Z6 market',
    );
  });

  it('names a stop limit by its stop and its limit, its legs from the limit', () => {
    expect(
      placementCheck({ ...base, kind: 'stop_limit', limitTicks: 2, entry: 20615, stopTicks: 40, targetTicks: 80 }),
    ).toBe('Check: Buy 2 NQ Z6 stop limit 20,615.00 limit 20,615.50, stop 20,605.50, target 20,635.50, risk $400.00');
  });
});
