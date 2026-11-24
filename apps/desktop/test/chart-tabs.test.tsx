import type * as LevelSettingsModule from '../src/chart/levelSettings.ts';
import type * as ChartModule from '@tessera/chart';
import type { ContractSpec, Instrument, Layout } from '@tessera/protocol';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  createDockview,
  type DockviewApi,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rustNumber } from './support/rust.ts';
import { read, patch, write } from '../src/app/store.ts';
import { closeSymbolSearch, uiStore } from '../src/state/ui.ts';
import { putLayout, setStageView, layoutsStore } from '../src/state/layouts.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import type { ChartTileParams } from '../src/workspace/layouts.ts';
import { cleanupsAfterEach } from './support/cleanups.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const suspended: boolean[] = [];
vi.mock('@tessera/chart', async (original) => {
  const real = await original<typeof ChartModule>();
  return {
    ...real,
    createChart: () => ({
      addLayer: () => undefined,
      removeLayer: () => undefined,
      getLayer: () => null,
      layers: () => [],
      on: () => () => undefined,
      setLayerVisible: () => undefined,
      setOptions: () => undefined,
      setSuspended: (on: boolean) => suspended.push(on),
      getSeries: () => null,
      getViewport: () => ({ asked: null }),
      destroy: () => undefined,
    }),
  };
});
vi.mock('../src/chart/feed.ts', () => ({
  ChartFeed: class {
    load = (): void => undefined;
    dispose = (): void => undefined;
  },
}));
vi.mock('../src/market/flow/hub.ts', () => ({ flowHub: () => null }));
vi.mock('../src/chart/useLevelSources.ts', async () => {
  const { defsOf, sourceDefs } = await vi.importActual<typeof LevelSettingsModule>('../src/chart/levelSettings.ts');
  const sources = sourceDefs([]);
  return { useLevelSources: () => ({ sources, defs: defsOf(sources) }) };
});

const { ChartView } = await import('../src/chart/ChartView.tsx');
const { ClockContext } = await import('../src/app/clock.ts');
const { defaultChartState, DEFAULT_VIEW } = await import('../src/state/layouts.ts');
const { templatesStore } = await import('../src/chart/templates/store.ts');
const { attachWorkspace, applyLayoutPreset, activeChartTarget } = await import('../src/workspace/controller.ts');
const { addChart, chartsFull, newChartTab, openChartTab, showInstrument, splitChart } =
  await import('../src/workspace/addChart.ts');
const { PanelHeader } = await import('../src/workspace/dock/header/PanelHeader.tsx');
const { tabEntries } = await import('../src/workspace/dock/tabMenu.ts');
const { deskToasts } = await import('../src/workspace/dock/deskToasts.ts');
const { registerBuiltinCommands } = await import('../src/commands/builtin.ts');
const { CommandRegistry } = await import('../src/commands/registry.ts');
const { chartPanes, MAX_CHART_PANES, MAX_CHARTS, placeNewChart, splitSide } =
  await import('../src/workspace/deskPlace.ts');
const { buildDockFromLayout } = await import('../src/workspace/layouts.ts');
const { ChartTab } = await import('../src/workspace/tiles/ChartTab.tsx');
const { deskRequestHandlers } = await import('../src/workspace/deskRequests.ts');
await import('../src/workspace/tiles/index.ts');

const LAYOUT = 'tabs';

function dock(): DockviewApi {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
}

function desk(charts: string[], active: string | null = charts[0] ?? null, popout = false) {
  write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
  const layout: Layout = {
    id: LAYOUT,
    name: 'Trade',
    revision: 1,
    updatedAt: 0,
    activeChartId: active,
    dock: null,
    trade: null,
    charts: Object.fromEntries(charts.map((id) => [id, defaultChartState(id, id, 'NQZ6.CME', '5m', null)])),
  };
  putLayout(layout);
  setStageView(LAYOUT, { ...DEFAULT_VIEW, v: 3, preset: '2h' });
  setActiveChartRef(active ? { layoutId: LAYOUT, tileId: active, source: null } : null);
  const api = dock();
  buildDockFromLayout(api, layout);
  const detach = attachWorkspace({
    api,
    layoutId: LAYOUT,
    tools: new Set(),
    reload: () => undefined,
    canSaveDock: () => true,
    allowDockSaves: () => undefined,
    popout,
  });
  cleanups.push(detach);
  return api;
}

