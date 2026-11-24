import type { AccountUpdate, LimitsStatus } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import {
  limitLine,
  limitLockWords,
  limitsValue,
  parseLimit,
  readLimits,
  setIsOff,
  standingWords,
  withLimit,
  withOwn,
} from '../src/accounts/limits.ts';
import { placeBaseFor } from '../src/orderflow/dom/trading.ts';

const money = (amount: number) => ({ amount, currency: 'USD' as const });

const status = (over: Partial<LimitsStatus> = {}): LimitsStatus => ({
  accountId: 'paper-main',
  own: false,
  dailyLossLimit: null,
  dailyLossLeft: null,
  maxRiskPerTrade: null,
  maxOrderQty: null,
  maxPositionQty: null,
  maxTradesPerDay: null,
  tradesToday: null,
  firmRoom: null,
  locked: false,
  lockedWhy: null,
  asOf: 0,
  ...over,
});

const update = (limits?: LimitsStatus, risk: AccountUpdate['risk'] = null): AccountUpdate =>
  ({
    account: { id: 'paper-main', environment: 'paper', displayName: 'Paper', connectionId: 'paper', currency: 'USD' },
    summary: { netLiq: { amount: 50_000, currency: 'USD' }, dayPnl: money(0) },
    risk,
    ...(limits ? { limits } : {}),
  }) as unknown as AccountUpdate;

describe('the trader’s limits as stored (Settings › Risk)', () => {
  it('reads anything, keeps only the limits that are on, and writes back no more than that', () => {
    const none = { every: {}, accounts: {}, useFirmLimits: false, allowEarlyUnlock: false };
    expect(readLimits(undefined)).toEqual(none);
    expect(readLimits('junk')).toEqual(none);
    const s = readLimits({
      every: { dailyLossLimit: 500, maxRiskPerTrade: 0, maxOrderQty: 5.7, junk: 1 },
      accounts: { 'eval-50k': { dailyLossLimit: 1000 } },
    });
    expect(s.every).toEqual({ dailyLossLimit: 500, maxOrderQty: 5 });
    expect(s.accounts['eval-50k']).toEqual({ dailyLossLimit: 1000 });
    expect(limitsValue(readLimits({}))).toEqual({ every: {} });
    expect(limitsValue({ ...s, useFirmLimits: true })).toEqual({
      every: { dailyLossLimit: 500, maxOrderQty: 5 },
      accounts: { 'eval-50k': { dailyLossLimit: 1000 } },
      useFirmLimits: true,
    });
    expect(readLimits({ allowEarlyUnlock: true }).allowEarlyUnlock).toBe(true);
    expect(limitsValue(readLimits({ allowEarlyUnlock: true }))).toEqual({ every: {}, allowEarlyUnlock: true });
  });

  it('sets a limit, turns it off with an empty field, and gives an account limits of its own', () => {
    let s = readLimits({});
    expect(setIsOff(s.every)).toBe(true);
    s = withLimit(s, null, 'dailyLossLimit', 500);
    s = withLimit(s, null, 'maxTradesPerDay', 6);
    expect(s.every).toEqual({ dailyLossLimit: 500, maxTradesPerDay: 6 });
    s = withLimit(s, null, 'maxTradesPerDay', null);
    expect(s.every).toEqual({ dailyLossLimit: 500 });
    s = withOwn(s, 'eval-50k', true);
    expect(s.accounts['eval-50k']).toEqual({ dailyLossLimit: 500 });
    s = withLimit(s, 'eval-50k', 'dailyLossLimit', 1000);
    expect(s.accounts['eval-50k']).toEqual({ dailyLossLimit: 1000 });
    expect(s.every).toEqual({ dailyLossLimit: 500 });
    s = withOwn(s, 'eval-50k', false);
    expect(s.accounts).toEqual({});
  });

  it('takes a limit as typed: money to the cent, contracts and trades whole, empty is off', () => {
    expect(parseLimit('', 'dailyLossLimit')).toBeNull();
    expect(parseLimit('  ', 'maxOrderQty')).toBeNull();
    expect(parseLimit('$1,250.555', 'dailyLossLimit')).toBe(1250.56);
    expect(parseLimit('0', 'dailyLossLimit')).toBe('invalid');
    expect(parseLimit('-5', 'maxRiskPerTrade')).toBe('invalid');
    expect(parseLimit('2.5', 'maxOrderQty')).toBe('invalid');
    expect(parseLimit('abc', 'maxTradesPerDay')).toBe('invalid');
    expect(parseLimit('6', 'maxTradesPerDay')).toBe(6);
  });
});

