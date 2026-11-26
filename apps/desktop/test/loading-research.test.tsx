import type { Card, RunDigest, SplitDigest, Study, StudyRun } from '@tessera/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch } from '../src/app/store.ts';
import type { ToolOutput } from '../src/app/tools.ts';
import { ResearchPage } from '../src/areas/research/ResearchPage.tsx';
import { SAMPLE_STUDIES } from '../src/areas/research/samples.ts';
import { researchViewStore } from '../src/areas/research/selection.ts';
import { runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
import recorded from './fixtures/sim-research-run.json';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  RuntimeSettingsFeed,
  settle,
  SIM,
  unmountSurface,
  visibleText,
  type HeldReads,
} from './support/loading.tsx';

vi.mock('../src/analyst/cards/LiveCard.tsx', () => ({
  LiveCard: ({ card }: { card: Card }) => <div>{`Coverage card ${card.id}`}</div>,
}));

const study: Study = {
  ...SAMPLE_STUDIES[0]!,
  id: 's-1',
  name: 'Opening drive',
  hypothesis: 'The first thirty minutes lead the day.',
};

const split = (net: number): SplitDigest => ({
  sessions: 10,
  trades: 12,
  winRate: 0.5,
  winRateCi: [0.3, 0.7],
  avgTrade: net / 12,
  avgTradeCi: [-5, 5],
  netPnl: net,
  maxDrawdown: -400,
  approximateExits: 0,
});

const trade = (i: number, pnl: number) => ({
  qty: 1,
  entryTime: 1_790_000_000_000_000_000 + i * 3_600_000_000_000,
  entryPrice: 5000,
  exitTime: 1_790_000_000_000_000_000 + i * 3_600_000_000_000 + 600_000_000_000,
  exitPrice: 5000 + pnl / 50,
  pnl,
  costs: 5,
  bars: 2,
  mae: -50,
  mfe: 50,
  exit: 'signal',
  stop: null,
  target: null,
  approximate: false,
});

const result = (net: number) => ({
  sessions: 10,
  from: 1_790_000_000_000_000_000,
  to: 1_790_300_000_000_000_000,
  metrics: {
    trades: 12,
    wins: 6,
    losses: 6,
    winRate: 0.5,
    winRateCi: [0.3, 0.7],
    netPnl: net,
    avgTrade: net / 12,
    avgTradeCi: [-5, 5],
    avgWin: 150,
    avgLoss: -100,
    profitFactor: 1.4,
    maxDrawdown: -400,
    maxDrawdownPct: 0.04,
    largestWin: 300,
    largestLoss: -200,
    avgBars: 6,
    exposure: 0.2,
    longTrades: 6,
    shortTrades: 6,
    costs: 60,
    approximateExits: 0,
  },
  tradesPerSession: 1.2,
  meanCiBlock5: null,
  meanCiBlock20: null,
  halves: [1, 1],
});

const budget = { family: 'orb', trials: 3, freeParameters: 2, segments: 1 };

const digest = {
  runId: 'r-1',
  studyId: 's-1',
  generation: 1,
  at: 1_790_600_000_000_000_000,
  origin: { kind: 'user' },
  archivedAt: null,
  exploratory: true,
  manifestHash: null,
  verdict: 'lead',
  reason: 'Later sessions held up',
  sessions: 20,
  laterFromSession: 10,
  cases: [
    {
      case: { name: 'Base', slippageTicks: 1 },
      development: split(900),
      later: split(300),
      gates: [{ gate: 'Trades', measured: '24', passed: true }],
    },
  ],
  placebo: null,
  budget,
  levels: null,
} as unknown as RunDigest;