function stack(api: DockviewApi, ids: string[]): void {
  const into = api.getPanel(ids[0]!)!.group;
  for (const id of ids.slice(1)) api.getPanel(id)!.api.moveTo({ group: into, position: 'center' });
}

const panes = (api: DockviewApi) => chartPanes(api).map((g) => g.panels.map((p) => p.id));

type GridNode = { type: 'leaf' | 'branch'; data: unknown };
const grid = (api: DockviewApi): string[][] => {
  const walk = (n: GridNode): string[][] =>
    n.type === 'leaf' ? [(n.data as { views: string[] }).views] : (n.data as GridNode[]).flatMap(walk);
  return walk(api.toJSON().grid.root);
};
const groupOf = (api: DockviewApi, id: string) => api.getPanel(id)!.group;
const charts = () => Object.keys(read(layoutsStore).layouts[LAYOUT]!.charts);

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  suspended.length = 0;
  closeSymbolSearch();
  patch(uiStore, { recentSymbols: [] });
  setActiveChartRef(null);
  patch(templatesStore, { templates: [], loaded: false });
  deskToasts.clear();
});
const cleanups = cleanupsAfterEach();

describe('a new chart tab (+, ⌘T)', () => {
  it('opens the symbol search for a tab in the pane, and a pick adds it there, shown and active', async () => {
    const api = desk(['chart-1', 'chart-2']);
    patch(templatesStore, {
      templates: [{ id: 'clean', name: 'Clean', layers: [{ kind: 'ema', params: {}, visible: true }] }],
      defaultId: 'clean',
      loaded: true,
    });
    newChartTab('chart-2');
    expect(activeChartTarget()?.tileId).toBe('chart-2');
    expect(read(uiStore)).toMatchObject({ symbolSearch: '', symbolSearchFor: 'tab' });
    closeSymbolSearch();

    const id = await openChartTab('ESZ6.CME');
    expect(id).toBe('chart-3');
    expect(panes(api)).toEqual([['chart-1'], ['chart-2', 'chart-3']]);
    expect(groupOf(api, 'chart-2').activePanel?.id).toBe('chart-3');
    expect(activeChartTarget()?.tileId).toBe('chart-3');
    const chart = read(layoutsStore).layouts[LAYOUT]!.charts['chart-3']!;
    expect(chart).toMatchObject({ instrument: 'ESZ6.CME', timeframe: '5m', linkGroup: null });
    expect(chart.layers.map((l) => l.kind)).toEqual(['ema']);
    expect(read(uiStore).recentSymbols[0]).toBe('ESZ6.CME');
  });

  it('opens the symbol search on the desk while its only chart is popped out, and a pick adds a tab there', async () => {
    const api = desk(['chart-1']);
    setStageView(LAYOUT, {
      popouts: [{ panelId: 'chart-1', kind: 'chart', bounds: null, monitor: null, returnTo: null }],
    });
    api.getPanel('chart-1')!.api.close();
    newChartTab();
    expect(read(uiStore)).toMatchObject({ symbolSearch: '', symbolSearchFor: 'tab', symbolSearchAt: 'desk' });
    closeSymbolSearch();

    expect(await openChartTab('ESZ6.CME')).toBe('chart-2');
    expect(panes(api)).toEqual([['chart-2']]);
    expect(charts().sort()).toEqual(['chart-1', 'chart-2']);
  });

  it('a pick on an empty desk opens its first chart', async () => {
    const api = desk([]);
    expect(await showInstrument('ESZ6.CME')).toBe(true);
    expect(charts()).toEqual(['chart-1']);
    expect(panes(api)).toEqual([['chart-1']]);
    expect(activeChartTarget()?.tileId).toBe('chart-1');
    expect(read(layoutsStore).layouts[LAYOUT]!.charts['chart-1']?.instrument).toBe('ESZ6.CME');
  });

  it('on the same symbol stays in the link group of the chart beside it', async () => {
    const api = desk(['chart-1']);
    await addChart({ placement: 'tab', activate: true });
    expect(panes(api)).toEqual([['chart-1', 'chart-2']]);
    expect(read(layoutsStore).layouts[LAYOUT]!.charts['chart-2']).toMatchObject({
      instrument: 'NQZ6.CME',
      linkGroup: '1',
    });
  });
});

