import type { ChartState, JsonValue } from '@tessera/protocol';
import type { DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domSummary, DEFAULT_DOM_PARAMS } from '../src/orderflow/dom/ladderModel.ts';
import { domCommands } from '../src/orderflow/dom/commands.ts';
import { addDomTile, addTapeTile, COLUMN_WIDTH, freePanelId, TAPE_SHARE } from '../src/orderflow/place.ts';
import { tapeCommands } from '../src/orderflow/tape/commands.ts';
import { readTapeParams, tapeWords } from '../src/orderflow/tape/tapeModel.ts';
import { followedChart, sizingChart } from '../src/orderflow/tileInstrument.ts';
import { placeBaseFor, type DomTradeSetup } from '../src/orderflow/dom/trading.ts';
import { unsizedWords } from '../src/orderflow/dom/ladderModel.ts';
import { bindTileKeys, focusedTileKeys, tileKeys, type DomKeys, type TapeKeys } from '../src/orderflow/tileKeys.ts';
import { paramsMatch } from '../src/workspace/dock/open.ts';
import { setTileFacts, tileSettingsUiStore } from '../src/workspace/dock/tileSettingsUi.ts';
import { openRequestedTiles, tileRequestsOf } from '../src/workspace/tileRequests.ts';
import { tileDefinition } from '../src/workspace/tiles/index.ts';
import { read } from '../src/app/store.ts';

function fakeDock(width: number, panels: { id: string; component: string; width?: number; height?: number }[] = []) {
  const added: Record<string, unknown>[] = [];
  const all = panels.map((p) => ({
    id: p.id,
    params: {},
    group: { id: p.id },
    api: { component: p.component, width: p.width ?? 0, height: p.height ?? 0 },
  }));
  const api = {
    width,
    get panels() {
      return all;
    },
    groups: [],
    getPanel: (id: string) => all.find((p) => p.id === id),
    addPanel: (o: Record<string, unknown>) => {
      added.push(o);
      all.push({
        id: o.id as string,
        params: o.params as object,
        group: { id: o.id as string },
        api: { component: o.component as string, width: 0, height: 0 },
      });
    },
    toJSON: () => ({ grid: { root: { type: 'branch', data: [] }, orientation: 'HORIZONTAL' } }),
  };
  return { api: api as unknown as DockviewApi, added };
}

const chart = (tileId: string, instrument: string, linkGroup: string | null): ChartState => ({
  tileId,
  title: tileId,
  instrument,
  timeframe: '1m',
  layers: [],
  annotations: [],
  viewport: null,
  linkGroup,
});

