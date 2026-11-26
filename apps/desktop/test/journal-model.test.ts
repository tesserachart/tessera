import { formatMoney } from '@tessera/ui';
import type { Bucket, CalendarDay, JournalStats, JournalTrade } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { addMonths, intensity, monthBounds, monthGrid, yearColumns } from '../src/areas/journal/model/calendar.ts';
import { autoTimeframe, cumulative } from '../src/areas/journal/model/chart.ts';
import { clockSec } from '../src/areas/journal/model/activity.ts';
import { clock, dayLabel, holdLabel, longDate, rLabel, todayIn } from '../src/areas/journal/model/format.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { inline, parse, plainText, toggleTask } from '../src/areas/journal/model/markdown.ts';
import { metricText } from '../src/areas/journal/model/metrics.ts';
import { clean, filterChips, rangeDates, scopedFilter, toggle, withoutChip } from '../src/areas/journal/model/scope.ts';
import { headline } from '../src/areas/journal/model/stats.ts';
import { advance, replayStart, shownBars, stepBar } from '../src/areas/journal/model/replay.ts';
import { runningPnl } from '../src/areas/journal/model/runningPnl.ts';
import { symbolSeries } from '../src/areas/journal/model/symbols.ts';
import { excerpt, journalStatus, priorDays, vsAvgDay, wordCount } from '../src/areas/journal/model/dashboard.ts';
import { deletePicks, groupByDay, shownColumns, stepRow } from '../src/areas/journal/model/table.ts';
import { nsAt } from './support/time.ts';

const bucket = (over: Partial<Bucket> = {}): Bucket => ({
  key: 'k',
  label: 'L',
  n: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  net: 0,
  grossProfit: 0,
  grossLoss: 0,
  fees: 0,
  avg: 0,
  winRate: null,
  profitFactor: null,
  avgWin: 0,
  avgLoss: 0,
  expectancy: 0,
  nR: 0,
  totalR: null,
  avgR: null,
  nRInitial: 0,
  avgRInitial: null,
  days: 0,
  ...over,
});

const day = (date: string, net: number, n = 1): CalendarDay => ({
  date,
  stats: bucket({ key: date, n, net }),
  journaled: false,
  unreviewed: 0,
});

describe('journal words', () => {
  it('reads dates, holds and R as the trader does', () => {
    expect(dayLabel('2026-10-02')).toBe('Fri 2 Oct');
    expect(longDate('2026-10-02')).toBe('Friday 2 October 2026');
    expect(holdLabel(45)).toBe('45s');
    expect(holdLabel(33 * 60)).toBe('33m');
    expect(holdLabel(65 * 60)).toBe('1h 05m');
    expect(holdLabel(26 * 3600)).toBe('1d 2h');
    expect(holdLabel(null)).toBe('—');
    expect(rLabel(1.254)).toBe('+1.25R');
    expect(rLabel(-0.5)).toBe('−0.50R');
    expect(rLabel(null)).toBe('—');
    expect(formatMoney(1240, { signed: true, compact: true })).toBe('+$1,240');
    expect(formatMoney(-12_400, { signed: true, compact: true })).toBe('−$12.4k');
    expect(todayIn('America/New_York', Date.UTC(2026, 9, 3, 1))).toBe('2026-10-02');
  });

  it('writes clock times and today in the user’s zone, across a clock change', () => {
    expect(clock(nsAt('2026-10-23T13:30:00Z'), 'Europe/London')).toBe('14:30');
    expect(clock(nsAt('2026-10-26T13:30:00Z'), 'Europe/London')).toBe('13:30');
    expect(clock(nsAt('2026-10-23T13:30:00Z'), 'Asia/Tokyo')).toBe('22:30');
    expect(clock(nsAt('2026-10-26T13:30:00Z'), 'Asia/Tokyo')).toBe('22:30');
    expect(todayIn('Europe/London', Date.parse('2026-10-25T23:30:00Z'))).toBe('2026-10-25');
    expect(todayIn('Europe/London', Date.parse('2026-10-24T23:30:00Z'))).toBe('2026-10-25');
    expect(todayIn('Asia/Tokyo', Date.parse('2026-10-25T15:30:00Z'))).toBe('2026-10-26');
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(clock(nsAt('2026-10-26T13:30:00Z'))).toBe('22:30');
    expect(clockSec(nsAt('2026-10-26T13:30:05Z'))).toBe('22:30:05');
    expect(todayIn(undefined, Date.parse('2026-10-25T15:30:00Z'))).toBe('2026-10-26');
    putRuntimeSettings({ 'display.timeZone': 'Europe/London' }, false);
    expect(clock(nsAt('2026-10-26T13:30:00Z'))).toBe('13:30');
    putRuntimeSettings({ 'display.timeZone': null }, false);
  });
});

