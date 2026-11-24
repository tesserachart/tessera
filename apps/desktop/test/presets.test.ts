import { read, write } from '../src/app/store.ts';
import { describe, expect, it } from 'vitest';
import { dockTreeOf, layoutsStore, putLayout, viewOfDock } from '../src/state/layouts.ts';
import {
  nextChartId,
  presetFor,
  STORY_PRESETS,
  storyCollapsed,
  storyAnalystWidth,
  storyLayout,
  storyName,
  storyPreset,
} from '../src/workspace/presets.ts';

describe('the layout menu', () => {
  it('reads an arrangement from the number of charts, and names new charts', () => {
    expect([1, 2, 3, 4, 5, 6].map(presetFor)).toEqual(['1', '2h', '3', '4', '6', '6']);
    expect(nextChartId(['chart-1', 'chart-3'])).toBe('chart-2');
  });

  it('keeps the stage view in the dock value, and never compares it as the tree', () => {
    const dock = {
      grid: {},
      panels: {},
      tessera: { v: 5, preset: '4', chartTypes: { 'chart-1': 'line' } },
    };
    expect(viewOfDock(dock)).toEqual({
      v: 5,
      preset: '4',
      syncInterval: false,
      chartTypes: { 'chart-1': 'line' },
      collapsed: {},
      popouts: [],
      closed: [],
      maximised: null,
      story: null,
    });
    expect(viewOfDock({ tessera: { preset: '5', chartTypes: { a: 'renko' } } })).toEqual({
      v: 0,
      preset: null,
      syncInterval: false,
      chartTypes: {},
      collapsed: {},
      popouts: [],
      closed: [],
      maximised: null,
      story: null,
    });
    expect(
      viewOfDock({
        tessera: {
          v: 2,
          collapsed: { left: true, right: 'no', top: true },
          popouts: [{ panelId: 'chart-2', kind: 'chart', bounds: { x: 1, y: 2, width: 3, height: 4 } }, { panelId: 7 }],
        },
      }),
    ).toMatchObject({
      v: 2,
      collapsed: { left: true },
      popouts: [{ panelId: 'chart-2', kind: 'chart', bounds: { x: 1, y: 2, width: 3, height: 4 }, returnTo: null }],
    });
    expect(dockTreeOf(dock)).toEqual({ grid: {}, panels: {} });
    write(layoutsStore, { layouts: {}, chartToolRevision: {}, views: {} });
    const layout = { id: 'default', name: '', revision: 1, updatedAt: 0, activeChartId: null, charts: {}, trade: null };
    putLayout({ ...layout, dock });
    expect(read(layoutsStore).views.default?.preset).toBe('4');
    putLayout({ ...layout, revision: 2, dock: { grid: {}, panels: {} } });
    expect(read(layoutsStore).views.default?.preset).toBe('4');
  });
});

describe('story presets (spec §2.7)', () => {
  it('offers Trade, Scalp, Analyse and Review, each with the analyst open', () => {
    expect(STORY_PRESETS.map((s) => s.label)).toEqual(['Trade', 'Scalp', 'Analyse', 'Review']);
    for (const s of STORY_PRESETS) expect(storyCollapsed(s).right).toBe(false);
  });

  it('makes a new workspace whose dock carries only the story, so it builds itself from it on first load', () => {
    const analyse = storyPreset('analyse');
    const layout = storyLayout(analyse, {
      layoutId: 'ws-1',
      name: 'Analyse',
      nowNs: 1,
      instrument: 'NQZ6',
      setup: null,
    });
    expect(layout.revision).toBe(0);
    expect(Object.values(layout.charts).map((c) => [c.tileId, c.instrument, c.timeframe, c.linkGroup])).toEqual([
      ['chart-1', 'NQZ6', '1h', '1'],
      ['chart-2', 'NQZ6', '5m', '1'],
    ]);
    expect(dockTreeOf(layout.dock)).toEqual({});
    const view = viewOfDock(layout.dock);
    expect(view.story).toBe('analyse');
    expect(view.preset).toBe('2h');
    expect(view.collapsed).toEqual({ right: false, bottom: true });
  });

  it('opens the scalper with a 120px bottom and Trade open over the analyst', () => {
    const scalp = storyPreset('scalp');
    expect(storyCollapsed(scalp)).toEqual({ right: false });
    expect(scalp.bottom).toBe(120);
    expect(scalp.charts).toEqual([{ timeframe: '1m', orderFlow: true }]);
    expect(STORY_PRESETS.filter((s) => !s.trade).map((s) => s.id)).toEqual(['analyse', 'review']);
    expect(scalp.tiles.map((t) => [t.kinds, t.params])).toEqual([
      [['dom'], { link: '1' }],
      [['tape'], { link: '1' }],
    ]);
  });

  it('gives the scalper’s chart the Order flow views', () => {
    const scalp = storyLayout(storyPreset('scalp'), {
      layoutId: 'ws-2',
      name: 'Scalp',
      nowNs: 1,
      instrument: 'ESZ6',
      setup: null,
    });
    const chart = scalp.charts['chart-1']!;
    expect(chart.layers.map((l) => l.kind)).toEqual(['footprint', 'volume_profile', 'big_trades', 'delta']);
    expect(chart).toMatchObject({ timeframe: '1m', linkGroup: '1', instrument: 'ESZ6' });
    const trade = storyLayout(storyPreset('trade'), {
      layoutId: 'ws-3',
      name: 'Trade',
      nowNs: 1,
      instrument: 'ESZ6',
      setup: null,
    });
    expect(trade.charts['chart-1']!.layers.map((l) => l.kind)).not.toContain('footprint');
  });

  it('opens the scalper’s analyst at the edge’s least width in a narrow window, so the chart keeps the rest', () => {
    const scalp = storyPreset('scalp');
    expect(storyAnalystWidth(scalp, 1100)).toBe(320);
    expect(storyAnalystWidth(scalp, 1600)).toBe(scalp.analyst);
    expect(storyAnalystWidth(storyPreset('trade'), 1100)).toBe(storyPreset('trade').analyst);
  });

  it('names a second workspace of a story apart from the first', () => {
    const trade = storyPreset('trade');
    expect(storyName(trade, [])).toBe('Trade');
    expect(storyName(trade, ['Trade', 'Trade 2'])).toBe('Trade 3');
  });

  it('reads a view without a story, or with one this build does not know, as Trade', () => {
    expect(viewOfDock({ tessera: { v: 2 } }).story).toBeNull();
    expect(viewOfDock({ tessera: { v: 2, story: 'swing' } }).story).toBeNull();
    expect(storyPreset(null).id).toBe('trade');
  });
});