describe('the order-flow column (orderflow spec §3.1)', () => {
  it('opens the ladder to the right of its chart at 264', () => {
    expect(COLUMN_WIDTH).toBe(264);
    const { api, added } = fakeDock(1224, [{ id: 'chart-1', component: 'chart', width: 1224 }]);
    expect(addDomTile(api, { beside: 'chart-1', params: { link: '1' } })).toBe('dom');
    expect(added[0]).toMatchObject({
      id: 'dom',
      component: 'dom',
      initialWidth: 264,
      position: { referencePanel: 'chart-1', direction: 'right' },
      params: { ...DEFAULT_DOM_PARAMS, link: '1' },
    });
    expect(freePanelId(api, 'dom')).toBe('dom-2');
  });

  it('puts time & sales under the ladder of its link at 38% of the column, else beside the chart', () => {
    const { api, added } = fakeDock(1224, [
      { id: 'chart-1', component: 'chart', width: 960 },
      { id: 'dom', component: 'dom', width: 264, height: 800 },
    ]);
    (api.getPanel('dom') as unknown as { params: object }).params = { link: '1' };
    expect(addTapeTile(api, { beside: 'chart-1', params: { link: '1' } })).toBe('tape');
    expect(added[0]).toMatchObject({
      component: 'tape',
      initialHeight: Math.round(800 * TAPE_SHARE),
      position: { referencePanel: 'dom', direction: 'below' },
      params: { link: '1', minSize: 0, aggregate: true },
    });
    const lone = fakeDock(724, [{ id: 'chart-1', component: 'chart', width: 724 }]);
    addTapeTile(lone.api, { beside: 'chart-1' });
    expect(lone.added[0]).toMatchObject({
      initialWidth: 264,
      position: { referencePanel: 'chart-1', direction: 'right' },
    });
  });

  it('registers the DOM and time & sales as centre tiles with links, settings and a place of their own', () => {
    for (const [kind, icon] of [
      ['dom', 'dom'],
      ['tape', 'tape'],
    ] as const) {
      const def = tileDefinition(kind);
      expect(def).toMatchObject({ home: 'centre', singleton: false, linkable: true, icon });
      expect(def?.add).toBeTypeOf('function');
      expect(def?.settings?.component).toBeTypeOf('function');
      expect(def?.tab).toBeTypeOf('function');
    }
  });

  it('reads on the settings trigger what narrows the tile now, and nothing otherwise', () => {
    const dom = tileDefinition('dom')!.settings!.summary!;
    const tape = tileDefinition('tape')!.settings!.summary!;
    expect(dom({})).toBeNull();
    expect(dom({ rowTicks: 4 })).toBe('4 ticks');
    expect(domSummary({ rowTicks: 1 })).toBeNull();
    expect(tape({})).toBeNull();
    expect(tape({ minSize: 10, side: 'buy' })).toBe('Buys ≥ 10');
    expect(tape({ minSize: 10 })).toBe(tapeWords(readTapeParams({ minSize: 10 })));
    expect(tape({ minSize: 25, speed: 'slow' })).toBe('≥ 25 · Slow');
  });

  it('keeps what a tile tells its settings until it says otherwise or goes', () => {
    setTileFacts('tape', { note: 'Buy/sell side inferred', autoSize: 23 });
    setTileFacts('tape', { autoSize: 25 });
    expect(read(tileSettingsUiStore).facts.tape).toEqual({ note: 'Buy/sell side inferred', autoSize: 25 });
    const before = read(tileSettingsUiStore);
    setTileFacts('tape', { autoSize: 25 });
    expect(read(tileSettingsUiStore)).toBe(before);
    setTileFacts('tape', null);
    expect(read(tileSettingsUiStore).facts).toEqual({});
  });
});

describe('the chart an order-flow tile follows (orderflow spec §2.3)', () => {
  const charts = {
    'chart-1': chart('chart-1', 'ESZ6.CME', '1'),
    'chart-2': chart('chart-2', 'NQZ6.CME', '2'),
    'chart-3': chart('chart-3', 'CLZ6.NYMEX', '2'),
  };
  const at = (tileId: string) => ({ layoutId: 'default', tileId });

  it('follows the active chart without a link', () => {
    expect(followedChart(charts, at('chart-2'), null)).toEqual({ ...at('chart-2'), instrument: 'NQZ6.CME' });
    expect(followedChart(charts, null, null)).toBeNull();
  });

  it('follows its group: the active chart when it is in it, else the group’s first, else the active chart', () => {
    expect(followedChart(charts, at('chart-3'), '2')?.tileId).toBe('chart-3');
    expect(followedChart(charts, at('chart-1'), '2')?.tileId).toBe('chart-2');
    expect(followedChart(charts, at('chart-1'), '4')?.tileId).toBe('chart-1');
  });

  it('reads a group an older build saved as a letter as its number, on either side', () => {
    expect(followedChart(charts, at('chart-1'), 'B')?.tileId).toBe('chart-2');
    const lettered = { ...charts, 'chart-2': chart('chart-2', 'NQZ6.CME', 'B') };
    expect(followedChart(lettered, at('chart-1'), '2')?.tileId).toBe('chart-2');
    expect(followedChart(lettered, at('chart-2'), 'B')?.tileId).toBe('chart-2');
  });
});

