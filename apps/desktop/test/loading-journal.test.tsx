import type * as ChartModule from '@tessera/chart';
import type {
  Bucket,
  CalendarOutput,
  DayEntry,
  JournalCatalog,
  JournalStats,
  JournalTrade,
  ListTradesOutput,
  ToolDescriptor,
  TradeDetail as TradeDetailRead,
} from '@tessera/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeClock } from '../src/app/clock.ts';
import { JournalPage, ScopeControls } from '../src/areas/journal/JournalPage.tsx';
import { Analytics } from '../src/areas/journal/sections/Analytics.tsx';
import { Dashboard } from '../src/areas/journal/sections/Dashboard.tsx';
import { Days } from '../src/areas/journal/sections/Days.tsx';
import { Import } from '../src/areas/journal/sections/Import.tsx';
import { Playbooks } from '../src/areas/journal/sections/Playbooks.tsx';
import { Settings } from '../src/areas/journal/sections/Settings.tsx';
import { TradeDetail } from '../src/areas/journal/sections/TradeDetail.tsx';
import { Trades } from '../src/areas/journal/sections/Trades.tsx';
import { journalUiStore, setJournal } from '../src/areas/journal/store.ts';
import { patch } from '../src/app/store.ts';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  settle,
  SIM,
  simAnswer,
  unmountSurface,
  visibleText,
  type HeldReads,
} from './support/loading.tsx';
import type { FakeClient } from './support/runtime.tsx';

vi.mock('@tessera/chart', async (original) => {
  const real = await original<typeof ChartModule>();
  return {
    ...real,
    createChart: () => ({
      addLayer: () => undefined,
      setLayerVisible: () => undefined,
      setData: () => undefined,
      update: () => undefined,
      setViewport: () => undefined,
      destroy: () => undefined,
    }),
  };
});

const NOW = Date.parse('2026-10-20T16:00:00-04:00');
const TODAY = '2026-10-20';
const YESTERDAY = '2026-10-19';

const JOURNAL_TOOLS = [
  'journal.get_catalog',
  'journal.get_stats',
  'journal.list_trades',
  'journal.get_calendar',
  'journal.get_day',
  'journal.get_trade',
  'journal.get_compliance',
  'journal.recent_days',
  'journal.list_trash',
  'journal.search',
  'market.get_candles',
];

type Answers = NonNullable<Parameters<typeof heldReads>[1]>;

const sim = (tool: string, input: unknown = null): unknown => simAnswer(SIM, tool, input);

const clock = Object.assign(new RuntimeClock(), { now: () => NOW });

beforeEach(() => {
  patch(journalUiStore, { section: 'overview', trade: null, day: null, setup: null, reportTab: 'overview' });
  setJournal({ filter: {}, scope: { account: 'all', range: 'all' } });
});

afterEach(unmountSurface);

function mount(held: HeldReads, surface: ReactNode, tools: readonly string[] | null = JOURNAL_TOOLS) {
  return mountWith(held.client, surface, tools);
}

function withoutHealth(client: FakeClient): FakeClient {
  return {
    ...client,
    subscribe: (topic, params, handler, options) =>
      topic === 'health' ? () => undefined : client.subscribe!(topic, params, handler, options),
  };
}

function mountWith(whole: FakeClient, surface: ReactNode, tools: readonly string[] | null) {
  return mountSurface(withoutHealth(whole), surface, { tools, clock });
}

const emptyBucket = (sim('journal.get_calendar') as CalendarOutput).total;
const bucket = (over: Partial<Bucket>): Bucket => ({ ...emptyBucket, ...over });
const TRADES_BUCKET = bucket({
  n: 4,
  wins: 3,
  losses: 1,
  net: 190,
  grossProfit: 240,
  grossLoss: 50,
  winRate: 75,
  profitFactor: 4.8,
  avg: 47.5,
  avgWin: 80,
  avgLoss: 50,
  expectancy: 47.5,
  days: 2,
});