describe('adding a chart never rearranges what the user arranged', () => {
  it('splits only the active chart’s pane, and every stack of tabs stays stacked', async () => {
    const api = desk(['chart-1', 'chart-2', 'chart-3'], 'chart-3');
    stack(api, ['chart-1', 'chart-2']);
    expect(panes(api)).toEqual([['chart-1', 'chart-2'], ['chart-3']]);
    const before = groupOf(api, 'chart-1');

    const id = await addChart({ instrument: 'ESZ6.CME', placement: 'split', activate: true });
    expect(id).toBe('chart-4');
    expect(panes(api)).toEqual([['chart-1', 'chart-2'], ['chart-3'], ['chart-4']]);
    expect(groupOf(api, 'chart-1')).toBe(before);
    expect(grid(api)).toEqual([['chart-1', 'chart-2'], ['chart-3'], ['chart-4']]);
    expect(read(layoutsStore).views[LAYOUT]?.preset).toBeNull();
  });

  it('splits a wide pane to its right and a tall one below', () => {
    expect(splitSide(1200, 800)).toBe('right');
    expect(splitSide(600, 900)).toBe('below');
  });

  it('from the analyst, opens a tab or a split beside the chart it names, leaving the active chart', async () => {
    const api = desk(['chart-1', 'chart-2'], 'chart-1');
    const open = deskRequestHandlers(() => 0).open!;
    open('chart', { instrument: 'ESZ6.CME', link: null, placement: 'tab', beside: 'chart-2' });
    await Promise.resolve();
    expect(panes(api)).toEqual([['chart-1'], ['chart-2', 'chart-3']]);
    expect(activeChartTarget()?.tileId).toBe('chart-1');
    open('chart', { instrument: null, link: null });
    await Promise.resolve();
    expect(grid(api)).toEqual([['chart-1'], ['chart-4'], ['chart-2', 'chart-3']]);
    expect(activeChartTarget()?.tileId).toBe('chart-1');
  });

  it('keeps stacks stacked when the layout menu arranges, and closes no chart', () => {
    const api = desk(['chart-1', 'chart-2', 'chart-3', 'chart-4'], 'chart-1');
    stack(api, ['chart-1', 'chart-2']);
    expect(applyLayoutPreset('3')).toBe(true);
    expect(panes(api)).toEqual([['chart-1', 'chart-2'], ['chart-3'], ['chart-4']]);
    applyLayoutPreset('1');
    expect(panes(api)).toHaveLength(1);
    expect(panes(api)[0]!.toSorted()).toEqual(['chart-1', 'chart-2', 'chart-3', 'chart-4']);
    expect(charts()).toHaveLength(4);
    applyLayoutPreset('4');
    expect(panes(api)).toHaveLength(4);
    expect(charts()).toHaveLength(7);
  });
});

