import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OCO,
  bracketSideErrors,
  convertLeg,
  draftLeg,
  expectedFill,
  knownContract,
  instrumentRoot,
  legReadout,
  legsFrom,
  legTicks,
  legWords,
  ocoBracket,
  ocoSummary,
  planOco,
  readOco,
  stepLeg,
  type OcoConfig,
  type OcoMarket,
} from '../src/shell/oco.ts';
import { BRACKET_ON } from './support/oco.ts';

const at = (root: string, qty: number, balance: number | null = 124_820): OcoMarket => ({
  ...knownContract(root),
  qty,
  balance,
});

const oco = (
  stop: OcoConfig['stop'],
  target: OcoConfig['target'] = { on: false, unit: 'ticks', value: 1 },
): OcoConfig => ({
  ...BRACKET_ON,
  stop,
  target,
});

describe('a bracket leg set as ticks from the fill', () => {
  const inTicks = { stopLoss: null, takeProfit: null, stopTicks: 40, targetTicks: 80 };

  it('reads as its distance and is drawn that far from the price the entry is expected at', () => {
    expect(legWords(inTicks, 'stop', 2)).toBe('40 ticks from the fill');
    expect(legWords({ stopLoss: 20_600, takeProfit: null }, 'stop', 2)).toBe('20,600.00');
    expect(legWords({ stopLoss: null, takeProfit: null }, 'target', 2)).toBeNull();
    const draft = { side: 'sell' as const, instrument: 'NQZ6.CME', bracket: inTicks };
    expect([draftLeg(draft, 'stop', 20_650), draftLeg(draft, 'target', 20_650)]).toEqual([20_660, 20_630]);
  });

  it('is sent as ticks for an entry that fills where the market is, as prices for one that rests', () => {
    expect(legsFrom('buy', 'market', null, 20_650)).toBe('fill');
    expect(legsFrom('buy', 'stop', 20_660, 20_650)).toBe('fill');
    expect(legsFrom('buy', 'limit', 20_655, 20_650)).toBe('fill');
    expect(legsFrom('buy', 'limit', 20_640, 20_650)).toBe(20_640);
    expect(legsFrom('sell', 'stop_limit', 20_640, 20_650)).toBe(20_640);
  });
});

