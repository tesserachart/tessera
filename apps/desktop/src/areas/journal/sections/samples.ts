import type {
  Bucket,
  CalendarDay,
  CalendarOutput,
  ComplianceOutput,
  DayEntry,
  EquityPoint,
  JournalStats,
  JournalTrade,
  ListTradesOutput,
  RecentDaysOutput,
  Setup,
  Side,
  TradeDetail,
  TrashedTrade,
} from '@tessera/protocol';
import { monthBounds } from '../model/calendar.ts';
import type { PnlPoint } from '../model/runningPnl.ts';
import { addDays } from '../model/scope.ts';

const SAMPLE_DATE = '2026-03-12';
const SAMPLE_PRIOR_DATE = '2026-03-11';
const MINUTE_NS = 60e9;
const OPEN_NS = Date.parse(`${SAMPLE_DATE}T14:35:00Z`) * 1e6;

export const SAMPLE_NOW_MS = Date.parse(`${SAMPLE_DATE}T20:00:00Z`);

function sampleBucket(key: string, label: string, net: number, n: number): Bucket {
  const wins = Math.max(1, Math.round(n * 0.6));
  const losses = Math.max(1, n - wins);
  const grossLoss = 180 * losses;
  const grossProfit = net + grossLoss;
  return {
    key,
    label,
    n,
    wins,
    losses,
    breakevens: 0,
    net,
    grossProfit,
    grossLoss,
    fees: 4.2 * n,
    avg: net / n,
    winRate: (wins / n) * 100,
    profitFactor: grossProfit / grossLoss,
    avgWin: grossProfit / wins,
    avgLoss: grossLoss / losses,
    expectancy: net / n,
    nR: n,
    totalR: 3.4,
    avgR: 0.28,
    nRInitial: n,
    avgRInitial: 0.31,
    days: Math.max(1, Math.ceil(n / 4)),
  };
}

export const SAMPLE_BUCKET = sampleBucket('all', 'All trades', 1250, 12);

function sampleTrade(i: number, date: string, side: Side, net: number): JournalTrade {
  const openedAt = OPEN_NS + i * 23 * MINUTE_NS;
  const entryPrice = 21_480.25 + i * 6.5;
  const points = net / 20;
  return {
    id: `sample-${String(i)}`,
    accountId: 'sample',
    accountName: 'Paper account',
    instrument: 'NQM6.CME',
    symbol: 'NQ',
    side,
    status: 'closed',
    qty: 1,
    maxQty: 1,
    entryPrice,
    exitPrice: entryPrice + (side === 'buy' ? points : -points),
    openedAt,
    closedAt: openedAt + 7 * MINUTE_NS,
    tradeDate: date,
    holdSecs: 420,
    grossPnl: net + 4.2,
    fees: 4.2,
    netPnl: net,
    points,
    ticks: points * 4,
    priceDecimals: 2,
    outcome: net >= 0 ? 'win' : 'loss',
    result: net >= 0 ? 'target' : 'stop',
    stopPrice: entryPrice - 10,
    targetPrice: entryPrice + 20,
    planFrom: 'order',
    risk: 200,
    rMultiple: net / 200,
    plannedRr: 2,
    mae: -120,
    mfe: 310,
    maePrice: entryPrice - 6,
    mfePrice: entryPrice + 15.5,
    setupId: 'sample-setup',
    setupName: 'Opening range',
    tags: [{ id: 'sample-tag', name: 'Patient', color: '#9bab78', group: 'Context' }],
    rating: 4,
    reviewed: i % 2 === 0,
    emotion: null,
    exitReason: null,
    hasNotes: i % 3 === 0,
    attachments: 0,
    origin: 'broker',
    source: 'sample',
    reportedPnl: null,
    executions: 2,
    activity: null,
  };
}