function trade(id: string, date: string, net: number, hour: number): JournalTrade {
  const opened = Date.parse(`${date}T${String(hour)}:30:00-04:00`);
  return {
    id,
    accountId: 'paper-main',
    accountName: 'Paper',
    instrument: 'NQZ6.CME',
    symbol: 'NQ',
    side: 'buy',
    status: 'closed',
    qty: 1,
    maxQty: 1,
    entryPrice: 20640,
    exitPrice: 20640 + net / 20,
    openedAt: opened * 1e6,
    closedAt: (opened + 120_000) * 1e6,
    tradeDate: date,
    holdSecs: 120,
    grossPnl: net,
    fees: 0,
    netPnl: net,
    points: net / 20,
    ticks: net / 5,
    priceDecimals: 2,
    outcome: net > 0 ? 'win' : 'loss',
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
    setupId: 'orb',
    setupName: 'Opening range',
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
}

const TRADES = [
  trade('t1', TODAY, 80, 11),
  trade('t2', TODAY, -50, 10),
  trade('t3', YESTERDAY, 100, 11),
  trade('t4', YESTERDAY, 60, 10),
];

const SETUP = {
  id: 'orb',
  name: 'Opening range',
  description: 'The first thirty minutes break.',
  color: '#7f9fbf',
  entryCriteria: 'A close outside the range.',
  exitRules: 'Back inside the range.',
  rules: [{ id: 'r1', text: 'Wait for the close', category: 'entry' }],
  active: true,
  studyId: null,
  createdAt: 1,
  stats: TRADES_BUCKET,
  adherence: [{ ruleId: 'r1', followed: 3, trades: 4 }],
};

const catalogWith = (over: Partial<JournalCatalog>): JournalCatalog => ({
  ...(sim('journal.get_catalog', {}) as JournalCatalog),
  ...over,
});

const FULL_CATALOG = catalogWith({
  trades: TRADES.length,
  accounts: (sim('journal.get_catalog', {}) as JournalCatalog).accounts.map((a, i) => ({
    ...a,
    trades: i === 0 ? TRADES.length : 0,
  })),
  setups: [SETUP],
  tags: [{ id: 'g1', name: 'Patient', color: '#9bab78', group: 'Context', uses: 3, net: 140 }],
  imports: [
    {
      id: 'i1',
      platform: 'tradovate',
      format: 'Tradovate positions',
      filename: 'positions.csv',
      accountId: 'paper-main',
      createdAt: NOW,
      fills: 8,
      duplicates: 0,
    },
  ],
});

const inRange = (f: { from?: string | undefined; to?: string | undefined } | undefined) =>
  TRADES.filter((t) => (!f?.from || t.tradeDate >= f.from) && (!f?.to || t.tradeDate <= f.to));

function listed(filter: { from?: string | undefined; to?: string | undefined } | undefined): ListTradesOutput {
  const trades = inRange(filter);
  return { trades, total: trades.length, summary: TRADES_BUCKET };
}

function statsFor(): JournalStats {
  const base = sim('journal.get_stats', { filter: {}, compact: true }) as JournalStats;
  return {
    ...base,
    overview: {
      ...base.overview,
      all: TRADES_BUCKET,
      greenDays: 2,
      bestDay: bucket({ key: YESTERDAY, label: 'Mon 19 Oct', n: 2, net: 160 }),
    },
    equity: TRADES.map((t, i) => ({
      i: i + 1,
      tradeId: t.id,
      t: t.openedAt,
      pnl: t.netPnl,
      equity: TRADES.slice(0, i + 1).reduce((s, x) => s + x.netPnl, 0),
      peak: TRADES.slice(0, i + 1).reduce((s, x) => s + x.netPnl, 0),
      drawdown: 0,
    })),
  };
}

function calendar(from: string, to: string): CalendarOutput {
  return {
    from,
    to,
    days: [YESTERDAY, TODAY].map((date) => ({
      date,
      stats: bucket({ key: date, n: 2, net: date === TODAY ? 30 : 160 }),
      journaled: date === YESTERDAY,
      unreviewed: 1,
    })),
    total: TRADES_BUCKET,
    journalStreak: 3,
  };
}

function dayOf(date: string): DayEntry {
  const base = sim('journal.get_day', { date }) as DayEntry;
  return {
    ...base,
    date,
    content: 'Waited for the range to break, then took the first retest.',
    startedAt: NOW,
    prev: YESTERDAY,
    next: null,
    trades: TRADES.filter((t) => t.tradeDate === date),
    stats: bucket({ key: date, n: 2, wins: 1, losses: 1, net: 30 }),
  };
}

function detailOf(id: string): TradeDetailRead {
  const t = TRADES.find((x) => x.id === id) ?? TRADES[0]!;
  return {
    trade: t,
    executions: [
      {
        fillId: 'f1',
        kind: 'entry',
        side: 'buy',
        qty: 1,
        price: t.entryPrice,
        ts: t.openedAt,
        fee: 0,
        realized: null,
        role: null,
      },
      {
        fillId: 'f2',
        kind: 'exit',
        side: 'sell',
        qty: 1,
        price: t.exitPrice ?? 0,
        ts: t.closedAt ?? 0,
        fee: 0,
        realized: t.netPnl,
        role: null,
      },
    ],
    notes: 'Clean entry on the retest.',
    attachments: [],
    rules: [],
    prevId: 't2',
    nextId: null,
    pointValue: 20,
    tickSize: 0.25,
    excursionNote: null,
    activity: null,
    drawings: [],
  };
}

function candles() {
  const start = TRADES[0]!.openedAt / 1e6 - 40 * 60_000;
  return {
    instrument: 'NQZ6.CME',
    tf: '1m',
    priceDecimals: 2,
    tz: 'America/New_York',
    columns: ['t', 'o', 'h', 'l', 'c', 'v'],
    bars: Array.from(
      { length: 70 },
      (_, i) => [start + i * 60_000, 20640 + i, 20642 + i, 20638 + i, 20641 + i, 100] as const,
    ),
    lastBarOpen: false,
    provider: 'sim',
  };
}

const WITH_TRADES = {
  'journal.get_catalog': () => FULL_CATALOG,
  'journal.get_stats': () => statsFor(),
  'journal.list_trades': (i: { filter?: { from?: string; to?: string } }) => listed(i.filter),
  'journal.get_calendar': (i: { from: string; to: string }) => calendar(i.from, i.to),
  'journal.get_day': (i: { date: string }) => dayOf(i.date),
  'journal.recent_days': () => ({
    days: [{ date: YESTERDAY, content: 'Waited for the range to break.', netPnl: 160, trades: 2 }],
  }),
  'journal.get_compliance': () => ({
    overall: 0.75,
    tradesWithSetups: 4,
    byCategory: { entry: 0.75, exit: null, risk: null, management: null },
    missed: [{ setupId: 'orb', setupName: 'Opening range', ruleId: 'r1', ruleName: 'Wait for the close', count: 1 }],
  }),
  'journal.get_trade': (i: { id: string }) => detailOf(i.id),
  'journal.list_trash': () => ({ trades: [] }),
  'journal.search': () => ({ hits: [] }),
  'market.get_candles': () => candles(),
} as unknown as Answers;

const EMPTY_JOURNAL = {
  'journal.get_day': (i: { date: string }) => ({
    ...(sim('journal.get_day', { date: '2026-10-02' }) as DayEntry),
    date: i.date,
  }),
  'journal.get_trade': () => {
    throw new Error('no trade');
  },
  'journal.list_trash': () => ({ trades: [] }),
  'journal.search': () => ({ hits: [] }),
  'market.get_candles': () => candles(),
} as unknown as Answers;

async function loadsInOneGo(answers: Answers, surface: ReactNode) {
  const held = heldReads(SIM, answers);
  const { container } = mount(held, surface);
  const out = await expectLoadsInOneGo(held, () => container);
  return { ...out, container };
}

function expectCalm(loading: string, words: RegExp) {
  expect(loading).not.toMatch(words);
  expect(screen.queryByRole('status')).toBeNull();
}

describe('the journal shows a loading state, then all of a section at once', () => {
  it('the page waits for the tool list before deciding it has no journal', async () => {
    const descriptors: ToolDescriptor[] = JOURNAL_TOOLS.map((name) => ({
      name,
      mcpName: name,
      title: name,
      description: '',
      risk: 'read',
      category: 'journal',
      inputSchema: {},
      outputSchema: {},
      uiHints: { icon: null, resultView: null, activityLabel: null, hidden: false },
      idempotent: true,
      userOnly: false,
    }));
    let release: () => void = () => undefined;
    const listing = new Promise<ToolDescriptor[]>((resolve) => {
      release = () => resolve(descriptors);
    });
    const held = heldReads(SIM, WITH_TRADES);
    const client = {
      ...held.client,
      request: (method: string, params?: { name?: string; input?: unknown }) =>
        method === 'tools.list' ? listing : held.client.request!(method, params),
    };
    const { container } = mountWith(client, <JournalPage />, null);
    await settle();
    const body = () => container.querySelector('.jr-body')!;
    expect(visibleText(body())).not.toMatch(/no journal/i);
    expect(body().querySelector('[aria-busy="true"]')).not.toBeNull();
    await act(async () => {
      release();
      await listing;
    });
    await settle();
    expect(visibleText(body())).not.toMatch(/no journal/i);
    expect(body().querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('the account select waits for the catalog', async () => {
    const held = heldReads(SIM, WITH_TRADES);
    const { container } = mount(held, <ScopeControls />);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/Every account/);
    expect(loaded).toContain('Every account');
  });

  it('Dashboard of an empty journal decides before it shows anything', async () => {
    const { loading, loaded } = await loadsInOneGo(EMPTY_JOURNAL, <Dashboard />);
    expectCalm(loading, /No trades yet|Import trades/);
    expect(loaded).toContain('No trades yet. Import trades or connect an account to begin.');
  });

  it('Dashboard with trades draws every widget at once', async () => {
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Dashboard />);
    expectCalm(loading, /Today|Streak|Opening range|Journaled|\$/);
    expect(loaded).toContain('Day streak');
    expect(loaded).toContain('3');
    expect(loaded).toContain('Opening range');
    expect(loaded).toContain('Waited for the range to break.');
  });

  it('Trades of an empty journal', async () => {
    const { loading, loaded } = await loadsInOneGo(EMPTY_JOURNAL, <Trades />);
    expectCalm(loading, /No trades found|End of trades|Pick all/);
    expect(loaded).toContain('No trades found');
  });

  it('Trades with rows shows the table and its summary together', async () => {
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Trades />);
    expectCalm(loading, /NQ|trades|win rate/);
    expect(loaded).toContain('4 trades');
    expect(loaded).toContain('win rate');
    expect(loaded).toContain('Opening range');
  });

  it('one trade, with its bars and chart, appears at once', async () => {
    setJournal({ section: 'trades', trade: 't1' });
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <TradeDetail id="t1" />);
    expectCalm(loading, /Reading|NQ|Long|Reviewed/);
    expect(loaded).toContain('NQ');
    expect(loaded).toContain('Long');
    expect(loaded).not.toMatch(/Reading/);
  });

  it('a connection trade’s Delete says in its tooltip why it is disabled', async () => {
    await loadsInOneGo(WITH_TRADES, <Trades />);
    fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Trade actions' })[0]!, { button: 0 });
    const remove = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    const id = remove.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)?.textContent).toBe('From the connection');
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => remove.focus());
    expect(document.activeElement).toBe(remove);
    expect((await screen.findByRole('tooltip')).textContent).toBe('From the connection');
  });

  it('the trade page’s Delete says in its tooltip why it is disabled', async () => {
    setJournal({ section: 'trades', trade: 't1' });
    await loadsInOneGo(WITH_TRADES, <TradeDetail id="t1" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0 });
    const remove = await screen.findByRole('menuitem', { name: 'Delete trade' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    const id = remove.getAttribute('aria-describedby')!;
    expect(document.getElementById(id)?.textContent).toBe('From the connection');
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => remove.focus());
    expect(document.activeElement).toBe(remove);
    expect((await screen.findByRole('tooltip')).textContent).toBe('From the connection');
  });

  it('Days of an empty journal', async () => {
    const { loading, loaded } = await loadsInOneGo(EMPTY_JOURNAL, <Days />);
    expectCalm(loading, /No checklist yet|No trades on this day|Reading|0 days|Journaling streak/);
    expect(loaded).toContain('No trades on this day.');
  });

  it('Days with a journal entry', async () => {
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Days />);
    expectCalm(loading, /Reading|3 days|No trades on this day|NQ/);
    expect(loaded).toContain('3 days');
    expect(loaded).toContain('NQ');
  });

  it('stepping to another day keeps its parts calm until the day arrives', async () => {
    const held = heldReads(SIM, WITH_TRADES);
    const { container } = mount(held, <Days />);
    await expectLoadsInOneGo(held, () => container);
    await act(async () => {
      setJournal({ day: YESTERDAY });
    });
    await settle();
    expect(held.waiting).toBeGreaterThan(0);
    expect(visibleText(container)).not.toMatch(/No checklist yet|No trades on this day|Reading|Drop screenshots/);
    while (held.waiting > 0) {
      await act(async () => {
        held.answerNext();
        await Promise.resolve();
      });
      await settle();
    }
    expect(visibleText(container)).toContain('Total P&L');
  });

  it('Analytics of an empty journal', async () => {
    const { loading, loaded } = await loadsInOneGo(EMPTY_JOURNAL, <Analytics />);
    expectCalm(loading, /Measuring|No closed trades/);
    expect(loaded).toContain('No closed trades in this query');
  });

  it('Analytics with trades', async () => {
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Analytics />);
    expectCalm(loading, /Measuring|Measured from|Net P&L/);
    expect(loaded).toContain('Measured from 4 closed trades');
  });

  it('the Time tab brings its year heat map with the rest', async () => {
    setJournal({ reportTab: 'time' });
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Analytics />);
    expectCalm(loading, /Trading calendar|Day of week/);
    expect(loaded).toContain('Trading calendar');
    expect(loaded).toContain('Day of week');
  });

  it('Playbooks of an empty journal', async () => {
    const { loading, loaded } = await loadsInOneGo(EMPTY_JOURNAL, <Playbooks />);
    expectCalm(loading, /A setup is a trade|Its trades draw/);
    expect(loaded).toContain('A setup is a trade you take again and again');
  });

  it('Playbooks with a setup draws its stats, curve and trades together', async () => {
    const { loading, loaded } = await loadsInOneGo(WITH_TRADES, <Playbooks />);
    expectCalm(loading, /Opening range|Its trades draw|No closed trades with this setup/);
    expect(loaded).toContain('Opening range');
    expect(loaded).toContain('Latest trades');
    expect(loaded).not.toContain('Its trades draw the curve.');
  });

  it('Import', async () => {
    const empty = await loadsInOneGo(EMPTY_JOURNAL, <Import />);
    expectCalm(empty.loading, /Nothing imported yet|Auto-detect/);
    expect(empty.loaded).toContain('Nothing imported yet');
    unmountSurface();
    const full = await loadsInOneGo(WITH_TRADES, <Import />);
    expectCalm(full.loading, /positions\.csv|Tradovate/);
    expect(full.loaded).toContain('positions.csv');
  });

  it('Settings', async () => {
    const empty = await loadsInOneGo(EMPTY_JOURNAL, <Settings />);
    expectCalm(empty.loading, /No tags yet|No checklist yet|Pre-market check/);
    expect(empty.loaded).toContain('Pre-market check');
    unmountSurface();
    const full = await loadsInOneGo(WITH_TRADES, <Settings />);
    expectCalm(full.loading, /Patient|How trades are read/);
    expect(full.loaded).toContain('Patient');
  });
});