describe('the ticket a DOM trades with (desk spec §4.4)', () => {
  const charts = {
    'chart-1': chart('chart-1', 'QQQ', null),
    'chart-2': chart('chart-2', 'NQZ6.CME', null),
    'chart-3': chart('chart-3', 'ESZ6.CME', null),
  };
  const following = (tileId: string) => ({
    layoutId: 'default',
    tileId,
    instrument: charts[tileId as 'chart-1'].instrument,
  });

  it('is the followed chart’s, unpinned or pinned to what that chart shows', () => {
    expect(sizingChart(charts, following('chart-1'), null)?.tileId).toBe('chart-1');
    expect(sizingChart(charts, following('chart-2'), 'NQZ6.CME')?.tileId).toBe('chart-2');
    expect(sizingChart(charts, following('chart-2'), 'NQ')?.tileId).toBe('chart-2');
  });

  it('is a chart of the pinned instrument when the followed chart shows another, never that chart’s', () => {
    expect(sizingChart(charts, following('chart-1'), 'ESZ6.CME')?.tileId).toBe('chart-3');
    expect(sizingChart(charts, following('chart-1'), 'ES')?.tileId).toBe('chart-3');
    expect(sizingChart(charts, following('chart-1'), 'CLZ6.NYMEX')).toBeNull();
  });

  it('takes a chart of the exact pinned contract over the followed chart of the same root', () => {
    const withH7 = { ...charts, 'chart-4': chart('chart-4', 'ESH7.CME', null) };
    const followingH7 = { layoutId: 'default', tileId: 'chart-4', instrument: 'ESH7.CME' };
    expect(sizingChart(withH7, followingH7, 'ESZ6.CME')?.tileId).toBe('chart-3');
    expect(sizingChart(withH7, followingH7, 'ESM7.CME')?.tileId).toBe('chart-4');
  });

  it('sends nothing without one, and says how to get one', () => {
    const setup: DomTradeSetup = {
      account: { account: { id: 'paper', environment: 'paper' } } as never,
      gate: { kind: 'readonly', why: unsizedWords('CL Z6') },
      instrument: 'CLZ6.NYMEX',
      symbol: 'CL Z6',
      math: null,
      ticket: { qty: 100, sizing: 'qty', risk: null },
      oco: null,
      scope: null,
    } as never;
    expect(placeBaseFor(setup)).toEqual({ why: 'Open a CL Z6 chart to size orders here' });
  });
});