describe('scope and filter', () => {
  it('turns a range into trade dates', () => {
    expect(rangeDates('week', '2026-10-08')).toEqual({ from: '2026-10-05', to: null });
    expect(rangeDates('month', '2026-10-08').from).toBe('2026-10-01');
    expect(rangeDates('30d', '2026-10-08').from).toBe('2026-09-09');
    expect(rangeDates('ytd', '2026-10-08').from).toBe('2026-01-01');
    expect(rangeDates('all', '2026-10-08')).toEqual({ from: null, to: null });
  });

  it('merges the account and range under the finer filter, its own dates first', () => {
    const f = scopedFilter({ account: 'paper-main', range: 'month' }, { side: 'buy', tags: [] }, '2026-10-08');
    expect(f).toEqual({ side: 'buy', accounts: ['paper-main'], from: '2026-10-01' });
    const own = scopedFilter({ account: 'all', range: 'month' }, { from: '2026-09-01' }, '2026-10-08');
    expect(own.from).toBe('2026-09-01');
    expect(clean({ search: '', setups: [], minR: 0 })).toEqual({ minR: 0 });
  });

  it('names what narrows the view and removes it', () => {
    const f = { side: 'sell' as const, minPnl: -100, maxPnl: 50, weekdays: [1, 5], tags: ['t1'] };
    const chips = filterChips(f, null);
    expect(chips.map((c) => c.label)).toEqual(['Shorts', '#t1', 'Mon Fri', '−$100.00 to +$50.00']);
    const without = withoutChip(f, 'minPnl');
    expect(without.minPnl).toBeUndefined();
    expect(without.maxPnl).toBeUndefined();
    expect(toggle([1, 2], 2)).toEqual([1]);
    expect(toggle([1], 1)).toBeUndefined();
    expect(toggle(undefined, 3)).toEqual([3]);
  });
});

describe('calendar grid', () => {
  it('lays a month in Monday-first weeks with week totals', () => {
    const weeks = monthGrid('2026-10', [day('2026-10-01', 100), day('2026-10-02', -40, 3), day('2026-09-30', 999)]);
    expect(weeks[0]!.start).toBe('2026-09-28');
    expect(weeks[0]!.days[0]!.inMonth).toBe(false);
    expect(weeks[0]!.net).toBe(60);
    expect(weeks[0]!.trades).toBe(4);
    expect(weeks[0]!.traded).toBe(2);
    expect(weeks[weeks.length - 1]!.days[6]!.date).toBe('2026-11-01');
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect([intensity(0, 100), intensity(10, 100), intensity(-60, 100), intensity(100, 100)]).toEqual([0, 1, 3, 4]);
    const cols = yearColumns('2026-10-08');
    expect(cols).toHaveLength(53);
    expect(cols[cols.length - 1]![6]!.date).toBe('2026-10-11');
    expect(cols[cols.length - 1]![6]!.inMonth).toBe(false);
  });
});

describe('chart helpers', () => {
  it('picks a timeframe for the hold and sums a running total', () => {
    expect(autoTimeframe(30 * 60)).toBe('1m');
    expect(autoTimeframe(2 * 3600)).toBe('5m');
    expect(autoTimeframe(10 * 3600)).toBe('1h');
    expect(cumulative([5, -2, 4])).toEqual([5, 3, 7]);
  });
});

