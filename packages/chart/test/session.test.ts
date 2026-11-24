import { describe, expect, it } from 'vitest';
import { SeriesStore, SessionModel, Weight, ZonedClock, timeLabel } from '../src/index.ts';
import { continuousBars, equityBars } from './fixtures.ts';

function model(
  bars: Parameters<SeriesStore['setData']>[0],
  opts: Partial<ConstructorParameters<typeof SessionModel>[0]> = {},
  tf = 300_000,
) {
  const store = new SeriesStore();
  const ch = store.setData(bars);
  const m = new SessionModel({ mode: 'collapse', timezone: 'America/New_York', dayStartMinutes: 0, ...opts }, tf);
  m.apply(store, ch);
  return { store, m };
}

describe('ZonedClock', () => {
  const clock = new ZonedClock('America/New_York');
  it('converts UTC to exchange time across DST', () => {
    expect(clock.parts(Date.UTC(2026, 9, 2, 13, 30)).minuteOfDay).toBe(9 * 60 + 30);
    expect(clock.parts(Date.UTC(2026, 11, 2, 14, 30)).minuteOfDay).toBe(9 * 60 + 30);
    expect(clock.offsetMs(Date.UTC(2026, 9, 2))).toBe(-4 * 3_600_000);
    expect(clock.offsetMs(Date.UTC(2026, 11, 2))).toBe(-5 * 3_600_000);
  });

  it('assigns Globex evenings to the next trading day', () => {
    const t = Date.UTC(2026, 9, 1, 22, 30);
    expect(clock.tradingDay(t, 18 * 60)).toBe(20261002);
    expect(clock.tradingDay(t, 0)).toBe(20261001);
    expect(clock.tradingDay(Date.UTC(2026, 9, 2, 13, 0), 18 * 60)).toBe(20261002);
  });
});

describe('SessionModel', () => {
  it('collapse mode: one slot per bar, breaks at each session', () => {
    const bars = equityBars(3);
    const { m } = model(bars);
    expect(Array.from(m.slot.subarray(0, 5))).toEqual([0, 1, 2, 3, 4]);
    expect(m.lastSlot).toBe(3 * 78 - 1);
    const breaks = [];
    for (let i = 0; i < m.length; i++) if (m.brk[i]) breaks.push(i);
    expect(breaks).toEqual([78, 156]);
    expect(m.day[0]).toBe(20260930);
    expect(m.day[m.length - 1]).toBe(20261002);
  });

  it('continuous mode keeps intraday gaps and collapses long ones', () => {
    const bars = continuousBars(10);
    bars.splice(5, 2);
    const later = continuousBars(3, bars.at(-1)!.t + 6 * 3_600_000, 9);
    const { m } = model([...bars, ...later], { mode: 'continuous', timezone: 'UTC' }, 60_000);
    expect(Array.from(m.slot.subarray(0, 8))).toEqual([0, 1, 2, 3, 4, 7, 8, 9]);
    expect(m.slot[8]).toBe(10);
    expect(m.brk[8]).toBe(1);
  });

  it('weights mark day, hour and minute boundaries', () => {
    const { m, store } = model(equityBars(2));
    expect(m.weight[78]).toBeGreaterThanOrEqual(Weight.Day);
    const i1000 = store.indexOfTime(Date.UTC(2026, 9, 2, 14, 0));
    expect(m.weight[i1000]).toBe(Weight.Hour2);
    expect(m.weight[store.indexOfTime(Date.UTC(2026, 9, 2, 15, 0))]).toBe(Weight.Hour1);
    expect(m.weight[i1000 + 6]).toBe(Weight.Min30);
    expect(m.weight[store.indexOfTime(Date.UTC(2026, 9, 2, 16, 0))]).toBe(Weight.Hour12);
  });

  it('weights mark a new week when the weekday goes back, Sunday last, or a week passes', () => {
    const day = (d: number) => ({ t: Date.UTC(2026, 9, d, 14), o: 1, h: 1, l: 1, c: 1, v: 1 });
    const { m } = model([day(1), day(2), day(4), day(5), day(6), day(13)], {}, 86_400_000);
    expect(Array.from(m.weight.subarray(1, m.length))).toEqual([
      Weight.Day,
      Weight.Day,
      Weight.Week,
      Weight.Day,
      Weight.Week,
    ]);
  });

  it('labels: day boundaries show the weekday, intraday shows HH:MM in exchange time', () => {
    const { m, store } = model(equityBars(2));
    const clock = m.clock;
    expect(timeLabel(clock, store.time[78]!, m.weight[78]!, m.day[78]!, 300_000)).toBe('Fri 2');
    const i = store.indexOfTime(Date.UTC(2026, 9, 2, 14, 0));
    expect(timeLabel(clock, store.time[i]!, m.weight[i]!, m.day[i]!, 300_000)).toBe('10:00');
  });

  it('incremental apply equals a full recompute', () => {
    const bars = equityBars(4);
    const full = model(bars).m;
    const store = new SeriesStore();
    const inc = new SessionModel({ mode: 'collapse', timezone: 'America/New_York', dayStartMinutes: 0 }, 300_000);
    inc.apply(store, store.setData(bars.slice(0, 10)));
    for (const b of bars.slice(10)) {
      const ch = store.upsert(b);
      if (ch) inc.apply(store, ch);
    }
    expect(Array.from(inc.slot.subarray(0, inc.length))).toEqual(Array.from(full.slot.subarray(0, full.length)));
    expect(Array.from(inc.weight.subarray(0, inc.length))).toEqual(Array.from(full.weight.subarray(0, full.length)));
  });

  it('slot ↔ index lookups', () => {
    const bars = continuousBars(10);
    bars.splice(5, 2);
    const { m } = model(bars, { mode: 'continuous', timezone: 'UTC' }, 60_000);
    expect(m.indexOfSlot(5.4)).toBe(4);
    expect(m.indexOfSlot(6.2)).toBe(5);
    expect(m.firstIndexFrom(5)).toBe(5);
    expect(m.lastIndexTo(6.9)).toBe(4);
    expect(m.lastIndexTo(7)).toBe(5);
    expect(m.indexOfSlot(-3)).toBe(0);
    expect(m.indexOfSlot(99)).toBe(7);
  });
});