export const SAMPLE_TRADES: readonly JournalTrade[] = [
  sampleTrade(0, SAMPLE_DATE, 'buy', 412.5),
  sampleTrade(1, SAMPLE_DATE, 'sell', -187.5),
  sampleTrade(2, SAMPLE_DATE, 'buy', 1025),
  sampleTrade(3, SAMPLE_PRIOR_DATE, 'sell', 262.5),
  sampleTrade(4, SAMPLE_PRIOR_DATE, 'buy', -312.5),
  sampleTrade(5, SAMPLE_PRIOR_DATE, 'buy', 650),
];

export const SAMPLE_TRADE_LIST: ListTradesOutput = {
  trades: [...SAMPLE_TRADES],
  total: SAMPLE_TRADES.length,
  summary: SAMPLE_BUCKET,
};

export const SAMPLE_TRASH: readonly TrashedTrade[] = SAMPLE_TRADES.slice(0, 3).map((trade, i) => ({
  trade,
  trashedAt: OPEN_NS + (i + 1) * 90 * MINUTE_NS,
}));

export const SAMPLE_DAY: DayEntry = {
  date: SAMPLE_DATE,
  content: 'Waited for the opening range to settle, then took the first clean retest of its high.',
  startedAt: OPEN_NS - 30 * MINUTE_NS,
  updatedAt: OPEN_NS,
  checklist: [
    { id: 'sample-1', text: 'Marked the overnight high and low', checked: true },
    { id: 'sample-2', text: 'Read the economic calendar', checked: true },
    { id: 'sample-3', text: 'Set the daily loss limit', checked: false },
  ],
  trades: SAMPLE_TRADES.slice(0, 3),
  stats: sampleBucket(SAMPLE_DATE, 'Thu 12 Mar', 1250, 3),
  attachments: [],
  prev: null,
  next: null,
};

function sampleSetup(id: string, name: string, color: string, net: number, n: number): Setup {
  return {
    id,
    name,
    description: 'The first thirty minutes set a range; trade its break.',
    color,
    entryCriteria: 'A close outside the range on rising volume.',
    exitRules: 'Stop back inside the range; target at twice the risk.',
    rules: [
      { id: `${id}-1`, text: 'Wait for the close outside the range', category: 'entry' },
      { id: `${id}-2`, text: 'Stop at the far side of the range', category: 'risk' },
    ],
    active: true,
    studyId: null,
    createdAt: 0,
    stats: sampleBucket(id, name, net, n),
    adherence: [{ ruleId: `${id}-1`, followed: 8, trades: 10 }],
  };
}

export const SAMPLE_SETUPS: readonly Setup[] = [
  sampleSetup('sample-orb', 'Opening range', '#7f9fbf', 2450, 18),
  sampleSetup('sample-vwap', 'VWAP reclaim', '#9bab78', 1180, 11),
  sampleSetup('sample-fade', 'Failed breakout', '#c49a6c', 640, 7),
  sampleSetup('sample-trend', 'Trend pullback', '#a58fb8', 310, 5),
];

export const SAMPLE_COMPLIANCE: ComplianceOutput = {
  overall: 0.82,
  tradesWithSetups: 24,
  byCategory: { entry: 0.9, exit: 0.75, risk: 0.86, management: 0.62 },
  missed: [
    {
      ruleId: 'sample-1',
      ruleName: 'Wait for the close',
      category: 'entry',
      setupId: 'sample-orb',
      setupName: 'Opening range',
      count: 4,
    },
    {
      ruleId: 'sample-2',
      ruleName: 'Stop at the range',
      category: 'risk',
      setupId: 'sample-orb',
      setupName: 'Opening range',
      count: 2,
    },
  ],
};

export const SAMPLE_NOTE_LINES: readonly string[] = [
  'Plan: fade the first push into the overnight high, and sit out the lunch chop.',
  'Took the opening range break on its retest and scaled out into the prior day high.',
  'Next time: wait for the candle to close before adding to the position.',
];

const SAMPLE_EXCERPT =
  'Waited for the opening range to settle, then took the first clean retest of its high. Held through the pullback and scaled out into the prior day high. Skipped the afternoon chop as planned.';

