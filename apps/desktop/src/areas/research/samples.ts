import type {
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestTrade,
  CaseDigest,
  CaseResult,
  RunDigest,
  SplitDigest,
  SplitResult,
  Study,
  StudyRun,
} from '@tessera/protocol';

const NS_PER_DAY = 86_400_000_000_000;
const SAMPLE_FROM = 1_782_000_000_000_000_000;
const SAMPLE_SESSIONS = 60;
const LATER_FROM_SESSION = 36;
const SAMPLE_TRADES = 48;

function sampleStudy(id: string, name: string, hypothesis: string, instrument: string): Study {
  return {
    id,
    name,
    family: 'orb',
    hypothesis,
    notes: null,
    data: {
      instrument,
      tf: '5m',
      from: null,
      to: null,
      rthOnly: false,
      developmentShare: 0.5,
      levels: [],
      window: null,
    },
    strategy: { kind: 'rules', rule: { rule: 'breakout', lookback: 20, holdBars: 12, sides: 'both' } },
    execution: {
      qty: 1,
      commissionPerContract: 1,
      stopTicks: null,
      targetTicks: null,
      fillCases: [
        { name: 'base', slippageTicks: 1 },
        { name: 'stressed', slippageTicks: 2 },
      ],
    },
    gates: { minTrades: 100, minWinRate: null, ciAboveZero: true, eachHalfPositive: true, developmentPositive: true },
    placeboRuns: 100,
    state: 'draft',
    generation: 1,
    manifestHash: null,
    frozenAt: null,
    lastVerdict: null,
    origin: null,
  };
}

export const SAMPLE_STUDIES: readonly Study[] = [
  sampleStudy(
    'sample-1',
    'Opening drive continuation',
    'When the first thirty minutes close beyond the overnight range, the session extends in that direction.',
    'NQ',
  ),
  sampleStudy('sample-2', 'Gap fade to prior close', 'Small opening gaps fill before the first hour ends.', 'ES'),
  sampleStudy('sample-3', 'Gamma flip rejection', 'First touches of the gamma flip reject by a full point.', 'NQ'),
];

const sampleTrades: readonly BacktestTrade[] = Array.from({ length: SAMPLE_TRADES }, (_, i) => {
  const entryTime = SAMPLE_FROM + Math.floor(i * (SAMPLE_SESSIONS / SAMPLE_TRADES)) * NS_PER_DAY;
  const pnl = ((i * 37) % 11) * 40 - 160;
  return {
    qty: 1,
    entryTime,
    entryPrice: 20_000 + i * 4,
    exitTime: entryTime + 3_600_000_000_000,
    exitPrice: 20_000 + i * 4 + pnl / 20,
    pnl,
    costs: 4.2,
    bars: 6,
    mae: -60,
    mfe: 120,
    exit: pnl > 0 ? 'target' : 'stop',
    stop: null,
    target: null,
    approximate: false,
  };
});

const sampleEquity: readonly BacktestEquityPoint[] = sampleTrades.reduce<BacktestEquityPoint[]>(
  (out, t) => [...out, { time: t.exitTime, equity: (out[out.length - 1]?.equity ?? 0) + t.pnl }],
  [],
);

function sampleMetrics(split: SplitDigest): BacktestMetrics {
  return {
    trades: split.trades,
    wins: Math.round(split.trades * (split.winRate ?? 0.5)),
    losses: split.trades - Math.round(split.trades * (split.winRate ?? 0.5)),
    winRate: split.winRate,
    winRateCi: split.winRateCi,
    netPnl: split.netPnl,
    avgTrade: split.avgTrade,
    avgTradeCi: split.avgTradeCi,
    avgWin: 210,
    avgLoss: -140,
    profitFactor: 1.32,
    maxDrawdown: split.maxDrawdown,
    maxDrawdownPct: 0.042,
    largestWin: 640,
    largestLoss: -320,
    avgBars: 6,
    exposure: 0.18,
    longTrades: Math.ceil(split.trades / 2),
    shortTrades: Math.floor(split.trades / 2),
    costs: split.trades * 4.2,
    approximateExits: split.approximateExits,
  };
}

function sampleSplit(split: SplitDigest, from: number, to: number): SplitResult {
  return {
    sessions: split.sessions,
    from,
    to,
    metrics: sampleMetrics(split),
    tradesPerSession: split.sessions ? split.trades / split.sessions : 0,
    meanCiBlock5: split.avgTradeCi,
    meanCiBlock20: null,
    halves: [1, 1],
  };
}

function sampleCase(digest: CaseDigest): CaseResult {
  const laterFrom = SAMPLE_FROM + LATER_FROM_SESSION * NS_PER_DAY;
  return {
    case: digest.case,
    development: sampleSplit(digest.development, SAMPLE_FROM, laterFrom),
    later: sampleSplit(digest.later, laterFrom, SAMPLE_FROM + SAMPLE_SESSIONS * NS_PER_DAY),
    gates: digest.gates,
    equity: [...sampleEquity],
    trades: [...sampleTrades],
  };
}

const sampleSplitDigest = (sessions: number, trades: number, net: number): SplitDigest => ({
  sessions,
  trades,
  winRate: 0.54,
  winRateCi: [0.41, 0.66],
  avgTrade: net / trades,
  avgTradeCi: [-12.5, 31.25],
  netPnl: net,
  maxDrawdown: -1_240,
  approximateExits: 0,
});

export function sampleDigest(study: Study, i: number): RunDigest {
  return { ...SAMPLE_DIGEST, runId: `sample-run-${String(i)}`, studyId: study.id, at: SAMPLE_FROM - i * NS_PER_DAY };
}

export const SAMPLE_DIGEST: RunDigest = {
  runId: 'sample-run',
  studyId: 'sample-1',
  generation: 1,
  at: SAMPLE_FROM,
  origin: null,
  archivedAt: null,
  exploratory: true,
  manifestHash: null,
  verdict: 'lead',
  reason: 'Later sessions held most of the development edge after costs',
  sessions: SAMPLE_SESSIONS,
  laterFromSession: LATER_FROM_SESSION,
  cases: [
    {
      case: { name: 'Base', slippageTicks: 1 },
      development: sampleSplitDigest(LATER_FROM_SESSION, 29, 1_860),
      later: sampleSplitDigest(SAMPLE_SESSIONS - LATER_FROM_SESSION, 19, 740),
      gates: [
        { gate: 'Trades in later sessions', measured: '19', passed: true },
        { gate: 'Later mean trade above zero', measured: '$38.95', passed: true },
        { gate: 'Placebo beaten', measured: '91%', passed: false },
      ],
    },
  ],
  placebo: null,
  budget: { family: 'orb', trials: 3, freeParameters: 2, segments: 1 },
  levels: null,
};

export function sampleRun(digest: RunDigest): StudyRun {
  return {
    id: digest.runId,
    studyId: digest.studyId,
    generation: 1,
    manifestHash: digest.manifestHash,
    exploratory: digest.exploratory,
    at: SAMPLE_FROM,
    from: SAMPLE_FROM,
    to: SAMPLE_FROM + SAMPLE_SESSIONS * NS_PER_DAY,
    budget: digest.budget,
    evaluation: {
      cases: digest.cases.map(sampleCase),
      placebo: digest.placebo,
      verdict: digest.verdict,
      reason: digest.reason,
      bars: SAMPLE_SESSIONS * 81,
      sessions: digest.sessions,
      laterFromSession: digest.laterFromSession,
    },
    levels: null,
    origin: null,
    archivedAt: null,
  };
}
