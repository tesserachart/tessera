import type { AccountLockOutput, AccountUpdate, LimitsStatus } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { lockChipWords, lockMenu, spanKey, unlockTyped } from '../src/accounts/lock.ts';
import { nsAt } from './support/time.ts';

const at = nsAt('2026-10-06T14:42:00-04:00');

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
  asOf: at,
  ...over,
});

const update = (limits?: LimitsStatus): AccountUpdate =>
  ({
    account: { id: 'paper-main', displayName: 'Paper' },
    ...(limits ? { limits } : {}),
  }) as unknown as AccountUpdate;

describe('the account chip while trading is locked', () => {
  it('says until when, for a lock the trader set or a reached daily loss limit, and nothing otherwise', () => {
    expect(lockChipWords(update())).toBeNull();
    expect(lockChipWords(update(status()))).toBeNull();
    const until = nsAt('2026-10-06T15:42:00-04:00');
    expect(lockChipWords(update(status({ locked: true, lockKind: 'manual', lockedUntil: until })))).toBe(
      'Locked until 15:42',
    );
    expect(lockChipWords(update(status({ locked: true, lockKind: 'daily_loss', lockedUntil: until })))).toBe(
      'Locked until 15:42',
    );
    expect(lockChipWords(update(status({ locked: true })))).toBeNull();
  });
});

describe('the lock menu', () => {
  const out: AccountLockOutput = {
    accountId: 'paper-main',
    displayName: 'Paper',
    lock: null,
    exchangeZone: 'America/New_York',
    copy: null,
    asOf: at,
    options: [
      {
        span: { kind: 'minutes', minutes: 15 },
        label: '15 min',
        until: nsAt('2026-10-06T14:57:00-04:00'),
        unavailable: null,
      },
      {
        span: { kind: 'market_close' },
        label: 'Until market close',
        until: null,
        unavailable: 'The market is closed now: pick another time',
      },
      {
        span: { kind: 'next_open' },
        label: 'Until tomorrow’s open',
        until: nsAt('2026-10-07T09:30:00-04:00'),
        unavailable: null,
      },
      {
        span: { kind: 'session', session: 'tokyo' },
        label: 'Until Tokyo opens',
        until: nsAt('2026-10-07T09:00:00+09:00'),
        unavailable: null,
      },
    ],
  };

  it('groups quick spans, the day and the sessions, each with when it would end or why it cannot', () => {
    const m = lockMenu(out, at);
    expect(m.quick.map((r) => [r.label, r.until])).toEqual([['15 min', '14:57']]);
    expect(m.day.map((r) => [r.key, r.until, r.why])).toEqual([
      ['market_close', null, 'The market is closed now: pick another time'],
      ['next_open', '09:30', null],
    ]);
    expect(m.sessions.map((r) => [r.key, r.until])).toEqual([['session-tokyo', '20:00']]);
    expect(spanKey({ kind: 'minutes', minutes: 240 })).toBe('minutes-240');
  });

  it('lifts early only on the typed word', () => {
    expect(unlockTyped('UNLOCK')).toBe(true);
    expect(unlockTyped(' UNLOCK ')).toBe(true);
    expect(unlockTyped('unlock')).toBe(false);
    expect(unlockTyped('')).toBe(false);
  });
});