export const SAMPLE_RECENT_DAYS: RecentDaysOutput = {
  days: [
    { date: SAMPLE_DATE, content: SAMPLE_EXCERPT, netPnl: 1250, trades: 3 },
    { date: SAMPLE_PRIOR_DATE, content: SAMPLE_EXCERPT, netPnl: -310, trades: 4 },
    { date: addDays(SAMPLE_PRIOR_DATE, -1), content: SAMPLE_EXCERPT, netPnl: 640, trades: 2 },
  ],
};

function sampleNet(i: number): number {
  return (((i * 37) % 11) - 4) * 85;
}

function sampleDay(date: string, i: number): CalendarDay {
  const net = sampleNet(i);
  return {
    date,
    stats: sampleBucket(date, date, net === 0 ? 120 : net, 2 + (i % 4)),
    journaled: i % 3 !== 1,
    unreviewed: i % 2,
  };
}

function isWeekday(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

export function sampleDays(from: string, to: string): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (let date = from, i = 0; date <= to; date = addDays(date, 1), i++)
    if (isWeekday(date)) days.push(sampleDay(date, i));
  return days;
}

export function sampleCalendar(month: string, today: string): CalendarOutput {
  const { from, to } = monthBounds(month);
  return {
    from,
    to,
    days: sampleDays(from, to < today ? to : today),
    total: SAMPLE_BUCKET,
    journalStreak: 4,
  };
}

const SAMPLE_EQUITY: readonly EquityPoint[] = Array.from({ length: 24 }, (_, k) => {
  const i = k + 1;
  const equity = Array.from({ length: i }, (_, j) => sampleNet(j + 3) + 60).reduce((a, b) => a + b, 0);
  return {
    i,
    tradeId: `sample-${String(i)}`,
    t: OPEN_NS + i * 1440 * MINUTE_NS,
    pnl: sampleNet(i + 2) + 60,
    equity,
    peak: equity,
    drawdown: 0,
  };
});

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const SESSIONS = ['Asia', 'London', 'New York'];
const MONTHS = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];

const buckets = (labels: readonly string[]): Bucket[] =>
  labels.map((label, i) => sampleBucket(label, label, sampleNet(i + 1) + 120, 4 + ((i * 5) % 9)));