describe('running P&L', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => ({ t: i * 60_000, c: 100 + i }));
  it('marks the open position and counts scale-ins and partial exits', () => {
    const fills = [
      { t: 10_000, side: 'buy' as const, qty: 1, price: 100 },
      { t: 70_000, side: 'buy' as const, qty: 1, price: 102 },
      { t: 130_000, side: 'sell' as const, qty: 1, price: 103 },
      { t: 190_000, side: 'sell' as const, qty: 1, price: 104 },
    ];
    const pts = runningPnl(bars, fills, 2, 60_000);
    expect(pts.map((p) => p.pnl)).toEqual([0, 0, 6, 10]);
    expect(pts.map((p) => p.pos)).toEqual([1, 2, 1, 0]);
  });
  it('reads a short the other way', () => {
    const pts = runningPnl(bars, [{ t: 0, side: 'sell', qty: 2, price: 101 }], 1, 60_000);
    expect(pts[0]?.pnl).toBe(2);
    expect(pts[pts.length - 1]?.pnl).toBe(-6);
  });
});

describe('replay clock', () => {
  const starts = [0, 60_000, 120_000, 180_000];
  it('moves a market minute a second at 1x', () => {
    expect(advance(0, 1000, 1)).toBe(60_000);
    expect(advance(0, 500, 10)).toBe(300_000);
  });
  it('shows the bars that had opened and steps between them', () => {
    expect(shownBars(starts, 59_999)).toBe(1);
    expect(shownBars(starts, 60_000)).toBe(2);
    expect(stepBar(starts, 60_000, 1)).toBe(120_000);
    expect(stepBar(starts, 0, -1)).toBe(0);
    expect(replayStart(starts, 130_000, 1)).toBe(60_000);
  });
});

describe('symbol trend', () => {
  it('lines up every symbol on every month, most traded first', () => {
    const rows = [
      { symbol: 'NQ', month: '2026-08', net: 100, n: 3 },
      { symbol: 'ES', month: '2026-08', net: -50, n: 1 },
      { symbol: 'NQ', month: '2026-09', net: 40, n: 2 },
    ];
    const cum = symbolSeries(rows, 'cumulative');
    expect(cum.months).toEqual(['Aug 2026', 'Sep 2026']);
    expect(cum.lines.map((l) => l.key)).toEqual(['NQ', 'ES']);
    expect(cum.lines[0]?.values).toEqual([100, 140]);
    expect(cum.lines[1]?.values).toEqual([-50, -50]);
    expect(symbolSeries(rows, 'monthly').lines[1]?.values).toEqual([-50, 0]);
  });
});

describe('dashboard', () => {
  it('reads where a day stands', () => {
    expect(journalStatus({ startedAt: null, content: '', checklist: [] })).toBe('not-started');
    expect(journalStatus({ startedAt: 1, content: '', checklist: [] })).toBe('in-progress');
    expect(journalStatus({ startedAt: null, content: 'plan', checklist: [] })).toBe('completed');
    expect(
      journalStatus({
        startedAt: 1,
        content: 'x',
        checklist: [
          { id: 'a', text: 'A', checked: true },
          { id: 'b', text: 'B', checked: false },
        ],
      }),
    ).toBe('in-progress');
    expect(wordCount('# Plan\n\n**Wait** for the open ![x](file:1)')).toBe(5);
    expect(excerpt('word '.repeat(80), 30).endsWith('…')).toBe(true);
  });

  it('sets today against the average of the trading days before it, once there is one', () => {
    expect(priorDays('2026-10-20')).toEqual({ from: '2026-09-21', to: '2026-10-19' });
    expect(vsAvgDay(120, undefined)).toBeNull();
    expect(vsAvgDay(120, { avgDay: null })).toBeNull();
    expect(vsAvgDay(120, { avgDay: 108 })).toEqual({ text: '▲ +$12.00 vs avg day', tone: 'up' });
    expect(vsAvgDay(-30, { avgDay: 20 })).toEqual({ text: '▼ −$50.00 vs avg day', tone: 'down' });
    expect(vsAvgDay(50, { avgDay: 0 })).toEqual({ text: '▲ +$50.00 vs avg day', tone: 'up' });
  });
});

