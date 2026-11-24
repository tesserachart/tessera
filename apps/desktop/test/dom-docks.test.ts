import type { Layout } from '@tessera/protocol';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, defaultChartState, putLayout, setStageView } from '../src/state/layouts.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import { openBesideChart } from '../src/workspace/chartPanels.ts';
import { attachWorkspace } from '../src/workspace/controller.ts';
import { openTile } from '../src/workspace/dock/open.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import '../src/workspace/tiles/index.ts';
import { cleanupsAfterEach } from './support/cleanups.ts';

const LAYOUT = 'day';

function dayDesk(width: number): DockviewApi {
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
  api.layout(width, 900);
  setActiveChartRef({ layoutId: LAYOUT, tileId: 'chart-1', source: null });
  return api;
}

afterEach(() => {
  document.body.innerHTML = '';
});
const cleanups = cleanupsAfterEach();

function row(api: DockviewApi): string[] {
  const root = api.toJSON().grid.root as { data: { type: string; data: { id: string; views: string[] } }[] };
  return root.data.filter((n) => n.type === 'leaf').map((n) => n.data.views.join('+'));
}

const width = (api: DockviewApi, id: string) => api.getPanel(id)!.group.api.width;

describe('a DOM opened on the Day desk (UX pass U-L2)', () => {
  it('docks right of the chart it shows and takes its width from both charts alike', () => {
    const api = dayDesk(1802);
    expect([width(api, 'chart-1'), width(api, 'chart-2')]).toEqual([729, 729]);
    const id = openTile('dom', { params: { instrument: 'NQZ6.CME', link: null } });
    expect(row(api)).toEqual(['chart-1', id, 'chart-2']);
    expect(width(api, id!)).toBe(264);
    expect(width(api, 'chart-1')).toBe(597);
    expect(width(api, 'chart-2')).toBe(597);
  });

  it('docks beside the chart showing its contract, not the active one', () => {
    const api = dayDesk(1802);
    const id = openTile('dom', { params: { instrument: 'ESZ6.CME', link: null } });
    expect(row(api)).toEqual(['chart-1', 'chart-2', id]);
    expect(width(api, 'chart-1')).toBe(597);
    expect(width(api, 'chart-2')).toBe(597);
  });

  it('opened from the ES chart’s own menu while NQ is active, docks right of ES', () => {
    const api = dayDesk(1802);
    const id = openBesideChart('dom', { layoutId: LAYOUT, tileId: 'chart-2' });
    expect(row(api)).toEqual(['chart-1', 'chart-2', id]);
    expect(width(api, id!)).toBe(264);
    expect(width(api, 'chart-1')).toBe(597);
    expect(width(api, 'chart-2')).toBe(597);
  });

  it('takes the width from the wider chart when one is wider', () => {
    const api = dayDesk(1802);
    api.getPanel('chart-1')!.group.api.setSize({ width: 958 });
    expect(width(api, 'chart-2')).toBe(500);
    const id = openTile('dom', { params: { instrument: 'ESZ6.CME', link: null } });
    expect(row(api)).toEqual(['chart-1', 'chart-2', id]);
    expect(width(api, 'chart-1')).toBe(694);
    expect(width(api, 'chart-2')).toBe(500);
  });
});
