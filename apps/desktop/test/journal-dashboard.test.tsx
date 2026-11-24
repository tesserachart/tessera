import type {
  Bucket,
  CalendarOutput,
  JournalCatalog,
  JournalStats,
  JournalTrade,
  ListTradesOutput,
  Overview,
  TradeFilter,
} from '@tessera/protocol';
import type { UseQueryResult } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../src/areas/journal/sections/Dashboard.tsx';

const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';
const NOW = Date.parse(`${TODAY}T16:00:00-04:00`);

const journal = vi.hoisted(() => ({ trades: [] as JournalTrade[] }));

vi.mock('../src/areas/journal/data.ts', () => ({
  useToday: () => TODAY,
  useCatalog: () => ready(catalog()),
  useStats: (filter: TradeFilter) => ready(stats(filter)),
  useTrades: (filter: TradeFilter, _sort: unknown, _ascending: unknown, limit = 500) => ready(list(filter, limit)),
  useCalendar: (from: string, to: string, filter: TradeFilter) => ready(calendar(from, to, filter)),
  useJournalAction: () => () => Promise.resolve(null),
}));

vi.mock('../src/app/tools.ts', () => ({
  useHasTool: () => true,
  useToolValue: () => undefined,
  valueOf: <A,>(result: { data: A | undefined }) => result.data,
}));

vi.mock('../src/app/runtimeContext.ts', () => ({ useNow: () => NOW }));

function ready<A>(data: A): UseQueryResult<A> {
  return { data, isSuccess: true } as UseQueryResult<A>;
}

const cents = (v: number) => Math.round(v * 100) / 100;

function inFilter(filter: TradeFilter): JournalTrade[] {
  return journal.trades.filter(
    (t) =>
      (!filter.from || t.tradeDate >= filter.from) &&
      (!filter.to || t.tradeDate <= filter.to) &&
      (!filter.status || t.status === filter.status),
  );
}

function bucket(key: string, label: string, trades: readonly JournalTrade[]): Bucket {
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.outcome === 'win');
  const losses = closed.filter((t) => t.outcome === 'loss');
  const net = closed.reduce((s, t) => s + t.netPnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netPnl, 0);
  const decided = wins.length + losses.length;
  const winRate = decided ? cents((wins.length / decided) * 100) : null;
  const avgWin = wins.length ? cents(grossProfit / wins.length) : 0;
  const avgLoss = losses.length ? cents(grossLoss / losses.length) : 0;
  const w = (winRate ?? 0) / 100;
  return {
    key,
    label,
    n: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: closed.length - decided,
    net: cents(net),
    grossProfit: cents(grossProfit),
    grossLoss: cents(grossLoss),
    fees: cents(closed.reduce((s, t) => s + t.fees, 0)),
    avg: closed.length ? cents(net / closed.length) : 0,
    winRate,
    profitFactor: grossLoss > 0 ? cents(grossProfit / grossLoss) : null,
    avgWin,
    avgLoss,
    expectancy: cents(w * avgWin - (1 - w) * avgLoss),
    nR: 0,
    totalR: null,
    avgR: null,
    nRInitial: 0,
    avgRInitial: null,
    days: new Set(closed.map((t) => t.tradeDate)).size,
  };
}

function byDay(trades: readonly JournalTrade[]): Bucket[] {
  const dates = [...new Set(trades.filter((t) => t.status === 'closed').map((t) => t.tradeDate))].sort();
  const onDate = (date: string) => trades.filter((t) => t.tradeDate === date);
  return dates.map((date) => bucket(date, date, onDate(date)));
}

function stats(filter: TradeFilter): Pick<JournalStats, 'overview'> {
  const kept = inFilter(filter);
  const closed = kept.filter((t) => t.status === 'closed');
  const all = bucket('all', 'All trades', closed);
  const days = byDay(closed);
  const pnls = closed.map((t) => t.netPnl);
  const overview: Overview = {
    all,
    open: kept.length - closed.length,
    winRateLow: null,
    winRateHigh: null,
    payoffRatio: all.avgLoss > 0 && all.wins > 0 ? cents(all.avgWin / all.avgLoss) : null,
    largestWin: Math.max(0, ...pnls),
    largestLoss: Math.min(0, ...pnls),
    sharpe: null,
    sortino: null,
    avgWinR: null,
    avgLossR: null,
    maxDrawdown: 0,
    maxDrawdownPct: null,
    currentDrawdown: 0,
    recoveryFactor: null,
    calmar: null,
    ulcerIndex: 0,
    timeInDrawdownPct: 0,
    drawdowns: 0,
    avgHoldSecs: null,
    avgHoldWinSecs: null,
    avgHoldLossSecs: null,
    currentStreak: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    kellyPct: null,
    greenDays: days.filter((d) => d.net > 0).length,
    redDays: days.filter((d) => d.net < 0).length,
    avgDay: days.length ? cents(all.net / days.length) : null,
    bestDay: days.reduce<Bucket | null>((b, d) => (!b || d.net > b.net ? d : b), null),
    worstDay: days.reduce<Bucket | null>((b, d) => (!b || d.net < b.net ? d : b), null),
    avgMae: null,
    avgMfe: null,
    nExcursion: 0,
    first: closed.length ? Math.min(...closed.map((t) => t.openedAt)) : null,
    last: closed.length ? Math.max(...closed.map((t) => t.closedAt ?? 0)) : null,
  };
  return { overview };
}

