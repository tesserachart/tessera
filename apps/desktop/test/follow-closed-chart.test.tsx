import type { ContractSpecOutput, Layout } from '@tessera/protocol';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createDockview, type DockviewApi, type IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockContext, RuntimeClock } from '../src/app/clock.ts';
import { displaySymbol } from '../src/market/instruments.ts';
import { queryClient } from '../src/app/queries.ts';
import { read, write } from '../src/app/store.ts';
import { defaultChartState, layoutsStore, putLayout } from '../src/state/layouts.ts';
import { closePalette, uiStore } from '../src/state/ui.ts';
import { setActiveChartRef, workspaceStore } from '../src/state/workspace.ts';
import { activateChart, attachWorkspace } from '../src/workspace/controller.ts';
import { successorChart } from '../src/workspace/chartFocus.ts';
import { installActiveChartFollow } from '../src/workspace/dock/activeChart.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { ChartTile } from '../src/workspace/tiles/ChartTile.tsx';
import { DomTile } from '../src/workspace/tiles/DomTile.tsx';
import { TapeTile } from '../src/workspace/tiles/TapeTile.tsx';
import { cleanupsAfterEach } from './support/cleanups.ts';
import { fakeRuntime, type FakeRuntime } from './support/fakeRuntime.ts';
import { seedTools } from './support/runtime.tsx';

vi.mock('../src/chart/ChartView.tsx', () => ({
  ChartView: () => <div className="chart-host" />,
}));

const LAYOUT = 'follow';
const NQ = 'NQZ6.CME';
const ES = 'ESZ6.CME';

function contract(id: string): ContractSpecOutput {
  const root = id.slice(0, 2);
  return {
    instrument: {
      id,
      symbol: id.split('.')[0]!,
      name: root,
      assetClass: 'future',
      exchange: 'CME',
      currency: 'USD',
      root,
      expiry: null,
      isFront: true,
      tradable: true,
    },
    spec: {
      instrument: id,
      assetClass: 'future',
      root,
      tickSize: 0.25,
      tickValue: { amount: 5, currency: 'USD' },
      multiplier: 20,
      currency: 'USD',
      priceDecimals: 2,
      qtyStep: 1,
      minQty: 1,
      sessions: 'cme_equity_index',
      tz: 'America/Chicago',
      expiry: null,
      lastTrade: null,
      rollDate: null,
      microOf: null,
    },
  };
}

function panelApi(id: string) {
  return {
    id,
    setTitle: () => undefined,
    isVisible: true,
    onDidVisibilityChange: () => ({ dispose: () => undefined }),
  };
}

function Desk({ charts }: { charts: readonly string[] }): ReactNode {
  const tile = <P extends Record<string, unknown>>(id: string, params: P) =>
    ({ params, api: panelApi(id) }) as unknown as IDockviewPanelProps<P>;
  return (
    <QueryClientProvider client={queryClient}>
      <ClockContext.Provider value={new RuntimeClock()}>
        {charts.map((id) => (
          <ChartTile key={id} {...tile(id, { layoutId: LAYOUT, tileId: id })} />
        ))}
        <TapeTile {...tile('tape', {})} />
        <DomTile {...tile('dom', {})} />
      </ClockContext.Provider>
    </QueryClientProvider>
  );
}

let rt: FakeRuntime;
let api: DockviewApi;
const cleanups = cleanupsAfterEach();

