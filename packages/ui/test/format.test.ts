import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCountdown,
  formatDuration,
  formatElapsed,
  formatInt,
  formatMoney,
  formatPercent,
  formatPrice,
  formatSigned,
  formatVolume,
  MINUS,
  precisionFromTick,
  toneOf,
} from '../src/format.ts';

describe('content-sheet §0 formatting', () => {
  it('prices: tick precision, zero-padded, grouped by thousands (decision 0007)', () => {
    expect(formatPrice(487.85, 2)).toBe('487.85');
    expect(formatPrice(20641.25, 2)).toBe('20,641.25');
    expect(formatPrice(98412, 2)).toBe('98,412.00');
    expect(formatPrice(5583.25, 2)).toBe('5,583.25');
    expect(formatPrice(-1.5, 2)).toBe(`${MINUS}1.50`);
    expect(formatPrice(null, 2)).toBe('—');
    expect(formatPrice(Number.NaN, 2)).toBe('—');
  });

  it('signed deltas use + and a true minus; zero is unsigned', () => {
    expect(formatSigned(0.75, 2)).toBe('+0.75');
    expect(formatSigned(-1.26, 2)).toBe('−1.26');
    expect(formatSigned(0, 2)).toBe('0.00');
    expect(formatSigned(-0.001, 2)).toBe('0.00');
    expect(formatSigned(1292, 2)).toBe('+1292.00');
    expect(formatSigned(-0.43, 2)).not.toContain('-');
  });

  it('money is grouped with cents and signed for P&L', () => {
    expect(formatMoney(124820)).toBe('$124,820.00');
    expect(formatMoney(842, { signed: true })).toBe('+$842.00');
    expect(formatMoney(-210, { signed: true })).toBe(`${MINUS}$210.00`);
    expect(formatMoney(-210)).toBe(`${MINUS}$210.00`);
    expect(formatMoney(0, { signed: true })).toBe('$0.00');
    expect(formatMoney(12181.25)).toBe('$12,181.25');
    expect(formatMoney(5, { currency: 'EUR' })).toBe('5.00 EUR');
  });

  it('money always carries exactly two decimals, so a ticking value never changes shape', () => {
    expect(formatMoney(7317, { signed: true })).toBe('+$7,317.00');
    expect(formatMoney(7387.5, { signed: true })).toBe('+$7,387.50');
    expect(formatMoney(-0.5, { signed: true })).toBe(`${MINUS}$0.50`);
    expect(formatMoney(0, { signed: true })).toBe('$0.00');
    expect(formatMoney(-0.004, { signed: true })).toBe('$0.00');
    expect(formatMoney(1_234_567.891, { signed: true })).toBe('+$1,234,567.89');
    expect(formatMoney(-98_765_432.1)).toBe(`${MINUS}$98,765,432.10`);
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(Number.NaN)).toBe('—');
    for (const v of [7317, 7317.5, 7317.25, 7318]) expect(formatMoney(v, { signed: true })).toMatch(/\.\d{2}$/);
  });

  it('money takes an amount with its currency', () => {
    expect(formatMoney({ amount: 690, currency: 'USD' })).toBe('$690.00');
    expect(formatMoney({ amount: -12.5, currency: 'EUR' }, { signed: true })).toBe(`${MINUS}12.50 EUR`);
  });

  it('compact money fits chart axes and calendar cells', () => {
    expect(formatMoney(950, { signed: true, compact: true })).toBe('+$950');
    expect(formatMoney(12_340, { signed: true, compact: true })).toBe('+$12.3k');
    expect(formatMoney(-250_000, { signed: true, compact: true })).toBe(`${MINUS}$250k`);
    expect(formatMoney(0.2, { signed: true, compact: true })).toBe('$0');
  });

  it('percent: 2 dp price change, 1 dp statistics', () => {
    expect(formatPercent(0.15)).toBe('+0.15%');
    expect(formatPercent(-2.06)).toBe(`${MINUS}2.06%`);
    expect(formatPercent(61.7, 1, { signed: false })).toBe('61.7%');
  });

  it('volume uses K/M', () => {
    expect(formatVolume(30_400_000)).toBe('30.4M');
    expect(formatVolume(183_000)).toBe('183K');
    expect(formatVolume(842_400)).toBe('842K');
    expect(formatVolume(2_710_000)).toBe('2.71M');
    expect(formatVolume(950)).toBe('950');
    expect(formatInt(1284)).toBe('1,284');
    expect(formatInt(-1284)).toBe(`${MINUS}1,284`);
  });

  it('durations and countdowns', () => {
    expect(formatDuration(38)).toBe('38ms');
    expect(formatDuration(420)).toBe('420ms');
    expect(formatDuration(1200)).toBe('1.2s');
    expect(formatDuration(16_400)).toBe('16.4s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect([0, 999, 8_400, 42_000, 59_999, 72_000, 125_000, 723_000, 3_723_000].map(formatElapsed)).toEqual([
      '0s',
      '0s',
      '8s',
      '42s',
      '59s',
      '1:12',
      '2:05',
      '12:03',
      '1:02:03',
    ]);
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatCountdown(150_000)).toBe('02:30');
    expect(formatCountdown(4_650_000)).toBe('1:17:30');
    expect(formatCountdown(-5)).toBe('00:00');
  });

  it('clock in exchange time', () => {
    const t = Date.UTC(2026, 9, 2, 18, 42, 30);
    expect(formatClock(t, 'America/New_York')).toBe('14:42:30');
    expect(formatClock(t, 'America/New_York', false)).toBe('14:42');
  });

  it('precision from tick size', () => {
    expect(precisionFromTick(0.25)).toBe(2);
    expect(precisionFromTick(0.01)).toBe(2);
    expect(precisionFromTick(1)).toBe(0);
    expect(precisionFromTick(0.0001)).toBe(4);
    expect(precisionFromTick(0.5)).toBe(1);
  });

  it('tone follows sign', () => {
    expect(toneOf(1)).toBe('up');
    expect(toneOf(-1)).toBe('down');
    expect(toneOf(0)).toBe('flat');
    expect(toneOf(null)).toBe('flat');
  });
});