describe('the DOM’s and time & sales’ keys in the command map (orderflow spec §9)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const domKeys = (): DomKeys & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      scroll: (n) => calls.push(`scroll ${String(n)}`),
      page: (d) => calls.push(`page ${String(d)}`),
      centre: () => calls.push('centre'),
      holding: () => false,
      escape: () => calls.push('escape'),
      cancelAll: () => calls.push('cancel'),
      flatten: () => calls.push('flatten'),
      breakeven: () => calls.push('breakeven'),
      order: (a) => calls.push(`order ${a}`),
      sends: () => true,
    };
  };

  it('scopes each key to its tile’s zone and acts on the focused tile, else the one focused last', () => {
    const el = document.createElement('div');
    el.tabIndex = 0;
    el.className = 'dom-tile';
    document.body.append(el);
    const keys = domKeys();
    const unbind = bindTileKeys('dom', el, keys);
    expect(focusedTileKeys('dom')).toBeNull();
    el.focus();
    expect(focusedTileKeys('dom')).toBe(keys);
    el.blur();
    expect(tileKeys('dom')).toBe(keys);
    const cmds = Object.fromEntries(domCommands().map((c) => [c.id, c]));
    expect(cmds['dom.centre']).toMatchObject({ shortcut: 'space', zone: 'dom' });
    expect(cmds['dom.cancelAll']).toMatchObject({ shortcut: 'mod+shift+backspace', zone: 'dom', hidden: true });
    expect(cmds['dom.flatten']).toMatchObject({ shortcut: 'mod+shift+f', zone: 'dom', hidden: true });
    expect(cmds['dom.breakeven']).toMatchObject({ shortcut: 'mod+shift+b', zone: 'dom', hidden: true });
    expect(cmds['dom.rowUp']).toMatchObject({ shortcut: 'arrowup', zone: 'dom', hidden: true });
    void cmds['dom.centre']!.run();
    expect(cmds['dom.flatten']!.when?.()).toBe(false);
    void cmds['dom.flatten']!.run();
    expect(cmds['dom.rowUp']!.when?.()).toBe(false);
    el.focus();
    void cmds['dom.pageDown']!.run();
    expect(cmds['dom.flatten']!.when?.()).toBe(true);
    void cmds['dom.flatten']!.run();
    void cmds['dom.breakeven']!.run();
    expect(cmds['dom.escape']!.when?.()).toBe(false);
    expect(keys.calls).toEqual(['centre', 'page -1', 'flatten', 'breakeven']);
    unbind();
    expect(tileKeys('dom')).toBeNull();
  });

  it('gives time & sales Space, Home and Esc while paused', () => {
    const el = document.createElement('div');
    el.tabIndex = 0;
    document.body.append(el);
    let paused = true;
    const calls: string[] = [];
    const keys: TapeKeys = {
      toggle: () => calls.push('toggle'),
      newest: () => calls.push('newest'),
      paused: () => paused,
    };
    const unbind = bindTileKeys('tape', el, keys);
    el.focus();
    const cmds = Object.fromEntries(tapeCommands().map((c) => [c.id, c]));
    expect(cmds['tape.pause']).toMatchObject({ shortcut: 'space', zone: 'tape' });
    expect(cmds['tape.newest']).toMatchObject({ shortcut: 'home', zone: 'tape' });
    expect(cmds['tape.resume']!.when?.()).toBe(true);
    paused = false;
    expect(cmds['tape.resume']!.when?.()).toBe(false);
    void cmds['tape.pause']!.run();
    void cmds['tape.newest']!.run();
    expect(calls).toEqual(['toggle', 'newest']);
    unbind();
  });
});

describe('tiles an agent asked for (workspace.open_tile)', () => {
  const dock = (open: unknown): JsonValue => ({ grid: {}, panels: {}, tessera: { v: 2, open } }) as JsonValue;

  it('reads the requests the runtime keeps under the desk’s view, skipping what it cannot read', () => {
    expect(
      tileRequestsOf(
        dock([
          { id: 'open-4', kind: 'dom', params: { instrument: 'ESZ6.CME', link: null } },
          { id: 'open-5', kind: 'tape', params: { link: '1' } },
          { id: 'open-6', kind: 'research', params: {} },
          { id: 'open-7', kind: 'dom', params: { settings: { traded: 'recent' } } },
          'junk',
        ]),
      ),
    ).toEqual([
      { id: 'open-4', kind: 'dom', params: { instrument: 'ESZ6.CME', link: null } },
      { id: 'open-5', kind: 'tape', params: { instrument: null, link: '1' } },
      { id: 'open-7', kind: 'dom', params: { instrument: null, link: null, settings: { traded: 'recent' } } },
    ]);
    expect(tileRequestsOf(null)).toEqual([]);
    expect(tileRequestsOf({ tessera: { v: 2 } })).toEqual([]);
  });

  it('opens each request once per window, so a reload or a late echo never adds a second tile', () => {
    const open = vi.fn();
    const layout = {
      id: 'ws-req',
      dock: dock([{ id: 'open-2', kind: 'dom', params: { instrument: null, link: '1' } }]),
    };
    expect(openRequestedTiles(layout, open)).toBe(true);
    expect(open).toHaveBeenCalledWith('dom', { instrument: null, link: '1' });
    expect(openRequestedTiles(layout, open)).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('shows a tile with the asked params rather than adding a second', () => {
    expect(paramsMatch({ link: '1', instrument: null, rowTicks: 2 }, { link: '1', instrument: null })).toBe(true);
    expect(paramsMatch({ link: '1' }, { link: '1', instrument: null })).toBe(true);
    expect(paramsMatch({ link: null }, { link: '1' })).toBe(false);
    expect(paramsMatch({ link: '2' })).toBe(true);
  });
});
