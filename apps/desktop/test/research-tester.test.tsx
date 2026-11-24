import { formatMoney } from '@tessera/ui';
import type * as ChartModule from '@tessera/chart';
import type { Card, CandlesOutput, StudyDetail, StudyList, StudyRun } from '@tessera/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch } from '../src/app/store.ts';
import type { ToolOutput } from '../src/app/tools.ts';
import { researchViewStore } from '../src/areas/research/selection.ts';
import { pct } from '../src/areas/research/model.ts';
import { tradeDayZone, tradesOf, monthBreakdown, sortTrades, numberedTrades } from '../src/areas/research/tester.ts';
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

const chart = vi.hoisted(() => ({ bars: 0, trades: 0, picked: [] as (number | null)[] }));

vi.mock('@tessera/chart', async (original) => {
  const real = await original<typeof ChartModule>();
  class TradesLayer extends real.TradesLayer {
    override setTrades(trades: readonly ChartModule.TradeOverlay[]): void {
      chart.trades = trades.length;
      super.setTrades(trades);
    }
  }
  class TradeLayer extends real.TradeLayer {
    override setTrade(trade: ChartModule.TradeOverlay | null): void {
      chart.picked.push(trade?.open ?? null);
      super.setTrade(trade);
    }
  }
  return {
    ...real,
    TradesLayer,
    TradeLayer,
    createChart: () => ({
      addLayer: () => undefined,
      setLayerVisible: () => undefined,
      setData: (_pane: string, bars: readonly unknown[]) => {
        chart.bars = bars.length;
      },
      setViewport: () => undefined,
      destroy: () => undefined,
    }),
  };
});

vi.mock('../src/analyst/cards/LiveCard.tsx', () => ({
  LiveCard: ({ card }: { card: Card }) => <div>{`Coverage card ${card.id}`}</div>,
}));

const { ResearchPage } = await import('../src/areas/research/ResearchPage.tsx');

const run = recorded.run as unknown as StudyRun;
const detail = recorded.detail as unknown as StudyDetail;
const list = recorded.list as unknown as StudyList;
const base = run.evaluation.cases[0]!;
const zone = tradeDayZone(detail.study);

const ANSWERS = {
  'research.list_studies': (): ToolOutput<'research.list_studies'> => list,
  'research.get_study': (): ToolOutput<'research.get_study'> => detail,
  'research.get_run': (): ToolOutput<'research.get_run'> => run,
  'market.get_candles': (): ToolOutput<'market.get_candles'> => recorded.candles as unknown as CandlesOutput,
  'market.data_coverage': (): ToolOutput<'market.data_coverage'> =>
    recorded.coverage as unknown as ToolOutput<'market.data_coverage'>,
  'market.get_contract_spec': (): ToolOutput<'market.get_contract_spec'> =>
    recorded.spec as unknown as ToolOutput<'market.get_contract_spec'>,
};

beforeEach(() => {
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(researchViewStore, { selected: null, fresh: false });
  chart.bars = 0;
  chart.trades = 0;
  chart.picked = [];
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
    {
      tools: [...Object.keys(SIM.tools), ...Object.keys(ANSWERS)],
    },
  );
  await answerAll(held);
  expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
  return { ...view, held };
}

describe('a Research run reads as a strategy tester', () => {
  it('leads with the verdict in plain words, then the equity curve split and its drawdown', async () => {
    const { container } = await mount();
    const verdict = container.querySelector('.rs-verdict')!;
    expect(verdict.getAttribute('data-verdict')).toBe(run.evaluation.verdict);
    expect(verdict.textContent).toBe(`Rejected${run.evaluation.reason}`);
    const results = container.querySelector('.rs-run')!;
    expect(results.firstElementChild).toBe(verdict);
    expect(screen.getByRole('img', { name: /^Equity curve/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Drawdown, deepest −\$/ })).toBeTruthy();
    const tags = [...container.querySelectorAll('.rs-equity-plot .rs-equity-tag')].map((t) => t.textContent);
    expect(tags).toEqual(['Development', 'Later']);
    expect(container.querySelector('.rs-equity-plot .rs-curve-later')).toBeTruthy();
  });

  it('sets development and later side by side, with quant stats from the trades', async () => {
    await mount();
    for (const [name, split] of [
      ['Development', base.development],
      ['Later', base.later],
    ] as const) {
      const side = within(screen.getByRole('group', { name }));
      const stat = (label: string) => side.getByText(label).nextElementSibling?.textContent;
      expect(stat('Net')).toBe(formatMoney(split.metrics.netPnl, { signed: true }));
      expect(stat('Profit factor')).toBe(split.metrics.profitFactor!.toFixed(2));
      expect(stat('Win rate')).toBe(pct(split.metrics.winRate));
      expect(stat('Max drawdown')).toBe(formatMoney(split.metrics.maxDrawdown));
      expect(stat('Trades')).toBe(String(split.metrics.trades));
    }
    const quant = (label: string) =>
      [...screen.getByText(label).closest('tr')!.querySelectorAll('td')].map((td) => td.textContent);
    const later = tradesOf(base, 'later');
    const mae = later.reduce((s, t) => s + t.mae, 0) / later.length;
    expect(quant('Average MAE')[1]).toBe(formatMoney(mae, { signed: true }));
    expect(quant('Worst trade')[1]).toBe(formatMoney(base.later.metrics.largestLoss, { signed: true }));
    expect(quant('Expectancy')[1]).toMatch(/^−\$\d/);
    for (const v of quant('Sharpe')) expect(v).toMatch(/^-?\d+\.\d\d$/);
  });

  it('breaks the trades down by month', async () => {
    const { container } = await mount();
    const months = monthBreakdown(base, zone);
    const rows = [...container.querySelectorAll('.rs-months tbody tr')];
    expect(rows.map((r) => r.querySelector('th')!.textContent)).toEqual(['Sep 2026', 'Oct 2026']);
    expect(months.reduce((n, m) => n + m.trades, 0)).toBe(base.trades.length);
    expect(rows[1]!.querySelectorAll('td')[2]!.textContent).toBe(formatMoney(months[1]!.net, { signed: true }));
  });

  it('keeps the hypothesis and settings folded away', async () => {
    const { container } = await mount();
    const more = container.querySelector('details.rs-more')!;
    expect(more.hasAttribute('open')).toBe(false);
    expect(more.textContent).toContain(detail.study.hypothesis);
  });

  it('marks every entry and exit on the price chart and lists the trades, sortable', async () => {
    const { held } = await mount();
    fireEvent.click(screen.getByRole('button', { name: `Trades · ${String(base.trades.length)}` }));
    await answerAll(held);
    expect(
      screen.getByRole('img', { name: `Price chart with ${String(base.trades.length)} trades marked` }),
    ).toBeTruthy();
    expect(chart.bars).toBe(recorded.candles.bars.length);
    expect(chart.trades).toBe(base.trades.length);
    expect(chart.picked.at(-1)).toBe(Math.round(base.trades.at(-1)!.entryTime / 1e6));

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
    fireEvent.click(pnl);
    await settle();
    expect(firstNumbers()).toEqual(sortTrades(numberedTrades(base), 'pnl', true).map((r) => r.n));

    const first = within(table).getAllByRole('row')[1]!;
    fireEvent.click(first);
    await answerAll(held);
    const n = Number(first.querySelector('td')!.textContent);
    expect(chart.picked.at(-1)).toBe(Math.round(base.trades[n - 1]!.entryTime / 1e6));
  });
});
