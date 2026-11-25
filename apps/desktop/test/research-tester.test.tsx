import { formatMoney } from '@tessera/ui';
import type { Card, RunDigest, StudyDetail, StudyList, StudyRun } from '@tessera/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import type { ToolOutput } from '../src/app/tools.ts';
import { areaStore } from '../src/areas/store.ts';
import { researchViewStore } from '../src/areas/research/selection.ts';
import { pct } from '../src/areas/research/model.ts';
import { tradeDayZone, tradesOf, monthBreakdown, sortTrades, numberedTrades } from '../src/areas/research/tester.ts';
import { ChartLinkedTrade } from '../src/chart/ChartLinkedTrade.tsx';
import { linkTrade, useLinkedTrade } from '../src/chart/linkedTrade.ts';
import { pendingViewport, viewportTaken } from '../src/chart/viewportRequests.ts';
import { runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
import recorded from './fixtures/sim-research-run.json';
import {
  heldReads,
  mountSurface,
  RuntimeSettingsFeed,
  settle,
  SIM,
  unmountSurface,
  type HeldReads,
} from './support/loading.tsx';

const CHART = { layoutId: 'default', tileId: 'chart-1' };

const desk = vi.hoisted(() => ({ symbol: [] as string[], timeframe: [] as string[] }));

vi.mock('../src/workspace/controller.ts', async (original) => ({
  ...(await original<object>()),
  activeChartTarget: () => CHART,
  showOnChart: (instrument: string) => {
    desk.symbol.push(instrument);
    return Promise.resolve(true);
  },
  setChartTimeframe: (tf: string) => {
    desk.timeframe.push(tf);
    return Promise.resolve(true);
  },
}));

vi.mock('../src/analyst/cards/LiveCard.tsx', () => ({
  LiveCard: ({ card }: { card: Card }) => <div>{`Coverage card ${card.id}`}</div>,
}));

const { ResearchPage } = await import('../src/areas/research/ResearchPage.tsx');

const run = { ...recorded.run, origin: { kind: 'user' }, archivedAt: null } as unknown as StudyRun;
const detail = recorded.detail as unknown as StudyDetail;
const list = recorded.list as unknown as StudyList;
const digest = {
  ...detail.runs[0]!,
  studyId: run.studyId,
  generation: run.generation,
  at: run.at,
  origin: { kind: 'agent', sessionId: 'ses-1', provider: 'claude-code' },
  archivedAt: null,
} as unknown as RunDigest;
const base = run.evaluation.cases[0]!;
const zone = tradeDayZone(detail.study);

const asked: { name: string; input: unknown }[] = [];
const ANSWERS = {
  'research.list_studies': (): ToolOutput<'research.list_studies'> => list,
  'research.list_runs': (): ToolOutput<'research.list_runs'> => ({ runs: [digest] }),
  'research.get_run': (): ToolOutput<'research.get_run'> => run,
  'market.data_coverage': (): ToolOutput<'market.data_coverage'> =>
    recorded.coverage as unknown as ToolOutput<'market.data_coverage'>,
  'research.archive_run': (input: unknown): ToolOutput<'research.archive_run'> => {
    asked.push({ name: 'research.archive_run', input });
    return { ...digest, archivedAt: 1 };
  },
  'research.delete_run': (input: unknown): ToolOutput<'research.delete_run'> => {
    asked.push({ name: 'research.delete_run', input });
    return { deleted: true };
  },
};

beforeEach(() => {
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(researchViewStore, { selected: null, query: '', shelf: 'active', tab: 'overview', trade: null });
  patch(areaStore, { area: 'research' });
  linkTrade(null);
  viewportTaken(CHART);
  desk.symbol = [];
  desk.timeframe = [];
  asked.length = 0;
});

afterEach(unmountSurface);

async function answerAll(held: HeldReads) {
  for (let i = 0; i < 50; i++) {
    await settle();
    if (held.waiting === 0) return;
    while (held.waiting > 0) await act(async () => void held.answerNext());
  }
}

async function mount() {
  const held = heldReads(SIM, ANSWERS);
  const view = mountSurface(
    held.client,
    <RuntimeSettingsFeed>
      <ResearchPage />
    </RuntimeSettingsFeed>,
    { tools: [...Object.keys(SIM.tools), ...Object.keys(ANSWERS)] },
  );
  await answerAll(held);
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
  return { ...view, held };
}

describe('a study’s run', () => {
  it('stays running when its pane comes back mid-run, so a second press cannot start it twice', async () => {
    const { held, container } = await mount();
    const runButton = () => screen.getByRole('button', { name: /^(Run again|Running…)$/ });
    fireEvent.click(runButton());
    await settle();
    expect(held.queued.filter((t) => t === 'research.run_study')).toHaveLength(1);
    act(() => {
      patch(researchViewStore, { query: 'nothing matches this' });
    });
    await settle();
    expect(container.querySelector('.rs-pane')).toBeNull();
    act(() => {
      patch(researchViewStore, { query: '' });
    });
    await settle();
    expect(runButton().textContent).toBe('Running…');
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(runButton());
    await settle();
    expect(held.queued.filter((t) => t === 'research.run_study')).toHaveLength(1);
  });
});

describe('a Research run reads at a glance', () => {
  it('lists the run under its idea with its verdict, trades, net and the chat it came from', async () => {
    await mount();
    const row = within(screen.getByRole('navigation', { name: 'Runs' })).getByRole('button', {
      name: new RegExp(detail.study.name),
    });
    const net = base.development.metrics.netPnl + base.later.metrics.netPnl;
    expect(row.textContent).toContain('Rejected');
    expect(row.textContent).toContain(`${String(base.trades.length)} trades`);
    expect(row.textContent).toContain(formatMoney(net, { signed: true }));
    expect(row.textContent).toContain('An analyst chat');
  });

  it('leads with the idea, the verdict and why, then development against later and the equity curve', async () => {
    const { container } = await mount();
    const head = container.querySelector('.rs-head')!;
    expect(head.querySelector('.rs-name')!.textContent).toBe(detail.study.name);
    expect(head.querySelector('.rs-state')!.textContent).toBe('Rejected');
    expect(head.querySelector('.rs-reason')!.textContent).toBe(run.evaluation.reason);
    expect(head.querySelector('.rs-idea')!.textContent).toBe(detail.study.hypothesis);
    const splits = within(screen.getByRole('table', { name: 'Development and later' }));
    for (const [name, split] of [
      ['Development', base.development],
      ['Later', base.later],
    ] as const) {
      const cells = [...splits.getByText(name).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent);
      expect(cells).toEqual([
        formatMoney(split.metrics.netPnl, { signed: true }),
        String(split.metrics.trades),
        pct(split.metrics.winRate),
        split.metrics.profitFactor!.toFixed(2),
        formatMoney(split.metrics.maxDrawdown),
        formatMoney(split.metrics.avgTrade, { signed: true }),
      ]);
    }
    expect(screen.getByRole('img', { name: /^Equity curve/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Drawdown, deepest −\$/ })).toBeTruthy();
  });

  it('keeps the quant statistics and the months in the overview', async () => {
    const { container } = await mount();
    const quant = (label: string) =>
      [...screen.getByText(label).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent);
    const later = tradesOf(base, 'later');
    const mae = later.reduce((s, t) => s + t.mae, 0) / later.length;
    expect(quant('Average MAE')[1]).toBe(formatMoney(mae, { signed: true }));
    for (const v of quant('Sharpe')) expect(v).toMatch(/^-?\d+\.\d\d$/);
    const months = monthBreakdown(base, zone);
    const rows = [...container.querySelectorAll('.rs-months tbody tr')];
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(['Sep 2026', 'Oct 2026']);
    expect(rows[1]!.querySelectorAll('td')[2]!.textContent).toBe(formatMoney(months[1]!.net, { signed: true }));
    expect(container.textContent).toContain(`Coverage card ${recorded.coverage.card.id}`);
  });

  it('shows the setup in plain words', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    await settle();
    expect(screen.getByText('Breakout of 20 bars, held 12')).toBeTruthy();
    expect(screen.getByText('09:30–12:00 New York')).toBeTruthy();
  });
});

