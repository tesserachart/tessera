import type { Layout } from '@tessera/protocol';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultChartState } from '../src/state/layouts.ts';
import { keepsOwnDock } from '../src/workspace/controller.ts';
import { buildDockFromLayout, dockShape } from '../src/workspace/layouts.ts';
import '../src/workspace/tiles/index.ts';

function dock(): DockviewApi {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
}

const layout = (charts: string[], activeChartId: string | null): Layout => ({
  id: 'default',
  name: 'Trade',
  revision: 1,
  updatedAt: 0,
  activeChartId,
  dock: null,
  trade: null,
  charts: Object.fromEntries(charts.map((id) => [id, defaultChartState(id, id, 'QQQ', '5m', null)])),
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a fresh desk (spec §2.2)', () => {
  it('opens Trade and the analyst as tabs of the right edge, Positions and Accounts at the bottom', () => {
    const api = dock();
    buildDockFromLayout(api, layout(['chart-1', 'chart-2'], 'chart-1'));
    const tree = api.toJSON();
    expect(tree.edgeGroups?.right?.group).toMatchObject({ views: ['trade', 'analyst'], activeView: 'trade' });
    expect(tree.edgeGroups?.bottom?.group).toMatchObject({ views: ['positions', 'accounts'], activeView: 'positions' });
    expect(Object.keys(tree.edgeGroups ?? {}).sort()).toEqual(['bottom', 'left', 'right']);
    for (const p of Object.values(tree.panels).filter((x) => x.contentComponent === 'chart'))
      expect(p.params).toEqual({ layoutId: 'default', tileId: p.id });
  });
});

describe('a save refused for a newer revision', () => {
  const tree = (views: string[]) => ({
    grid: {
      root: { type: 'leaf', data: { id: '1', views, activeView: views[0] }, size: 900 },
      width: 1600,
      height: 900,
    },
    panels: Object.fromEntries(views.map((id) => [id, { id, contentComponent: 'chart' }])),
  });
  const stored = (views: string[], charts: string[], over: Partial<Layout> = {}): Layout => ({
    ...layout(charts, charts[0] ?? null),
    revision: 3,
    dock: { ...tree(views), tessera: { v: 2 } } as never,
    ...over,
  });
  const ids = new Set(['chart-1', 'chart-2']);

  it('runs again on it, keeping the dock, when the revision changed neither the dock nor which charts there are', () => {
    const base = dockShape(tree(['chart-1', 'chart-2']));
    const sized = stored(['chart-1', 'chart-2'], ['chart-1', 'chart-2']);
    (sized.dock as { grid: { width: number } }).grid.width = 1100;
    expect(keepsOwnDock(sized, base, ids)).toBe(true);
  });

  it('reloads when another window changed the dock, a chart came or went, or nothing is known to be in step', () => {
    const base = dockShape(tree(['chart-1', 'chart-2']));
    expect(keepsOwnDock(stored(['chart-2', 'chart-1'], ['chart-1', 'chart-2']), base, ids)).toBe(false);
    expect(keepsOwnDock(stored(['chart-1', 'chart-2'], ['chart-1', 'chart-2', 'chart-3']), base, ids)).toBe(false);
    expect(keepsOwnDock(stored(['chart-1', 'chart-2'], ['chart-1']), base, ids)).toBe(false);
    expect(keepsOwnDock(stored(['chart-1', 'chart-2'], ['chart-1', 'chart-2']), undefined, ids)).toBe(false);
    expect(keepsOwnDock(stored([], ['chart-1', 'chart-2'], { dock: null }), base, ids)).toBe(false);
  });
});