function desk(charts: Record<string, string>, { here = true } = {}): (open: readonly string[]) => void {
  rt = fakeRuntime({ answers: { 'market.get_contract_spec': (i) => contract(i.instrument) } });
  seedTools(['market.get_contract_spec']);
  write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
  const layout: Layout = {
    id: LAYOUT,
    name: 'Trade',
    revision: 1,
    updatedAt: 0,
    activeChartId: null,
    dock: null,
    trade: null,
    charts: Object.fromEntries(
      Object.entries(charts).map(([id, instrument]) => [id, defaultChartState(id, id, instrument, '5m', null)]),
    ),
  };
  putLayout(layout);
  const host = document.createElement('div');
  document.body.appendChild(host);
  api = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  buildDockFromLayout(api, layout);
  cleanups.push(
    attachWorkspace({
      api,
      layoutId: LAYOUT,
      tools: new Set(),
      reload: () => undefined,
      canSaveDock: () => true,
      allowDockSaves: () => undefined,
    }),
  );
  if (here) cleanups.push(installActiveChartFollow(api, LAYOUT));
  if (here) for (const id of Object.keys(charts)) activateChart(LAYOUT, id);
  const { rerender } = render(<Desk charts={here ? Object.keys(charts) : []} />);
  return (open) => rerender(<Desk charts={open} />);
}

function close(show: (open: readonly string[]) => void, id: string): void {
  act(() => api.getPanel(id)?.api.close());
  const open = api.panels.filter((p) => p.view.contentComponent === 'chart').map((p) => p.id);
  act(() => show(open));
}

const live = (topic: string) =>
  rt.subscriptions
    .filter((s) => s.topic === topic && s.open)
    .flatMap((s) => {
      const p = s.params as { instrument?: string; instruments?: string[] };
      return p.instruments ?? (p.instrument ? [p.instrument] : []);
    });

async function following(instrument: string): Promise<void> {
  const symbol = displaySymbol(instrument);
  await waitFor(() => {
    expect(screen.getByRole('generic', { name: `${symbol} time and sales` })).toBeTruthy();
    expect(screen.getByRole('generic', { name: `${symbol} depth of market` })).toBeTruthy();
    expect(live('market.trades')).toContain(instrument);
    expect(live('market.depth')).toContain(instrument);
  });
  expect(screen.queryByRole('region', { name: 'No chart open' })).toBeNull();
}

beforeEach(() => {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  setActiveChartRef(null);
  closePalette();
});

describe('a panel on “Active chart” whose chart is closed (#505)', () => {
  it('follows the chart focused before it, then keeps its last symbol live once no chart is left', async () => {
    const show = desk({ 'chart-1': NQ, 'chart-2': ES });
    await following(ES);

    close(show, 'chart-2');
    expect(read(workspaceStore).activeChart?.tileId).toBe('chart-1');
    await following(NQ);

    close(show, 'chart-1');
    expect(read(workspaceStore).activeChart).toBeNull();
    await following(NQ);
  });

  it('after a split, closing the followed half moves the panels to the other, and closing that keeps them on it', async () => {
    const show = desk({ 'chart-1': NQ, 'chart-2': ES });
    act(() => activateChart(LAYOUT, 'chart-1'));
    await following(NQ);
    close(show, 'chart-1');
    await following(ES);
    close(show, 'chart-2');
    await following(ES);
  });

  it('says plainly that no chart is open when it never had one, and offers to open one', async () => {
    desk({});
    const notes = await screen.findAllByRole('region', { name: 'No chart open' });
    expect(notes).toHaveLength(2);
    expect(live('market.trades')).toEqual([]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Open a chart' })[0]!);
    expect(read(uiStore).paletteOpen).toBe(true);
  });
});

describe('a panel on “Active chart” before its window hears which chart is active', () => {
  it('never says “No chart open” while the layout holds a chart', async () => {
    desk({ 'chart-1': NQ }, { here: false });
    await screen.findByRole('generic', { name: 'Time and sales' });
    expect(screen.queryByRole('region', { name: 'No chart open' })).toBeNull();
  });
});

describe('the chart that takes over from a closed one', () => {
  it('is the most recently focused chart still open, else the first open one', () => {
    expect(successorChart(['c3', 'c1', 'c2'], ['c1', 'c2', 'c3'], 'c3')).toBe('c1');
    expect(successorChart(['c3'], ['c1', 'c2', 'c3'], 'c3')).toBe('c1');
    expect(successorChart(['c1'], ['c1'], 'c1')).toBeNull();
  });
});