describe('OCO units', () => {
  it('converts every unit to whole ticks, never wider than stated (NQ: 0.25 = $5)', () => {
    const nq = at('NQ', 1);
    expect(legTicks({ on: true, unit: 'ticks', value: 41 }, nq).ticks).toBe(41);
    expect(legTicks({ on: true, unit: 'points', value: 10.25 }, nq).ticks).toBe(41);
    expect(legTicks({ on: true, unit: 'points', value: 10.3 }, nq).ticks).toBe(41);
    expect(legTicks({ on: true, unit: 'usd', value: 205 }, nq).ticks).toBe(41);
    expect(legTicks({ on: true, unit: 'usd', value: 209 }, nq).ticks).toBe(41);
    expect(legTicks({ on: true, unit: 'pct', value: 0.16 }, nq).ticks).toBe(39);
    expect(legTicks({ on: true, unit: 'usd', value: 200 }, at('NQ', 2)).ticks).toBe(20);
  });

  it('ES is $12.50 a tick, equities a cent, bitcoin a cent', () => {
    expect(legTicks({ on: true, unit: 'usd', value: 100 }, at('ES', 1)).ticks).toBe(8);
    expect(legTicks({ on: true, unit: 'usd', value: 99.99 }, at('ES', 1)).ticks).toBe(7);
    expect(legTicks({ on: true, unit: 'usd', value: 50 }, at('QQQ', 100)).ticks).toBe(50);
    expect(legTicks({ on: true, unit: 'points', value: 0.5 }, at('QQQ', 100)).ticks).toBe(50);
    expect(legTicks({ on: true, unit: 'usd', value: 100 }, at('BTC', 0.5)).ticks).toBe(20_000);
    expect(instrumentRoot('NQZ6.CME')).toBe('NQ');
    expect(instrumentRoot('BTC-USD.COINBASE')).toBe('BTC');
    expect(instrumentRoot('QQQ')).toBe('QQQ');
  });

  it('refuses under one tick and a % without a balance', () => {
    expect(legTicks({ on: true, unit: 'usd', value: 4 }, at('NQ', 1)).error).toMatch(/Under 1 tick/);
    expect(legTicks({ on: true, unit: 'pct', value: 0.1 }, at('NQ', 1, null)).error).toBe('No balance for %');
    expect(legTicks({ on: true, unit: 'ticks', value: 0 }, at('NQ', 1)).error).toBe('Enter a distance');
  });

  it('reads out every unit and converts between them', () => {
    const nq = at('NQ', 1);
    expect(legReadout(41, nq, 20640.75)).toBe('20,640.75 · 41 ticks · 10.25 pts · $205.00 · 0.16% of $124,820.00');
    expect(convertLeg({ on: true, unit: 'ticks', value: 41 }, 'usd', nq)).toEqual({
      on: true,
      unit: 'usd',
      value: 205,
    });
    expect(convertLeg({ on: true, unit: 'usd', value: 205 }, 'points', nq).value).toBe(10.25);
    expect(stepLeg({ on: true, unit: 'usd', value: 205 }, 1).value).toBe(210);
    expect(stepLeg({ on: true, unit: 'points', value: 10.25 }, -1).value).toBe(10);
    expect(stepLeg({ on: true, unit: 'pct', value: 0.05 }, -1).value).toBe(0.05);
  });

  it('a $200 stop and a 2R target make the bracket, with the summary', () => {
    const nq = at('NQ', 1);
    const o = oco({ on: true, unit: 'usd', value: 200 }, { on: true, unit: 'usd', value: 400 });
    expect(ocoBracket('buy', 20641.25, o, nq)).toEqual({ stopLoss: 20631.25, takeProfit: 20661.25 });
    expect(ocoBracket('sell', 20641.0, o, nq)).toEqual({ stopLoss: 20651.0, takeProfit: 20621.0 });
    const plan = planOco(o, nq);
    expect(ocoSummary(plan, nq).text).toBe('Risk $200.00 · Reward $400.00 · 1 : 2.0');
    const s = ocoSummary(plan, nq, 350);
    expect(s.text).toBe('Risk $200.00 · Reward $400.00 · 1 : 2.0 · $350.00 left today');
    expect(s.binds).toBe(true);
    expect(ocoSummary(plan, nq, 690).binds).toBe(false);
    const byRisk = ocoSummary(plan, nq, 350, 250);
    expect(byRisk.text).toBe('Risk $250.00 · $350.00 left today');
    expect(byRisk.binds).toBe(true);
  });

  it('carries breakeven and trailing on the stop, and checks them', () => {
    const o: OcoConfig = {
      ...BRACKET_ON,
      breakeven: { on: true, trigger: 20, offset: 1 },
      trail: { on: true, ticks: 16, trigger: 24, step: 2 },
    };
    expect(ocoBracket('buy', 20641.25, o, at('NQ', 1))).toEqual({
      stopLoss: 20631.25,
      takeProfit: 20661.25,
      breakeven: { triggerTicks: 20, offsetTicks: 1 },
      trail: { distanceTicks: 16, triggerTicks: 24, stepTicks: 2 },
    });
    expect(planOco({ ...o, breakeven: { on: true, trigger: 4, offset: 4 } }, at('NQ', 1)).errors.rules).toMatch(
      /below its trigger/,
    );
    expect(planOco({ ...o, stop: { ...o.stop, on: false } }, at('NQ', 1)).errors.rules).toMatch(/need the stop/);
    expect(planOco({ ...o, trail: { ...o.trail, step: 0 } }, at('NQ', 1)).errors.rules).toBe(
      'Trailing step under 1 tick',
    );
  });

  it('says a bracket on the wrong side of the market before sending', () => {
    const fill = expectedFill('buy', 'limit', 20650, 20641.25);
    expect(fill).toBe(20641.25);
    expect(bracketSideErrors('buy', fill, { stopLoss: 20649.5, takeProfit: 20660 }, 2)[0]).toMatch(
      /would stop out at once/,
    );
    expect(bracketSideErrors('buy', 20641.25, { stopLoss: 20631.25, takeProfit: 20661.25 }, 2)).toEqual([]);
  });

  it('storage is read safely', () => {
    expect(readOco({ stop: { unit: 'usd', value: 200 } }).stop).toEqual({ on: true, unit: 'usd', value: 200 });
    expect(readOco(null)).toEqual(DEFAULT_OCO);
  });
});