const fullRun = {
  id: 'r-1',
  studyId: 's-1',
  generation: 1,
  manifestHash: null,
  exploratory: true,
  at: 1,
  from: 1_790_000_000_000_000_000,
  to: 1_790_500_000_000_000_000,
  budget,
  evaluation: {
    cases: [
      {
        case: { name: 'Base', slippageTicks: 1 },
        development: result(900),
        later: result(300),
        gates: [],
        equity: [
          { time: 1, equity: 1000 },
          { time: 2, equity: 1400 },
          { time: 3, equity: 1200 },
        ],
        trades: [trade(1, 400), trade(2, -200)],
      },
    ],
    placebo: null,
    verdict: 'lead',
    reason: 'Later sessions held up',
    bars: 100,
    sessions: 20,
    laterFromSession: 10,
  },
  levels: null,
  origin: { kind: 'user' },
  archivedAt: null,
} as unknown as StudyRun;

const ANSWERS = {
  'research.list_studies': (): ToolOutput<'research.list_studies'> => ({ studies: [study], budgets: [budget] }),
  'research.list_runs': (): ToolOutput<'research.list_runs'> => ({ runs: [digest] }),
  'research.get_run': (input: { runId: string }): ToolOutput<'research.get_run'> => ({ ...fullRun, id: input.runId }),
  'market.data_coverage': (): ToolOutput<'market.data_coverage'> =>
    recorded.coverage as unknown as ToolOutput<'market.data_coverage'>,
};

beforeEach(() => {
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(researchViewStore, { selected: null, query: '', shelf: 'active', tab: 'overview', trade: null });
});

afterEach(unmountSurface);

function mount(held: HeldReads, feed = true) {
  return mountSurface(
    held.client,
    feed ? (
      <RuntimeSettingsFeed>
        <ResearchPage />
      </RuntimeSettingsFeed>
    ) : (
      <ResearchPage />
    ),
    { tools: [...Object.keys(SIM.tools), 'research.get_run', 'market.data_coverage'] },
  );
}

describe('research loads as one unit', () => {
  it('says there is no research only once the ledger has answered', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, false);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/No research/);
    expect(loaded).toContain('0 runs · 0 trials');
    expect(loaded).toContain('No research yet.');
  });

  it('draws its skeleton from the page itself: the run list beside a run', async () => {
    mount(heldReads(SIM), false);
    await settle();
    const skeleton = screen.getByRole('status', { name: 'Loading research' });
    expect(skeleton.querySelectorAll('.rs-row').length).toBeGreaterThan(1);
    expect(skeleton.querySelector('.rs-head .rs-actions')).toBeTruthy();
    expect(skeleton.querySelector('.rs-splits')).toBeTruthy();
  });

  it('shows the run’s verdict, idea, source and equity together', async () => {
    const held = heldReads(SIM, ANSWERS);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/Later sessions held up|Opening drive/);
    expect(loaded).toContain('Later sessions held up');
    expect(loaded).toContain('The first thirty minutes lead the day.');
    expect(loaded).toContain('Run by you');
    expect(loaded).toContain(`Coverage card ${recorded.coverage.card.id}`);
    expect(screen.getByRole('img', { name: /^Equity curve/ })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading the run' })).toBeNull();
  });

  it('shows the run skeleton, not half a run, while another run is read', async () => {
    const second = { ...digest, runId: 'r-2', at: digest.at - 1, reason: 'Placebo beat it' };
    const held = heldReads(SIM, {
      ...ANSWERS,
      'research.list_runs': (): ToolOutput<'research.list_runs'> => ({ runs: [digest, second] }),
    });
    const { container } = mount(held);
    await expectLoadsInOneGo(held, () => container);
    fireEvent.click(container.querySelectorAll('.rs-row')[1]!);
    await settle();
    expect(screen.getByRole('status', { name: 'Loading the run' }).querySelector('.rs-splits')).toBeTruthy();
    expect(visibleText(container)).not.toContain('Later sessions held up');
    while (held.waiting > 0) {
      await act(async () => void held.answerNext());
      await settle();
    }
    await settle();
    expect(screen.queryByRole('status', { name: 'Loading the run' })).toBeNull();
    expect(visibleText(container)).toContain('Placebo beat it');
  });
});