describe('what the limits leave, in words', () => {
  it('says nothing with none on, and what is left only where a limit is on', () => {
    expect(standingWords(undefined)).toBeNull();
    expect(standingWords(status())).toBe('Within your limits');
    expect(
      standingWords(
        status({ dailyLossLimit: money(500), dailyLossLeft: money(310), maxTradesPerDay: 6, tradesToday: 2 }),
      ),
    ).toBe('$310.00 of $500.00 left today · 2 of 6 trades today');
    const why = 'Your $500.00 daily loss limit is reached: no new positions today. Exits work.';
    expect(standingWords(status({ locked: true, lockedWhy: why }))).toBe(why);
  });

  it('locks the panel, the chart and the DOM only on a limit of the trader’s, never on a firm’s alone', () => {
    expect(limitLockWords(update())).toBeNull();
    const firmLocked = { locked: true } as unknown as AccountUpdate['risk'];
    expect(limitLockWords(update(undefined, firmLocked))).toBeNull();
    const reached = status({ locked: true, dailyLossLimit: money(500), dailyLossLeft: money(0) });
    expect(limitLockWords(update(reached))).toBe('Daily loss limit reached · exits work');
    const friday = Date.parse('2026-10-02T14:42:30-04:00') * 1e6;
    const lifts = (iso: string) => status({ ...reached, asOf: friday, lockedUntil: Date.parse(iso) * 1e6 });
    expect(limitLockWords(update(lifts('2026-10-04T18:00:00-04:00')))).toBe(
      'Daily loss limit reached · new entries from Sun 18:00 · exits work',
    );
    expect(limitLockWords(update(lifts('2026-10-02T18:00:00-04:00')))).toBe(
      'Daily loss limit reached · new entries from 18:00 · exits work',
    );
    const mine = status({
      locked: true,
      lockKind: 'manual',
      asOf: friday,
      lockedUntil: Date.parse('2026-10-02T15:12:30-04:00') * 1e6,
    });
    expect(limitLockWords(update(mine))).toBe('Trading locked until 15:12 · exits, stops and targets work');
    expect(limitLockWords(update(status({ locked: true, firmRoom: money(0) })))).toBe(
      'Your firm’s rules leave no room · exits work',
    );
    expect(limitLockWords(update(status({ locked: true, firmRoom: money(400) })))).toBe(
      'Your firm’s platform has the account locked · exits work',
    );
    const dom = (account: AccountUpdate) =>
      placeBaseFor({
        account,
        gate: { kind: 'open', offPaper: false },
        instrument: 'ESZ6.CME',
        ids: new Set(['ESZ6.CME']),
        symbol: 'ES Z6',
        math: { tick: 0.25, tickValue: 12.5, decimals: 2 },
        ticket: { qty: 1, sizing: 'qty', risk: 250, entry: 'market' },
        oco: { on: false } as never,
        scope: null,
      });
    expect('base' in dom(update(undefined, firmLocked))).toBe(true);
    expect(dom(update(reached))).toEqual({ why: 'Daily loss limit reached · exits work' });
  });
});

describe('the panel’s one quiet line', () => {
  const trade = { stopRisk: 340, qty: 2, position: 0 };

  it('never speaks without a limit on, whatever the trade', () => {
    expect(limitLine(update(), { stopRisk: 100_000, qty: 500, position: 0 })).toBeNull();
    expect(limitLine(update(), { stopRisk: null, qty: 1, position: 0 })).toBeNull();
    expect(limitLine(null, trade)).toBeNull();
  });

  it('speaks when a trade crosses a limit, then when it comes within a fifth of one, else not', () => {
    const perTrade = update(status({ maxRiskPerTrade: money(250) }));
    expect(limitLine(perTrade, trade)).toBe('This stop risks $340.00: over your $250.00 a trade.');
    expect(limitLine(perTrade, { ...trade, stopRisk: 210 })).toBe('This stop risks $210.00 of your $250.00 a trade.');
    expect(limitLine(perTrade, { ...trade, stopRisk: 150 })).toBeNull();
    expect(limitLine(perTrade, { ...trade, stopRisk: null })).toBe('No stop: your $250.00 a trade needs one.');
    const daily = update(status({ dailyLossLimit: money(500), dailyLossLeft: money(310) }));
    expect(limitLine(daily, trade)).toBe('This stop risks $340.00: over the $310.00 left today.');
    expect(limitLine(daily, { ...trade, stopRisk: 260 })).toBe('This stop risks $260.00 of the $310.00 left today.');
    expect(limitLine(daily, { ...trade, stopRisk: 100 })).toBeNull();
    expect(limitLine(daily, { ...trade, stopRisk: null })).toBeNull();
  });

  it('weighs the size, what is held and today’s trades', () => {
    const size = update(status({ maxOrderQty: 5, maxPositionQty: 6, maxTradesPerDay: 6, tradesToday: 5 }));
    expect(limitLine(size, { stopRisk: 100, qty: 8, position: 0 })).toBe('8 contracts: over your 5 an order.');
    expect(limitLine(size, { stopRisk: 100, qty: 3, position: 4 })).toBe('Adding 3 holds 7: over your 6.');
    expect(limitLine(size, { stopRisk: 100, qty: 1, position: 0 })).toBe('Your last trade today (6).');
    expect(limitLine(size, { stopRisk: 100, qty: 1, position: 2 })).toBeNull();
    const done = update(status({ maxTradesPerDay: 6, tradesToday: 6 }));
    expect(limitLine(done, { stopRisk: 100, qty: 1, position: 0 })).toBe(
      '6 trades today: no new trades until tomorrow.',
    );
  });
});