describe('notes', () => {
  it('reads the Markdown a note uses, never HTML', () => {
    const blocks = parse(
      '# Plan\nOnly **longs** above `VWAP`.\n\n- [x] Levels\n- [ ] Max loss\n\n> Wait\n\n---\n1. one\n2. two',
    );
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ul', 'quote', 'hr', 'ol']);
    const ul = blocks[2];
    expect(ul?.t === 'ul' && ul.items.map((i) => i.task)).toEqual([true, false]);
    expect(inline('[x](javascript:alert(1))').some((n) => n.t === 'link')).toBe(false);
    expect(inline('see ![shot](file:abc)')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'img', alt: 'shot', src: 'file:abc' },
    ]);
    expect(parse('<b>hi</b>')).toEqual([{ t: 'p', c: [{ t: 'text', v: '<b>hi</b>' }] }]);
    expect(toggleTask('- [ ] a\n- [x] b', 1)).toBe('- [ ] a\n- [ ] b');
    expect(toggleTask('- [ ] a\n- [x] b', 0)).toBe('- [x] a\n- [x] b');
    expect(plainText('## Hi **there** [link](https://x.y)')).toBe('Hi there link');
  });
});

const trade = (id: string, date: string, net: number): JournalTrade =>
  ({
    id,
    tradeDate: date,
    netPnl: net,
    status: 'closed',
    outcome: net > 3 ? 'win' : net < -3 ? 'loss' : 'breakeven',
  }) as JournalTrade;

describe('trades table', () => {
  it('groups by day with subtotals and steps rows', () => {
    const g = groupByDay([trade('a', '2026-10-02', 100), trade('b', '2026-10-02', -40), trade('c', '2026-10-01', 2)]);
    expect(g.map((x) => [x.date, x.n, x.net, x.wins, x.losses])).toEqual([
      ['2026-10-02', 2, 60, 1, 1],
      ['2026-10-01', 1, 2, 0, 0],
    ]);
    expect(stepRow(['a', 'b', 'c'], 'b', 1)).toBe('c');
    expect(stepRow(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(stepRow(['a', 'b'], null, -1)).toBe('b');
    const cols = shownColumns(['setup'], ['fees']).map((c) => c.id);
    expect(cols).toContain('fees');
    expect(cols).not.toContain('setup');
    expect(cols).toContain('net');
  });

  it('deletes what it can and counts the trades the connection keeps', () => {
    const trades = [
      { ...trade('a', '2026-10-02', 100), origin: 'manual' as const },
      { ...trade('b', '2026-10-02', -40), origin: 'broker' as const },
      { ...trade('c', '2026-10-01', 2), origin: 'import' as const },
    ];
    expect(deletePicks(trades, new Set(['a', 'b']))).toEqual({ ids: ['a'], brokerCount: 1 });
    expect(deletePicks(trades, new Set(['b']))).toEqual({ ids: [], brokerCount: 1 });
    expect(deletePicks(trades, new Set(['a', 'c']))).toEqual({ ids: ['a', 'c'], brokerCount: 0 });
    expect(deletePicks(trades, new Set())).toEqual({ ids: [], brokerCount: 0 });
  });
});

describe('headline figures', () => {
  it('says what each figure is and how it was measured', () => {
    const all = bucket({
      n: 10,
      wins: 5,
      losses: 4,
      breakevens: 1,
      net: 420,
      grossProfit: 900,
      grossLoss: 480,
      winRate: 55.56,
      profitFactor: 1.88,
      avgWin: 180,
      avgLoss: 120,
      expectancy: 46.67,
      days: 3,
    });
    const stats = {
      breakevenThreshold: 3,
      overview: {
        all,
        open: 1,
        winRateLow: 26.7,
        winRateHigh: 81.1,
        payoffRatio: 1.5,
        maxDrawdown: 200,
        maxDrawdownPct: 40,
        currentDrawdown: 0,
      },
    } as unknown as JournalStats;
    const h = headline(stats);
    expect(h.map((x) => x.label)).toEqual([
      'Net P&L',
      'Win rate',
      'Profit factor',
      'Expectancy',
      'Avg win · loss',
      'Max drawdown',
      'Trades',
      'Average R',
    ]);
    expect(h[0]).toMatchObject({ text: '+$420.00', tone: 'up' });
    expect(h[1]!.sub).toBe('27–81%');
    expect(h[1]!.hint).toContain('1 within ±$3.00');
    expect(h[6]!.sub).toBe('1 open');
    expect(h[7]!.hint).toContain('No trade here has a planned stop');
    expect(headline(null)).toEqual([]);
    expect(metricText(55.5, 'winRate')).toBe('55.5%');
    expect(metricText(1234, 'net')).toBe('+$1,234.00');
  });
});
