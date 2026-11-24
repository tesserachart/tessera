import type { JsonValue } from '@tessera/protocol';
import { describe, expect, it, vi } from 'vitest';
import { areaStore } from '../src/areas/store.ts';
import { drawingStore } from '../src/chart/drawings/store.ts';
import {
  applySetting,
  currentDrawingTools,
  currentPreferences,
  readDrawingTools,
  readPreferences,
} from '../src/state/settingsSync.ts';
import { DEFAULT_UI, uiStore } from '../src/state/ui.ts';
import { watchlistsStore } from '../src/markets/watchlists.ts';
import { dockOpsOf, takeDeskRequests, tileRequestsOf } from '../src/workspace/tileRequests.ts';
import { read, patch } from '../src/app/store.ts';

const dock = (view: Record<string, unknown>): JsonValue => ({ grid: {}, panels: {}, tessera: { v: 2, ...view } });

describe('changes tools ask of the desk', () => {
  it('reads every tile kind and every op, skipping what it cannot read', () => {
    expect(
      tileRequestsOf(
        dock({
          open: [
            { id: 'open-3', kind: 'chart', params: { instrument: 'ESZ6.CME' } },
            { id: 'open-4', kind: 'analyst', params: {} },
            { id: 'open-5', kind: 'journal', params: {} },
            { id: 'open-6', kind: 'research', params: {} },
          ],
        }),
      ).map((r) => [r.id, r.kind, r.params.instrument]),
    ).toEqual([
      ['open-3', 'chart', 'ESZ6.CME'],
      ['open-4', 'analyst', null],
      ['open-5', 'journal', null],
    ]);
    expect(
      dockOpsOf(
        dock({
          ops: [
            { id: 'op-6', op: 'close', tileId: 'chart-2', kind: 'chart', preset: null, settings: null, place: null },
            { id: 'op-7', op: 'focus', kind: 'markets' },
            { id: 'op-8', op: 'preset', preset: '2h' },
            { id: 'op-9', op: 'settings', tileId: 'dom', settings: { rowTicks: 4 } },
            { id: 'op-10', op: 'explode' },
            { id: 'op-11', op: 'preset', preset: '7' },
            'junk',
          ],
        }),
      ),
    ).toEqual([
      { id: 'op-6', op: 'close', tileId: 'chart-2', kind: 'chart', preset: null, settings: null, place: null },
      { id: 'op-7', op: 'focus', tileId: null, kind: 'markets', preset: null, settings: null, place: null },
      { id: 'op-8', op: 'preset', tileId: null, kind: null, preset: '2h', settings: null, place: null },
      { id: 'op-9', op: 'settings', tileId: 'dom', kind: null, preset: null, settings: { rowTicks: 4 }, place: null },
      { id: 'op-11', op: 'preset', tileId: null, kind: null, preset: null, settings: null, place: null },
    ]);
    expect(dockOpsOf(null)).toEqual([]);
  });

  it('makes them in the order they were asked, each once per window', () => {
    const seen: string[] = [];
    const handlers = {
      open: vi.fn((kind: string) => seen.push(`open ${kind}`)),
      close: vi.fn((t: { tileId: string | null }) => seen.push(`close ${String(t.tileId)}`)),
      focus: vi.fn((t: { kind: string | null }) => seen.push(`focus ${String(t.kind)}`)),
      preset: vi.fn((p: string) => seen.push(`preset ${p}`)),
      settings: vi.fn((id: string, s: Record<string, unknown>) => seen.push(`settings ${id} ${JSON.stringify(s)}`)),
    };
    const layout = {
      id: 'ws-order',
      dock: dock({
        open: [
          { id: 'open-9', kind: 'dom', params: { link: '1' } },
          { id: 'open-12', kind: 'chart', params: { instrument: null } },
        ],
        ops: [
          { id: 'op-10', op: 'close', tileId: 'dom' },
          { id: 'op-11', op: 'preset', preset: 'reset' },
          { id: 'op-13', op: 'settings', tileId: 'tape', settings: { minSize: 10 } },
          { id: 'op-14', op: 'focus', kind: 'analyst' },
          { id: 'op-15', op: 'close' },
        ],
      }),
    };
    expect(takeDeskRequests(layout, handlers)).toBe(true);
    expect(seen).toEqual([
      'open dom',
      'close dom',
      'preset reset',
      'open chart',
      'settings tape {"minSize":10}',
      'focus analyst',
    ]);
    expect(takeDeskRequests(layout, handlers)).toBe(false);
    expect(seen).toHaveLength(6);
  });

  it('moves a tile and sets the view, reading only what it can', () => {
    const move = vi.fn();
    const view = vi.fn();
    const layout = {
      id: 'ws-move',
      dock: dock({
        ops: [
          { id: 'op-2', op: 'move', kind: 'markets', place: 'right' },
          { id: 'op-3', op: 'move', tileId: 'dom', place: 'popout' },
          { id: 'op-4', op: 'view', settings: { left: false, shareInterval: true, top: true, bottom: 'yes' } },
        ],
      }),
    };
    expect(takeDeskRequests(layout, { move, view })).toBe(true);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith({ tileId: null, kind: 'markets' }, 'right');
    expect(view).toHaveBeenCalledWith({ left: false, shareInterval: true });
  });

  it('leaves a request this desk has no handler for to one that has', () => {
    const layout = { id: 'ws-partial', dock: dock({ ops: [{ id: 'op-3', op: 'preset', preset: '4' }] }) };
    expect(takeDeskRequests(layout, { open: () => undefined })).toBe(false);
    const preset = vi.fn();
    expect(takeDeskRequests(layout, { preset })).toBe(true);
    expect(preset).toHaveBeenCalledWith('4');
  });
});