describe('the caps', () => {
  it('splits at most six panes, then opens a tab; holds at most 24 charts', () => {
    expect(MAX_CHART_PANES).toBe(6);
    expect(MAX_CHARTS).toBe(24);
    expect(placeNewChart('split', 5, 5)).toBe('split');
    expect(placeNewChart('split', 6, 6)).toBe('tab');
    expect(placeNewChart('tab', 23, 6)).toBe('tab');
    expect(placeNewChart('tab', 24, 6)).toBeNull();
    expect(placeNewChart('split', 24, 1)).toBeNull();
  });

  it('holds as many charts as tessera-runtime lets the analyst add', () => {
    expect(MAX_CHARTS).toBe(rustNumber('tessera-runtime/src/layout/dock.rs', 'MAX_CHARTS'));
  });

  it('turns a seventh pane into a tab of the active chart’s pane', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `chart-${String(i + 1)}`);
    const api = desk(ids, 'chart-4');
    expect(chartPanes(api)).toHaveLength(6);
    await addChart({ instrument: 'ESZ6.CME', placement: 'split', activate: true });
    expect(chartPanes(api)).toHaveLength(6);
    expect(groupOf(api, 'chart-7')).toBe(groupOf(api, 'chart-4'));
  });

  it('adds nothing to a full workspace, and ⌘T says so instead of opening the search', async () => {
    const ids = Array.from({ length: MAX_CHARTS }, (_, i) => `chart-${String(i + 1)}`);
    const api = desk(ids);
    expect(chartsFull()).toBe(true);
    expect(await addChart({ placement: 'tab', activate: true })).toBeNull();
    expect(api.panels.filter((p) => p.api.component === 'chart')).toHaveLength(MAX_CHARTS);
    newChartTab();
    expect(read(uiStore).symbolSearch).toBeNull();
  });
});

describe('a chart in a background tab', () => {
  beforeEach(() => {
    fakeRuntime();
  });
  const view = (visible: boolean) => (
    <ClockContext.Provider value={{ now: () => 0 } as never}>
      <ChartView
        layoutId="l1"
        tileId="c1"
        instrument="QQQ"
        tf="5m"
        spec={null}
        layers={[]}
        levels={[]}
        annotations={[]}
        reportViewport={false}
        precision={2}
        visible={visible}
      />
    </ClockContext.Provider>
  );

  it('stops drawing while hidden and draws again when shown, on the same chart (no remount)', () => {
    const { rerender } = render(view(false));
    expect(suspended).toEqual([true]);
    rerender(view(true));
    expect(suspended).toEqual([true, false]);
    rerender(view(false));
    expect(suspended).toEqual([true, false, true]);
  });
});

describe('a chart tab', () => {
  it('names the contract the root resolves to, as the DOM and T&S do', async () => {
    putLayout({
      id: 'tab-name',
      name: 'Trade',
      revision: 1,
      updatedAt: 0,
      activeChartId: 'chart-1',
      dock: null,
      trade: null,
      charts: { 'chart-1': defaultChartState('chart-1', 'chart-1', 'ES.CME', '1m', null) },
    });
    const esz6: ContractSpec = {
      instrument: 'ESZ6.CME',
      assetClass: 'future',
      root: 'ES',
      tickSize: 0.25,
      tickValue: { amount: 12.5, currency: 'USD' },
      multiplier: 50,
      currency: 'USD',
      priceDecimals: 2,
      qtyStep: 1,
      minQty: 1,
      sessions: 'cme_equity_index',
      tz: 'America/Chicago',
      expiry: '2026-12-18',
      lastTrade: null,
      rollDate: null,
      microOf: null,
    };
    const instrument: Instrument = {
      id: 'ESZ6.CME',
      symbol: 'ESZ6',
      name: 'E-mini S&P 500 Dec 2026',
      assetClass: 'future',
      exchange: 'CME',
      currency: 'USD',
      root: 'ES',
      expiry: '2026-12-18',
      isFront: true,
      tradable: true,
    };
    const { client } = answeringClient({ 'market.get_contract_spec': () => ({ instrument, spec: esz6 }) });
    setTestServices(client);
    seedTools(['market.get_contract_spec']);
    const header = {
      params: { layoutId: 'tab-name', tileId: 'chart-1' },
    } as IDockviewPanelHeaderProps<ChartTileParams>;
    render(
      <TestRuntime client={client}>
        <ChartTab {...header} />
      </TestRuntime>,
    );
    expect(await screen.findByRole('button', { name: 'ES Z6: change symbol' })).toBeTruthy();
    expect(screen.getByTitle('ES Z6 · 1m')).toBeTruthy();
  });

  it('names the tick, range or volume bars the chart draws instead of its timeframe', async () => {
    putLayout({
      id: 'tab-bars',
      name: 'Trade',
      revision: 1,
      updatedAt: 0,
      activeChartId: 'chart-1',
      dock: null,
      trade: null,
      charts: {
        'chart-1': {
          ...defaultChartState('chart-1', 'chart-1', 'NQZ6.CME', '5m', null),
          printBars: { kind: 'tick', size: 500 },
        },
      },
    });
    const { client } = answeringClient({});
    setTestServices(client);
    const header = {
      params: { layoutId: 'tab-bars', tileId: 'chart-1' },
    } as IDockviewPanelHeaderProps<ChartTileParams>;
    render(
      <TestRuntime client={client}>
        <ChartTab {...header} />
      </TestRuntime>,
    );
    expect(await screen.findByTitle('NQ Z6 · 500T')).toBeTruthy();
  });
});