describe('a trade links to the chart and back', () => {
  it('lists the trades, sortable, without drawing a chart of its own', async () => {
    const { container } = await mount();
    fireEvent.click(screen.getByRole('button', { name: `Trades · ${String(base.trades.length)}` }));
    await settle();
    expect(container.querySelector('canvas')).toBeNull();
    const table = screen.getByRole('table', { name: 'Trades' });
    const firstNumbers = () =>
      within(table)
        .getAllByRole('row')
        .slice(1)
        .filter((r) => r.querySelectorAll('td').length > 1)
        .map((r) => Number(r.querySelector('td')!.textContent));
    expect(firstNumbers()).toEqual(base.trades.map((_, i) => i + 1));
    expect(within(table).getByText(`Later · ${String(tradesOf(base, 'later').length)}`)).toBeTruthy();
    const pnl = within(table).getByRole('button', { name: /^P&L/ });
    fireEvent.click(pnl);
    await settle();
    expect(firstNumbers()).toEqual(sortTrades(numberedTrades(base), 'pnl', false).map((r) => r.n));
    expect(pnl.closest('th')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('puts the trade on the active chart at its moment, and comes back to it', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: `Trades · ${String(base.trades.length)}` }));
    await settle();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show trade 7 on the chart' }));
      await settle();
    });
    const trade = base.trades[6]!;
    expect(read(areaStore).area).toBe('desk');
    expect(desk.symbol).toEqual([detail.study.data.instrument]);
    expect(desk.timeframe).toEqual(['5m']);
    const view = pendingViewport(CHART)!;
    expect(view.from).toBeLessThan(trade.entryTime);
    expect(view.to).toBeGreaterThan(trade.exitTime);

    const shown = render(<Linked />);
    expect(shown.container.textContent).toBe(`Trade 7 · ${detail.study.name}`);
    patch(researchViewStore, { tab: 'overview', trade: null });
    fireEvent.click(shown.getByRole('button', { name: `Trade 7 · ${detail.study.name}` }));
    expect(read(areaStore).area).toBe('research');
    expect(read(researchViewStore)).toMatchObject({ selected: run.id, tab: 'trades', trade: 7 });
    shown.unmount();
  });

  it('draws the trade only on the chart it was sent to, and hides it on request', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const chart = {
      addLayer: (l: { id: string }) => added.push(l.id),
      removeLayer: (id: string) => removed.push(id),
    } as unknown as Parameters<typeof ChartLinkedTrade>[0]['chart'];
    linkTrade({
      label: 'Trade 3 · ORB',
      instrument: 'NQZ6.CME',
      trade: base.trades[2]!,
      target: CHART,
      back: () => {},
    });
    const other = render(
      <ChartLinkedTrade chart={chart} ids={new Set(['NQZ6.CME'])} target={{ ...CHART, tileId: 'chart-2' }} />,
    );
    const elsewhere = render(<ChartLinkedTrade chart={chart} ids={new Set(['ESZ6.CME'])} target={CHART} />);
    expect(other.container.textContent).toBe('');
    expect(elsewhere.container.textContent).toBe('');
    const here = render(<ChartLinkedTrade chart={chart} ids={new Set(['NQZ6.CME'])} target={CHART} />);
    expect(added).toEqual(['linked-trade']);
    act(() => fireEvent.click(here.getByRole('button', { name: 'Hide the research trade' })));
    expect(removed).toEqual(['linked-trade']);
    expect(here.container.textContent).toBe('');
  });
});

describe('a run is archived or deleted from its page', () => {
  it('archives the run, and deletes it only once confirmed', async () => {
    const { held } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await answerAll(held);
    expect(asked).toEqual([{ name: 'research.archive_run', input: { runId: run.id, archived: true } }]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await settle();
    expect(asked).toHaveLength(1);
    const confirm = screen.getByRole('alertdialog', { name: 'Delete' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await answerAll(held);
    expect(asked[1]).toEqual({ name: 'research.delete_run', input: { runId: run.id } });
  });
});

function Linked() {
  const linked = useLinkedTrade();
  return linked ? (
    <button type="button" onClick={linked.back}>
      {linked.label}
    </button>
  ) : null;
}
