import type { Layout } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { copyName, newWorkspaceId, nextWorkspaceName, preferredInstrument } from '../src/frame/workspaces.ts';
import { newWorkspaceLayout } from '../src/workspace/layouts.ts';
import { setTileParams, tileParams } from '../src/workspace/dock/tileSettings.ts';
import { chartMenu } from '../src/workspace/tiles/chartMenu.ts';
import { tradeChartOf } from '../src/workspace/tiles/tradeTarget.ts';

/**
 * dockview merges an update into the panel's params and drops keys set to undefined; the api only remembers the last
 * params handed to `updateParameters`.
 */
function fakePanel(id: string, params: Record<string, unknown>) {
  const panel: { id: string; params: Record<string, unknown> } = { id, params: { ...params } };
  let last: Record<string, unknown> | undefined;
  const api = {
    id,
    group: { panels: [panel] },
    getParameters: () => last,
    updateParameters: (next: Record<string, unknown>) => {
      last = next;
      panel.params = Object.fromEntries(
        Object.entries({ ...panel.params, ...next }).filter(([k]) => !(k in next) || next[k] !== undefined),
      );
    },
  };
  return { panel, api: api as never as Parameters<typeof setTileParams>[0] & Parameters<typeof tileParams>[0] };
}

describe('the frame’s workspace menu', () => {
  it('names a new workspace after the ones there are, and a duplicate after its source', () => {
    expect(nextWorkspaceName(['Trade'])).toBe('Workspace 2');
    expect(nextWorkspaceName(['Trade', 'Workspace 2'])).toBe('Workspace 3');
    expect(nextWorkspaceName(['Workspace 2', 'Workspace 3'])).toBe('Workspace 4');
    expect(copyName('NQ plan', ['NQ plan'])).toBe('NQ plan copy');
    expect(copyName('NQ plan', ['NQ plan', 'NQ plan copy'])).toBe('NQ plan copy 2');
    expect(newWorkspaceId(1_760_000_000_000)).toMatch(/^ws-[0-9a-z]+$/);
  });

  it('starts a new workspace on the chosen or last instrument, and on none when nothing was charted', () => {
    const layouts: Record<string, Layout> = {
      old: { ...newWorkspaceLayout('old', 1, { instrument: 'NQ' }), updatedAt: 1 },
      recent: { ...newWorkspaceLayout('recent', 2, { instrument: 'ES' }), updatedAt: 2 },
    };
    const active = { layoutId: 'recent', tileId: 'chart-1' };
    expect(preferredInstrument({ chosen: 'MNQ', active, recent: ['CL'], layouts })).toBe('MNQ');
    expect(preferredInstrument({ chosen: null, active, recent: ['CL'], layouts })).toBe('ES');
    expect(preferredInstrument({ chosen: '', active: null, recent: ['CL'], layouts })).toBe('CL');
    expect(preferredInstrument({ active: null, recent: [], layouts })).toBe('ES');
    expect(preferredInstrument({ active: null, recent: [], layouts: {} })).toBeNull();
    expect(
      preferredInstrument({
        active: { layoutId: 'recent', tileId: 'missing' },
        recent: [],
        layouts: { recent: newWorkspaceLayout('recent', 2, { instrument: null }) },
      }),
    ).toBeNull();
  });
});

describe('a tile’s own settings', () => {
  it('read the panel’s params, which dockview’s api does not know until the first update', () => {
    const { panel, api } = fakePanel('chart-1', { layoutId: 'default', tileId: 'chart-1' });
    expect(tileParams(api)).toEqual({ layoutId: 'default', tileId: 'chart-1' });
    setTileParams(api, { link: '2' });
    expect(panel.params).toEqual({ layoutId: 'default', tileId: 'chart-1', link: '2' });
    setTileParams<{ link: unknown }>(api, { link: undefined });
    expect(panel.params).toEqual({ layoutId: 'default', tileId: 'chart-1' });
  });

  it('fall back to the api’s params without a panel to read', () => {
    const api = { getParameters: () => ({ link: '2' }) } as never as Parameters<typeof tileParams>[0];
    expect(tileParams(api)).toEqual({ link: '2' });
    expect(tileParams({ getParameters: () => undefined } as never as Parameters<typeof tileParams>[0])).toEqual({});
  });
});

describe('Trade, the right sidebar’s trading panel', () => {
  it('trades the active chart, else the layout’s, else the dock’s first; none without a chart in the dock', () => {
    const base = { layoutId: 'default', layoutActive: 'chart-1', docked: ['chart-1', 'chart-2'] };
    expect(tradeChartOf({ ...base, active: { layoutId: 'default', tileId: 'chart-2' } })).toBe('chart-2');
    expect(tradeChartOf({ ...base, active: { layoutId: 'other', tileId: 'chart-2' } })).toBe('chart-1');
    expect(tradeChartOf({ ...base, active: { layoutId: 'default', tileId: 'chart-3' } })).toBe('chart-1');
    expect(tradeChartOf({ ...base, active: null, layoutActive: 'chart-3' })).toBe('chart-1');
    expect(tradeChartOf({ ...base, active: null, docked: [] })).toBeNull();
  });

  it('is in a chart’s own menu: change symbol, replay a saved day, chart type, and Trade on this chart', () => {
    const { panel, api } = fakePanel('chart-3', { layoutId: 'default', tileId: 'chart-3' });
    const labels = () => chartMenu({ ...panel, api } as never).map((e) => (e.type === 'sep' ? '—' : e.label));
    expect(labels()).toEqual(['Change symbol…', 'Replay a saved day…', 'Chart type', 'Trade this chart']);
    expect(chartMenu({ ...panel, api: fakePanel('x', {}).api } as never)).toEqual([]);
  });
});
