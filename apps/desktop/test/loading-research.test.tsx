import type { Card, RunDigest, SplitDigest, Study, StudyRun } from '@tessera/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch } from '../src/app/store.ts';
import type { ToolOutput } from '../src/app/tools.ts';
import { ResearchPage } from '../src/areas/research/ResearchPage.tsx';
import { researchViewStore } from '../src/areas/research/selection.ts';
import { blankStudy } from '../src/areas/research/model.ts';
import { runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
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

const study = {
  ...blankStudy('NQ'),
  id: 's-1',
  name: 'Opening drive',
  family: 'orb',
  hypothesis: 'The first thirty minutes lead the day.',
  state: 'draft',
  generation: 1,
  manifestHash: null,
  frozenAt: null,
  lastVerdict: null,
  author: null,
} as unknown as Study;

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
        trades: [],
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
} as unknown as StudyRun;

const coverage = (): ToolOutput<'market.data_coverage'> => ({
  card: {
    id: 'cov-1',
    body: {
      kind: 'data_coverage',
      symbol: 'NQ',
      scope: 'session',
      from: '2026-09-01',
      to: '2026-09-30',
      days: [],
      download: null,
    },
    actions: [],
    updatedAt: 1,
  },
  days: 20,
  printsSaved: 0,
  printsMissing: [],
  barsMissing: [],
  downloading: false,
});

const ANSWERS = {
  'research.list_studies': (): ToolOutput<'research.list_studies'> => ({ studies: [study], budgets: [budget] }),
  'research.get_study': (): ToolOutput<'research.get_study'> => ({ study, runs: [] }),
  'research.get_run': (): ToolOutput<'research.get_run'> => fullRun,
  'market.data_coverage': coverage,
};

const WITH_RUN = {
  ...ANSWERS,
  'research.get_study': (): ToolOutput<'research.get_study'> => ({ study, runs: [digest] }),
};

beforeEach(() => {
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(researchViewStore, { selected: null, fresh: false });
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
    { tools: [...Object.keys(SIM.tools), 'research.get_study', 'research.get_run', 'market.data_coverage'] },
  );
}

describe('a study loads as one unit', () => {
  it('says there are no studies only once the list has answered', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, false);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/studies|No studies/);
    expect(loaded).toContain('0 studies · 0 trials');
    expect(loaded).toContain('No studies yet.');
  });

  it('draws its skeleton from the page itself: the studies list beside a study form', async () => {
    mount(heldReads(SIM), false);
    await settle();
    const skeleton = screen.getByRole('status', { name: 'Loading studies' });
    expect(skeleton.querySelectorAll('.rs-row').length).toBeGreaterThan(1);
    expect(skeleton.querySelector('.rs-proto-head .rs-actions')).toBeTruthy();
    expect(skeleton.querySelector('.rs-form textarea')).toBeTruthy();
  });

  it('says there is no run only once the study has answered', async () => {
    const held = heldReads(SIM, ANSWERS);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toContain('No run yet');
    expect(loaded).toContain('No run yet.');
    expect(loaded).toContain('Opening drive');
    expect(screen.queryByRole('status', { name: 'Loading the study' })).toBeNull();
  });

  it('shows the verdict, the saved data and the equity curve together', async () => {
    const held = heldReads(SIM, WITH_RUN);
    const { container } = mount(held);
    const { loading, loaded } = await expectLoadsInOneGo(held, () => container);
    expect(loading).not.toMatch(/Reading|Lead|Saved data|Equity/);
    expect(loaded).toContain('Later sessions held up');
    expect(loaded).toContain('Coverage card cov-1');
    expect(loaded).toContain('Equity · Base');
    expect(loaded).not.toContain('No run yet');
    expect(screen.queryByRole('status', { name: 'Loading the run' })).toBeNull();
  });

  it('shows the run skeleton, not half a run, while another run is read', async () => {
    const second = { ...digest, runId: 'r-2', reason: 'Placebo beat it' };
    const held = heldReads(SIM, {
      ...ANSWERS,
      'research.get_study': (): ToolOutput<'research.get_study'> => ({ study, runs: [digest, second] }),
    });
    const { container } = mount(held);
    await expectLoadsInOneGo(held, () => container);
    fireEvent.click(container.querySelectorAll('.rs-run-row')[1]!);
    await settle();
    expect(
      screen.getByRole('status', { name: 'Loading the run' }).querySelector('.rs-verdict .rs-verdict-why'),
    ).toBeTruthy();
    expect(visibleText(container)).not.toContain('Placebo beat it');
    while (held.waiting > 0) {
      await act(async () => void held.answerNext());
      await settle();
    }
    await settle();
    expect(screen.queryByRole('status', { name: 'Loading the run' })).toBeNull();
    expect(visibleText(container)).toContain('Placebo beat it');
  });

  it('shows the study skeleton, not an empty "No run yet", while another study is read', async () => {
    const other = { ...study, id: 's-2', name: 'Gap fade' };
    const held = heldReads(SIM, {
      ...ANSWERS,
      'research.list_studies': (): ToolOutput<'research.list_studies'> => ({
        studies: [study, other],
        budgets: [budget],
      }),
      'research.get_study': (input): ToolOutput<'research.get_study'> =>
        input.id === 's-2' ? { study: other, runs: [digest] } : { study, runs: [] },
    });
    const { container } = mount(held);
    await expectLoadsInOneGo(held, () => container);
    expect(visibleText(container)).toContain('No run yet.');
    fireEvent.click(screen.getByRole('button', { name: /Gap fade/ }));
    await settle();
    expect(screen.getByRole('status', { name: 'Loading the study' })).toBeTruthy();
    expect(visibleText(container)).not.toMatch(/No run yet|Later sessions held up/);
    while (held.waiting > 0) {
      await act(async () => void held.answerNext());
      await settle();
    }
    await settle();
    expect(screen.queryByRole('status', { name: 'Loading the study' })).toBeNull();
    expect(visibleText(container)).toContain('Later sessions held up');
  });
});
