import type { Layout } from '@tessera/protocol';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { read } from '../src/app/store.ts';
import { DEFAULT_VIEW, defaultChartState, layoutsStore, putLayout, setStageView } from '../src/state/layouts.ts';
import { activeChartTarget, attachWorkspace } from '../src/workspace/controller.ts';
import { isTileVisible, panelKind } from '../src/workspace/dock/open.ts';
import type { TabEntry } from '../src/workspace/dock/tabMenu.ts';
import { tileParams } from '../src/workspace/dock/tileSettings.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { chartMenu } from '../src/workspace/tiles/chartMenu.ts';
import '../src/workspace/tiles/index.ts';
import { cleanupsAfterEach } from './support/cleanups.ts';

const LAYOUT = 'beside';

function desk(): DockviewApi {
  const layout: Layout = {
    id: LAYOUT,
    name: 'Day',
    revision: 1,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    trade: null,
    charts: {
      'chart-1': defaultChartState('chart-1', 'NQ', 'NQZ6.CME', '5m', null),
      'chart-2': defaultChartState('chart-2', 'ES', 'ESZ6.CME', '1m', null),
    },
  };
  putLayout(layout);
  setStageView(LAYOUT, { ...DEFAULT_VIEW, v: 3 });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api = createDockview(host, {
    defaultRenderer: 'always',
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  buildDockFromLayout(api, layout);
  cleanups.push(
    attachWorkspace({
      api,
      layoutId: LAYOUT,
      tools: new Set(),
      reload: () => undefined,
      canSaveDock: () => false,
      allowDockSaves: () => undefined,
    }),
  );
  return api;
}

afterEach(() => {
  document.body.innerHTML = '';
});
const cleanups = cleanupsAfterEach();

const item = (entries: TabEntry[], label: string) => {
  const found = entries.find((e) => e.type === 'item' && e.label === label);
  if (found?.type !== 'item') throw new Error(`no ${label} in the chart menu`);
  return found;
};

const panelsOf = (api: DockviewApi, kind: string) => api.panels.filter((p) => panelKind(p) === kind);

describe('a DOM, time & sales and the alerts list from a chart', () => {
  it('are in the chart’s own menu, after its chart items', () => {
    const api = desk();
    const labels = chartMenu(api.getPanel('chart-2')!).map((e) => (e.type === 'sep' ? '—' : e.label));
    expect(labels).toEqual([
      'Change symbol…',
      'Replay a saved day…',
      'Chart type',
      'Trade this chart',
      '—',
      'Open DOM',
      'Open Time & Sales',
      'Show Alerts',
    ]);
  });

  it('open for that chart’s symbol, beside it, and a second click shows the one already open', () => {
    const api = desk();
    const menu = chartMenu(api.getPanel('chart-2')!);
    expect(panelsOf(api, 'dom')).toEqual([]);

    item(menu, 'Open DOM').run();
    expect(activeChartTarget()?.tileId).toBe('chart-2');
    const [dom] = panelsOf(api, 'dom');
    expect(tileParams(dom!.api)).toMatchObject({ instrument: 'ESZ6.CME', link: null });

    item(menu, 'Open Time & Sales').run();
    const [tape] = panelsOf(api, 'tape');
    expect(tileParams(tape!.api)).toMatchObject({ instrument: 'ESZ6.CME', link: null });

    item(menu, 'Show Alerts').run();
    expect(isTileVisible('alerts')).toBe(true);

    item(menu, 'Open DOM').run();
    expect(panelsOf(api, 'dom')).toHaveLength(1);

    item(chartMenu(api.getPanel('chart-1')!), 'Open DOM').run();
    expect(panelsOf(api, 'dom').map((p) => tileParams<{ instrument: string }>(p.api).instrument)).toEqual([
      'ESZ6.CME',
      'NQZ6.CME',
    ]);
  });
});

describe('the chart menu’s Chart type', () => {
  const chartType = (api: DockviewApi, tileId: string) => {
    const sub = chartMenu(api.getPanel(tileId)!).find((e) => e.id === 'chart-type');
    return sub?.type === 'sub' ? sub.items : [];
  };

  it('lists what the toolbar’s Chart type lists: the types and no price, then the footprint and the volume profile', () => {
    const api = desk();
    expect(chartType(api, 'chart-2').map((e) => (e.type === 'sep' ? '—' : e.label))).toEqual([
      'Candles',
      'Bars',
      'Line',
      'No price',
      '—',
      'Footprint',
      'Volume profile',
    ]);
    expect(item(chartType(api, 'chart-2'), 'Footprint')).toMatchObject({ current: false, shortcut: 'alt+shift+f' });
  });

  it('hides the price on that chart alone, and Candles shows it again', async () => {
    const api = desk();
    const chartTypeOf = (tile: string) => read(layoutsStore).layouts[LAYOUT]!.charts[tile]!.chartType;
    item(chartType(api, 'chart-2'), 'No price').run();
    await expect.poll(() => chartTypeOf('chart-2')).toBe('none');
    expect(chartTypeOf('chart-1')).toBeUndefined();
    expect(item(chartType(api, 'chart-2'), 'No price')).toMatchObject({ current: true });
    expect(item(chartType(api, 'chart-1'), 'Candles')).toMatchObject({ current: true });
    item(chartType(api, 'chart-2'), 'Candles').run();
    await expect.poll(() => chartTypeOf('chart-2')).toBe('candles');
  });

  it('turns that chart’s footprint on, and the menu then shows it checked', () => {
    const api = desk();
    item(chartType(api, 'chart-2'), 'Footprint').run();
    const layers = read(layoutsStore).layouts[LAYOUT]!.charts['chart-2']!.layers;
    expect(layers.filter((l) => l.kind === 'footprint').map((l) => l.visible)).toEqual([true]);
    expect(read(layoutsStore).layouts[LAYOUT]!.charts['chart-1']!.layers.some((l) => l.kind === 'footprint')).toBe(
      false,
    );
    expect(item(chartType(api, 'chart-2'), 'Footprint')).toMatchObject({ current: true });
  });
});