export const SAMPLE_STATS: JournalStats = {
  breakevenThreshold: 5,
  timezone: 'UTC',
  overview: {
    all: SAMPLE_BUCKET,
    open: 0,
    winRateLow: 41,
    winRateHigh: 78,
    payoffRatio: 1.62,
    largestWin: 1025,
    largestLoss: -312.5,
    sharpe: 0.42,
    sortino: 0.71,
    avgWinR: 1.4,
    avgLossR: -0.9,
    maxDrawdown: 640,
    maxDrawdownPct: 12.5,
    currentDrawdown: 120,
    recoveryFactor: 1.95,
    calmar: 2.1,
    ulcerIndex: 3.4,
    timeInDrawdownPct: 38,
    drawdowns: 4,
    avgHoldSecs: 420,
    avgHoldWinSecs: 510,
    avgHoldLossSecs: 300,
    currentStreak: 2,
    maxWinStreak: 5,
    maxLossStreak: 3,
    kellyPct: 18.4,
    greenDays: 8,
    redDays: 4,
    avgDay: 104.17,
    bestDay: sampleBucket(SAMPLE_DATE, 'Thu 12 Mar', 1250, 3),
    worstDay: sampleBucket(SAMPLE_PRIOR_DATE, 'Wed 11 Mar', -310, 4),
    avgMae: -120,
    avgMfe: 310,
    nExcursion: 12,
    first: OPEN_NS,
    last: OPEN_NS,
  },
  equity: [...SAMPLE_EQUITY],
  drawdowns: [
    {
      start: OPEN_NS,
      trough: OPEN_NS + 1440 * MINUTE_NS,
      recovered: null,
      peak: 1800,
      depth: 640,
      depthPct: 12.5,
      trades: 5,
    },
  ],
  by: {
    day: buckets(['Mon 9 Mar', 'Tue 10 Mar', 'Wed 11 Mar', 'Thu 12 Mar']),
    week: buckets(['9 Mar', '2 Mar', '23 Feb']),
    month: buckets(MONTHS),
    weekday: buckets(WEEKDAYS),
    hour: buckets(['09', '10', '11', '13', '14', '15']),
    session: buckets(SESSIONS),
    symbol: buckets(['NQ', 'ES', 'CL']),
    side: buckets(['Long', 'Short']),
    setup: buckets(SAMPLE_SETUPS.map((s) => s.name)),
    tag: buckets(['Patient', 'Chased', 'Early exit']),
    account: buckets(['Paper account']),
    hold: buckets(['< 1m', '1–5m', '5–15m', '15m+']),
    size: buckets(['1', '2', '3+']),
    r: buckets(['< −2R', '−2–−1R', '−1–0R', '0–1R', '1–2R', '> 2R']),
    plannedRr: buckets(['< 1:1', '1–2:1', '2–3:1']),
    tradesPerDay: buckets(['1 trade', '2 trades', '3+ trades']),
    emotion: buckets(['Calm', 'Anxious']),
    result: buckets(['Target', 'Stop', 'Manual']),
  },
  streaks: {
    winRuns: [4, 3, 1, 1],
    lossRuns: [3, 2, 1],
    inWinRuns: sampleBucket('win-runs', 'In winning runs', 1640, 9),
    inLossRuns: sampleBucket('loss-runs', 'In losing runs', -390, 6),
  },
  sequences: {
    afterWin: sampleBucket('after-win', 'After a win', 410, 7),
    afterLoss: sampleBucket('after-loss', 'After a loss', -120, 5),
    after1Loss: sampleBucket('after-1', 'After 1 loss', 80, 3),
    after2Losses: sampleBucket('after-2', 'After 2 losses', -150, 2),
    after3Losses: sampleBucket('after-3', 'After 3+ losses', -60, 2),
    tradesPerDayCorrelation: -0.18,
  },
  behaviour: {
    nActivity: 0,
    nPartial: 0,
    nStop: 0,
    widened: [],
    management: [],
    breakeven: [],
    unprotected: [],
    endedBy: [],
    firstMove: [],
    avgInitialRisk: null,
    avgInitialRiskTicks: null,
    avgMoves: null,
    avgUnprotectedSecs: null,
    unprotectedPct: null,
    recordedSince: null,
  },
  bySymbolMonth: ['NQ', 'ES'].flatMap((symbol, s) =>
    MONTHS.map((month, i) => ({ symbol, month, net: sampleNet(i + s) + 90, n: 3 + i })),
  ),
};

const SAMPLE_TRADE = SAMPLE_TRADES[0]!;

export const SAMPLE_DETAIL: TradeDetail = {
  trade: SAMPLE_TRADE,
  executions: [
    {
      fillId: 'sample-entry',
      kind: 'entry',
      side: 'buy',
      qty: 1,
      price: SAMPLE_TRADE.entryPrice,
      ts: SAMPLE_TRADE.openedAt,
      fee: 2.1,
      realized: null,
      role: null,
    },
    {
      fillId: 'sample-exit',
      kind: 'exit',
      side: 'sell',
      qty: 1,
      price: SAMPLE_TRADE.exitPrice ?? SAMPLE_TRADE.entryPrice,
      ts: SAMPLE_TRADE.closedAt ?? SAMPLE_TRADE.openedAt,
      fee: 2.1,
      realized: SAMPLE_TRADE.netPnl,
      role: 'take_profit',
    },
  ],
  notes: SAMPLE_EXCERPT,
  attachments: [],
  rules: [],
  prevId: null,
  nextId: null,
  pointValue: 20,
  tickSize: 0.25,
  excursionNote: null,
  activity: null,
  drawings: [],
};

const RUNNING_PNL = [0, 120, 260, 180, 340, 520, 460, 610, 412.5];

export const SAMPLE_RUNNING_SERIES: readonly PnlPoint[] = RUNNING_PNL.map((pnl, i) => ({
  t: SAMPLE_TRADE.openedAt / 1e6 + i * 60_000,
  pnl,
  pos: i < RUNNING_PNL.length - 1 ? 1 : 0,
}));