function list(filter: TradeFilter, limit: number): ListTradesOutput {
  const kept = inFilter(filter).sort((a, b) => b.openedAt - a.openedAt);
  return { trades: kept.slice(0, limit), total: kept.length, summary: bucket('all', 'All trades', kept) };
}

function calendar(from: string, to: string, filter: TradeFilter): CalendarOutput {
  const kept = inFilter({ ...filter, from, to });
  return {
    from,
    to,
    days: byDay(kept).map((stats) => ({
      date: stats.key,
      stats,
      journaled: false,
      unreviewed: kept.filter((t) => t.tradeDate === stats.key).length,
    })),
    total: bucket('total', 'Total', kept),
    journalStreak: 0,
  };
}

function catalog(): JournalCatalog {
  return {
    accounts: [{ id: 'paper-main', name: 'Paper', origin: 'broker', platform: null, trades: journal.trades.length }],
    symbols: ['NQ'],
    tags: [],
    setups: [],
    filters: [],
    checklist: [],
    settings: { breakevenThreshold: 0, sessions: [] },
    imports: [],
    platforms: [],
    trades: journal.trades.length,
    trash: 0,
    activity: [],
    revision: 1,
  };
}

function session(date: string, nets: readonly number[]): JournalTrade[] {
  const open = Date.parse(`${date}T09:30:00-04:00`);
  return nets.map((net, i) => {
    const openedMs = open + i * 15 * 60_000;
    const points = net / 20;
    return {
      id: `${date}-${String(i + 1)}`,
      accountId: 'paper-main',
      accountName: 'Paper',
      instrument: 'NQZ6.CME',
      symbol: 'NQ',
      side: 'buy',
      status: 'closed',
      qty: 1,
      maxQty: 1,
      entryPrice: 20640,
      exitPrice: 20640 + points,
      openedAt: openedMs * 1e6,
      closedAt: (openedMs + 120_000) * 1e6,
      tradeDate: date,
      holdSecs: 120,
      grossPnl: net,
      fees: 0,
      netPnl: net,
      points,
      ticks: points * 4,
      priceDecimals: 2,
      outcome: net > 0 ? 'win' : net < 0 ? 'loss' : 'breakeven',
      result: 'manual',
      stopPrice: null,
      targetPrice: null,
      planFrom: null,
      risk: null,
      rMultiple: null,
      plannedRr: null,
      mae: null,
      mfe: null,
      maePrice: null,
      mfePrice: null,
      setupId: null,
      setupName: null,
      tags: [],
      rating: null,
      reviewed: false,
      emotion: null,
      exitReason: null,
      hasNotes: false,
      attachments: 0,
      origin: 'broker',
      source: 'paper',
      reportedPnl: null,
      executions: 2,
      activity: null,
    };
  });
}

const todayCard = () => screen.getByRole('region', { name: 'today' });

beforeEach(() => {
  journal.trades = [];
});
afterEach(cleanup);

describe('the journal dashboard’s Today card', () => {
  it('on the journal’s first trading day shows today’s net and sets it against nothing', () => {
    journal.trades = session(TODAY, [40, -15, 25, -10, 30, -20, 25]);
    render(<Dashboard />);
    const card = within(todayCard());
    expect(card.getByText('+$75.00')).toBeTruthy();
    expect(card.queryByText(/vs avg day/)).toBeNull();
  });

  it('sets today’s net against the trading days before it, signed once', () => {
    journal.trades = [...session(YESTERDAY, [-30, 20, -15]), ...session(TODAY, [40, -15, 25, -10, 30, -20, 25])];
    render(<Dashboard />);
    const card = within(todayCard());
    expect(card.getByText('+$75.00')).toBeTruthy();
    expect(card.getByText('▲ +$100.00 vs avg day')).toBeTruthy();
  });
});