describe('splitting a chart, from any desk with a chart on it', () => {
  const header = (api: DockviewApi, id: string) => {
    const group = groupOf(api, id);
    const props = { containerApi: api, group, activePanel: group.activePanel, panels: group.panels };
    return render(<PanelHeader {...(props as unknown as IDockviewHeaderActionsProps)} />);
  };
  const ids = (entries: ReturnType<typeof tabEntries>) => entries.map((e) => e.id);

  it('shows Split chart on every pane of the desk, and a click opens a chart beside that pane', async () => {
    const api = desk(['chart-1', 'chart-2', 'chart-3'], 'chart-3');
    stack(api, ['chart-1', 'chart-2']);
    header(api, 'chart-2');
    fireEvent.click(screen.getByRole('button', { name: 'Split chart' }));
    await waitFor(() => expect(charts()).toEqual(['chart-1', 'chart-2', 'chart-3', 'chart-4']));
    expect(grid(api)).toEqual([['chart-1', 'chart-2'], ['chart-4'], ['chart-3']]);
    expect(activeChartTarget()?.tileId).toBe('chart-4');
    expect(read(layoutsStore).layouts[LAYOUT]!.charts['chart-4']).toMatchObject({
      instrument: 'NQZ6.CME',
      timeframe: '5m',
    });
  });

  it('offers it in the tab’s menu, and in More once the header is too narrow for the button', () => {
    const api = desk(['chart-1']);
    const panel = api.getPanel('chart-1')!;
    expect(ids(tabEntries(api, panel))).toContain('split');
    expect(ids(tabEntries(api, panel, 'header'))).not.toContain('split');
    expect(ids(tabEntries(api, panel, 'header', new Set(['split'])))).toContain('split');
  });

  it('finds it in ⌘K by what a trader would type, with ⌘\\ to do it from the keyboard', () => {
    const r = new CommandRegistry();
    const off = registerBuiltinCommands(r, { focusComposer: () => undefined });
    expect(r.get('chart.split')).toMatchObject({ title: 'Split chart', shortcut: 'mod+\\' });
    expect(r.get('chart.split')?.keywords).toEqual(expect.arrayContaining(['multi chart', 'side by side']));
    off();
  });

  it('leaves a pop-out window without it, since a chart is added on the desk', () => {
    const api = desk(['chart-1'], 'chart-1', true);
    header(api, 'chart-1');
    expect(screen.queryByRole('button', { name: 'Split chart' })).toBeNull();
    expect(ids(tabEntries(api, api.getPanel('chart-1')!))).not.toContain('split');
  });

  it('says a full workspace is full instead of adding a chart', async () => {
    const all = Array.from({ length: MAX_CHARTS }, (_, i) => `chart-${String(i + 1)}`);
    const api = desk(all);
    expect(await splitChart(groupOf(api, 'chart-1'))).toBeNull();
    expect(charts()).toHaveLength(MAX_CHARTS);
    const open = deskToasts.getSnapshot().filter((t) => t.state === 'open');
    expect(open.map((t) => t.title)).toEqual(['24 charts is the most a workspace holds']);
  });
});
