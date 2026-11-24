import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/app/ErrorBoundary.tsx';
import {
  adoptUnknownTiles,
  registeredTileKinds,
  registerTile,
  resolveTileKind,
  restoreUnknownTiles,
  singletonPanelId,
  tileComponents,
  tileDefinition,
  UNKNOWN_TILE,
} from '../src/workspace/tiles/index.ts';
import { storyPreset } from '../src/workspace/presets.ts';

describe('tile registry', () => {
  it('registers every tile kind from its own file, plus the unknown-kind placeholder', () => {
    expect(registeredTileKinds()).toEqual([
      'accounts',
      'alerts',
      'analyst',
      'chart',
      'copy',
      'dom',
      'indicators',
      'journal',
      'positions',
      'tape',
      'trade',
      UNKNOWN_TILE,
    ]);
    expect(Object.keys(tileComponents()).sort()).toEqual([...registeredTileKinds(), 'time_and_sales'].sort());
    expect(resolveTileKind('time_and_sales')).toBe('tape');
    expect(tileDefinition('markets')).toBeNull();
    expect(resolveTileKind('watchlist')).toBe('watchlist');
    expect(tileDefinition('trade')).toMatchObject({ home: 'right', singleton: true, order: 0 });
    expect(tileDefinition('analyst')).toMatchObject({ home: 'right', singleton: true, order: 1 });
    expect(tileDefinition('positions')).toMatchObject({ home: 'bottom', singleton: true, order: 0 });
    expect(tileDefinition('accounts')).toMatchObject({ home: 'bottom', singleton: true, order: 1 });
    expect(tileDefinition('alerts')).toMatchObject({ home: 'bottom', singleton: true, order: 2 });
    expect(tileDefinition('chart')).toMatchObject({ home: 'centre', singleton: false, linkable: true });
    expect(singletonPanelId('positions')).toBe('positions');
    expect(singletonPanelId('analyst')).toBe('analyst');
    expect(singletonPanelId('trade')).toBe('trade');
    expect(singletonPanelId('chart')).toBeNull();
  });

  it('loads tiles of unknown kinds as placeholders and saves them back unchanged', () => {
    const stored = {
      grid: { root: {} },
      panels: {
        w: { id: 'w', contentComponent: 'positions', title: 'Positions' },
        d: { id: 'd', contentComponent: 'order_heat', title: 'Order heat', params: { instrument: 'NQ', levels: 10 } },
      },
      activeGroup: 'g1',
    };
    const { dock, unknown } = adoptUnknownTiles(stored);
    expect(unknown).toEqual(['order_heat']);
    const panels = (dock as typeof stored).panels as Record<string, { contentComponent: string; params?: unknown }>;
    expect(panels.d).toMatchObject({
      contentComponent: UNKNOWN_TILE,
      params: { originalComponent: 'order_heat', originalParams: { instrument: 'NQ', levels: 10 } },
    });
    expect(panels.w!.contentComponent).toBe('positions');
    expect(restoreUnknownTiles(dock)).toEqual(stored);
    expect(adoptUnknownTiles(null)).toEqual({ dock: null, unknown: [] });
  });

  it('opens an old desk without its retired tiles, and its Time & Sales as the tape', () => {
    const leaf = (id: string, views: string[]) => ({
      type: 'leaf',
      data: { id, views, activeView: views[0] },
      size: 300,
    });
    const stored = {
      grid: {
        root: {
          type: 'branch',
          data: [leaf('g1', ['chart-1', 'markets']), leaf('g2', ['watchlist']), leaf('g3', ['ts', 'research'])],
          size: 900,
        },
        width: 1600,
        height: 900,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'chart-1': { id: 'chart-1', contentComponent: 'chart', title: 'Chart 1' },
        markets: { id: 'markets', contentComponent: 'markets', title: 'Markets' },
        watchlist: { id: 'watchlist', contentComponent: 'watchlist', title: 'Watchlist' },
        ts: { id: 'ts', contentComponent: 'time_and_sales', title: 'T&S', params: { instrument: 'NQZ6.CME' } },
        research: { id: 'research', contentComponent: 'research', title: 'Research' },
      },
      activeGroup: 'g1',
    };
    const { dock, unknown } = adoptUnknownTiles(stored);
    expect(unknown).toEqual([]);
    const d = dock as typeof stored;
    expect(Object.keys(d.panels)).toEqual(['chart-1', 'ts']);
    expect(d.panels.ts).toEqual({ ...stored.panels.ts, contentComponent: 'tape' });
    const leaves = d.grid.root.data.map((l) => l.data.views);
    expect(leaves).toEqual([['chart-1'], ['ts']]);
    expect(JSON.stringify(dock)).not.toMatch(/markets|watchlist|research|time_and_sales|unknown/);
  });

  it('opens the Review story with tiles that exist, the research page not among them', () => {
    const review = storyPreset('review');
    const kinds = review.tiles.flatMap((t) => t.kinds);
    expect(kinds).not.toContain('research');
    for (const k of kinds) expect(tileDefinition(k), k).not.toBeNull();
  });

  it('a later tile slots in with its kind, noun, icon and component alone, and stops being a placeholder', () => {
    registerTile({ kind: 'test-ladder', title: 'Ladder', icon: 'dom', component: () => null });
    expect(tileDefinition('test-ladder')).toMatchObject({
      home: 'centre',
      singleton: false,
      icon: 'dom',
      linkable: false,
      order: 0,
    });
    expect(singletonPanelId('test-ladder')).toBeNull();
    const stored = { grid: {}, panels: { l: { id: 'l', contentComponent: 'test-ladder' } } };
    expect(adoptUnknownTiles(stored).unknown).toEqual([]);
    expect(tileComponents()['test-ladder']).toBeTypeOf('function');
  });
});

describe('ErrorBoundary', () => {
  it('contains a failing part and remounts it on reload', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    function Fragile() {
      if (fail) throw new Error('boom');
      return <span>alive</span>;
    }
    function Host() {
      const [n] = useState(0);
      return (
        <div>
          <span>sibling {n}</span>
          <ErrorBoundary name="Chart">
            <Fragile />
          </ErrorBoundary>
        </div>
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert').textContent).toContain('Chart stopped working.');
    expect(screen.getByText('sibling 0')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Reload chart' }));
    expect(screen.getByText('alive')).toBeTruthy();
    error.mockRestore();
  });
});