describe('what the window shows is a runtime setting', () => {
  it('shows the area and the workspace an agent set', () => {
    patch(areaStore, { area: 'desk' });
    applySetting('ui.area', 'journal');
    expect(read(areaStore).area).toBe('journal');
    applySetting('ui.area', 'trading');
    expect(read(areaStore).area).toBe('journal');
    applySetting('ui.workspace', 'ws-scalp');
    expect(read(uiStore).workspace).toBe('ws-scalp');
    applySetting('ui.workspace', '');
    expect(read(uiStore).workspace).toBeNull();
    patch(areaStore, { area: 'desk' });
  });

  it('reads no watchlist, list or sort from the preferences: the watchlists are their own setting', () => {
    expect(
      readPreferences({ watchlist: ['NQ'], marketList: 'index', marketSort: { futures: { key: 'pct', dir: 'desc' } } }),
    ).toEqual({});
    expect(Object.keys(currentPreferences({ ...read(uiStore), ...DEFAULT_UI })).sort()).toEqual([
      'defaultChartType',
      'favouriteIntervals',
      'recentSymbols',
    ]);
    applySetting('markets.watchlists', { lists: [{ id: 'majors', name: 'Majors', symbols: ['NQ', 'ES', 'NQ'] }] });
    expect(read(watchlistsStore)).toMatchObject({
      loaded: true,
      value: { lists: [{ id: 'majors', name: 'Majors', symbols: ['NQ', 'ES'] }] },
    });
    applySetting('markets.watchlists', { lists: 'nope' });
    expect(read(watchlistsStore).value.lists[0]?.id).toBe('majors');
  });

  it('takes the drawing tools an agent set: the magnet, the rail folded, each tool’s style for new drawings', () => {
    expect(
      readDrawingTools({
        magnet: true,
        toolbarFolded: 'no',
        styles: { trend_line: { color: '#e05a5a', width: 2, line: 'wavy' }, ray: 7 },
      }),
    ).toEqual({ magnet: true, styleByKind: { trend_line: { color: '#e05a5a', width: 2 } } });
    applySetting('chart.drawingTools', { magnet: true, toolbarFolded: true, styles: { text: { color: 'brass' } } });
    expect(currentDrawingTools()).toEqual({ magnet: true, toolbarFolded: true, styles: { text: { color: 'brass' } } });
    patch(drawingStore, { magnet: false, collapsed: false, styleByKind: {} });
  });
});
