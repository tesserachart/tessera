import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChartState } from '@tessera/protocol';
import { describe, expect, it } from 'vitest';
import { setActiveChartRef, workspaceStore } from '../src/state/workspace.ts';
import { withUserCollapse } from '../src/workspace/controller.ts';
import { installActiveChartFollow } from '../src/workspace/dock/activeChart.ts';
import { installMoveOpensEdge } from '../src/workspace/dock/edgeArrive.ts';
import { edgeBandAt } from '../src/workspace/dock/edgeDrop.ts';
import {
  clampEdgeSize,
  EDGE_SPEC,
  EDGE_STRIP,
  edgeFitSize,
  edgeInitialSize,
  edgeOfGroupId,
  EDGES,
  fitEdges,
  NARROW_WINDOW_W,
} from '../src/workspace/dock/edges.ts';
import {
  linkedCharts,
  linkGroupsInUse,
  normalizeChartLinks,
  normalizeLink,
  showLinkColours,
} from '../src/workspace/dock/links.ts';
import { planReveal, type DockSnapshot } from '../src/workspace/dock/open.ts';
import { fitHeader, type Fold, type HeaderMeasure } from '../src/workspace/dock/header/fit.ts';
import { dockShape } from '../src/workspace/layouts.ts';
import { read } from '../src/app/store.ts';
import { appCss } from './support/appCss.ts';

describe('colour links (spec §2.6)', () => {
  const chart = (tileId: string, linkGroup: string | null, instrument = 'NQ'): ChartState =>
    ({ tileId, linkGroup, instrument }) as ChartState;

  it('reads older letters as numbers and anything else as no link', () => {
    expect(['1', '4', 'A', 'd', 'E', 'F', '', null, 5].map(normalizeLink)).toEqual([
      '1',
      '4',
      '1',
      '4',
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('shows colours only once two or more groups are in use', () => {
    expect(linkGroupsInUse(['2', 'B', null, '1'])).toEqual(['1', '2']);
    expect(showLinkColours(['1', '1', 'A', null])).toBe(false);
    expect(showLinkColours(['1', '2'])).toBe(true);
  });

  it('reaches the charts of a group from any of them', () => {
    const charts = { a: chart('a', '1'), b: chart('b', 'A'), c: chart('c', '2'), d: chart('d', null) };
    expect(linkedCharts(charts, 'a')).toEqual(['a', 'b']);
    expect(linkedCharts(charts, 'd')).toEqual(['d']);
    expect(linkedCharts(charts, 'zz')).toEqual([]);
  });

  it('normalizes the charts of an older workspace, and links them all for its sync symbol', () => {
    const charts = { a: chart('a', 'B'), b: chart('b', '2'), c: chart('c', 'F') };
    expect(normalizeChartLinks(charts)).toEqual({ a: chart('a', '2'), b: chart('b', '2'), c: chart('c', null) });
    expect(normalizeChartLinks({ b: chart('b', '2') })).toBeNull();
    expect(Object.values(normalizeChartLinks(charts, '1')!).map((c) => c.linkGroup)).toEqual(['1', '1', '1']);
  });
});

describe('revealing and hiding tiles (spec §2.3)', () => {
  const snap = (over: Partial<DockSnapshot> = {}): DockSnapshot => ({
    panels: [
      { id: 'chart-1', kind: 'chart', place: 'centre', groupId: 'g1' },
      { id: 'chart-2', kind: 'chart', place: 'centre', groupId: 'g2' },
      { id: 'markets', kind: 'markets', place: 'left', groupId: 'edge-left' },
      { id: 'positions', kind: 'positions', place: 'bottom', groupId: 'edge-bottom' },
    ],
    groups: [
      { id: 'g1', place: 'centre' },
      { id: 'g2', place: 'centre' },
      { id: 'edge-left', place: 'left' },
      { id: 'edge-right', place: 'right' },
      { id: 'edge-bottom', place: 'bottom' },
    ],
    edges: {
      left: { collapsed: true, visible: true },
      right: { collapsed: false, visible: false },
      bottom: { collapsed: false, visible: true },
    },
    activeChartId: 'chart-2',
    ...over,
  });
  const singleton = (kind: string, home: 'left' | 'right' | 'bottom', order = 0) => ({
    kind,
    home,
    singleton: true,
    order,
  });
  const orderOf = (k: string) => (k === 'accounts' ? 1 : 0);

  it('finds the tile there is and opens its collapsed edge', () => {
    expect(planReveal(snap(), singleton('markets', 'left'), { panelId: 'markets' })).toEqual({
      type: 'existing',
      panelId: 'markets',
      expand: 'left',
    });
    expect(planReveal(snap(), singleton('positions', 'bottom'), { panelId: 'positions' })).toEqual({
      type: 'existing',
      panelId: 'positions',
      expand: null,
    });
  });

  it('finds a singleton an older build named otherwise by its kind', () => {
    const s = snap({
      panels: [
        ...snap().panels.filter((p) => p.kind !== 'markets'),
        { id: 'w', kind: 'markets', place: 'centre', groupId: 'g3' },
      ],
    });
    expect(planReveal(s, singleton('markets', 'left'), { panelId: 'markets' })).toMatchObject({
      type: 'existing',
      panelId: 'w',
      expand: null,
    });
  });

  it('creates a missing tile in its home edge, at its place among the others, and shows a hidden edge', () => {
    expect(planReveal(snap(), singleton('accounts', 'bottom', 1), { panelId: 'accounts', orderOf })).toEqual({
      type: 'create',
      panelId: 'accounts',
      spot: { at: 'edge', edge: 'bottom', index: 1 },
      expand: null,
    });
    expect(planReveal(snap(), singleton('analyst', 'right'), { panelId: 'analyst' })).toMatchObject({
      type: 'create',
      spot: { at: 'edge', edge: 'right', index: 0 },
      expand: 'right',
    });
  });

  it('puts a tile of the centre beside the active chart, and reveals the active chart of many', () => {
    expect(
      planReveal(snap(), { kind: 'dom', home: 'centre', singleton: false, order: 0 }, { panelId: 'dom-1' }),
    ).toEqual({
      type: 'create',
      panelId: 'dom-1',
      spot: { at: 'beside', panelId: 'chart-2' },
      expand: null,
    });
    expect(planReveal(snap(), { kind: 'chart', home: 'centre', singleton: false, order: 0 })).toMatchObject({
      type: 'existing',
      panelId: 'chart-2',
    });
    expect(planReveal(snap(), { kind: 'dom', home: 'centre', singleton: false, order: 0 })).toEqual({ type: 'none' });
  });

  it('reopens a closed tile in the group it left, at its tab while that tab still exists', () => {
    const closed = (place: Record<string, unknown>) => ({
      panelId: 'accounts',
      place: { referenceGroupId: null, direction: 'within' as const, ...place },
    });
    const accounts = singleton('accounts', 'bottom', 1);
    expect(
      planReveal(snap(), accounts, {
        panelId: 'accounts',
        orderOf,
        closed: closed({ referenceGroupId: 'edge-bottom', index: 0 }),
      }),
    ).toMatchObject({ type: 'create', spot: { at: 'edge', edge: 'bottom', index: 0 } });
    expect(
      planReveal(snap(), accounts, {
        panelId: 'accounts',
        closed: closed({ referenceGroupId: 'edge-bottom', index: 5 }),
      }),
    ).toMatchObject({ spot: { at: 'edge', edge: 'bottom', index: 1 } });
    expect(
      planReveal(snap(), accounts, { panelId: 'accounts', closed: closed({ referenceGroupId: 'g1', index: 1 }) }),
    ).toEqual({ type: 'create', panelId: 'accounts', spot: { at: 'tabs', groupId: 'g1', index: 1 }, expand: null });
    expect(
      planReveal(snap(), singleton('analyst', 'right'), {
        panelId: 'analyst',
        closed: { panelId: 'analyst', place: { referenceGroupId: 'edge-right', direction: 'within', index: 0 } },
      }),
    ).toMatchObject({ spot: { at: 'edge', edge: 'right', index: 0 }, expand: 'right' });
    expect(
      planReveal(snap(), accounts, {
        panelId: 'accounts',
        closed: closed({ referenceGroupId: 'edge-left', index: 0 }),
      }),
    ).toMatchObject({ spot: { at: 'edge', edge: 'left', index: 0 }, expand: 'left' });
  });

  it('reopens a tile that stood beside another group on that side, with its own panel id', () => {
    const dom = { kind: 'dom', home: 'centre' as const, singleton: false, order: 0 };
    expect(
      planReveal(snap(), dom, { closed: { panelId: 'dom-3', place: { referenceGroupId: 'g1', direction: 'below' } } }),
    ).toEqual({
      type: 'create',
      panelId: 'dom-3',
      spot: { at: 'split', groupId: 'g1', direction: 'below' },
      expand: null,
    });
  });

  it('reopens a tile at its home when the place it left is gone', () => {
    const dom = { kind: 'dom', home: 'centre' as const, singleton: false, order: 0 };
    expect(
      planReveal(snap(), dom, { closed: { panelId: 'dom-3', place: { referenceGroupId: 'g9', direction: 'left' } } }),
    ).toMatchObject({ panelId: 'dom-3', spot: { at: 'beside', panelId: 'chart-2' } });
    expect(
      planReveal(snap(), singleton('accounts', 'bottom', 1), {
        panelId: 'accounts',
        orderOf,
        closed: { panelId: 'accounts', place: { referenceGroupId: 'g9', direction: 'within', index: 0 } },
      }),
    ).toMatchObject({ spot: { at: 'edge', edge: 'bottom', index: 1 } });
    expect(
      planReveal(snap(), dom, {
        closed: { panelId: 'dom-3', place: { referenceGroupId: 'edge-bottom', direction: 'right' } },
      }),
    ).toMatchObject({ spot: { at: 'beside', panelId: 'chart-2' } });
  });
});

describe('edges', () => {
  it('names its groups, sizes by the window, and keeps sizes within limits', () => {
    expect(edgeOfGroupId('edge-right')).toBe('right');
    expect(edgeOfGroupId('g-1')).toBeNull();
    expect([edgeInitialSize('left', 1920), edgeInitialSize('left', 1440), edgeInitialSize('right', 1100)]).toEqual([
      256, 216, 344,
    ]);
    expect([clampEdgeSize('left', 100), clampEdgeSize('right', 900), clampEdgeSize('bottom', 700, 1000)]).toEqual([
      200, 640, 500,
    ]);
  });

  it('opens an edge to the room of the tiles it holds, never past its maximum', () => {
    expect(edgeFitSize('left', 256, [0, 320])).toBe(320);
    expect(edgeFitSize('left', 340, [0, 320])).toBeNull();
    expect(edgeFitSize('left', 216, [0, 0])).toBeNull();
    expect(edgeFitSize('left', 216, [])).toBeNull();
    expect(edgeFitSize('left', 256, [400])).toBe(360);
    expect(edgeFitSize('bottom', 192, [320], 600)).toBe(300);
    expect(edgeFitSize('right', 344, [320])).toBeNull();
  });

  it('opens each edge at its column’s token size, narrower where the tokens narrow, and folds it to the tab row', () => {
    const tokens = readFileSync(join(import.meta.dirname, '../../../packages/ui/src/styles/tokens.css'), 'utf8');
    const narrow = new RegExp(
      `@media \\(max-width: ${String(NARROW_WINDOW_W - 1)}px\\) \\{\\s*:root \\{([^}]*)\\}`,
    ).exec(tokens)?.[1];
    expect(narrow).toBeDefined();
    const px = (css: string, name: string) => Number(new RegExp(`(?<![\\w-])${name}:\\s*(\\d+)px`).exec(css)?.[1]);
    const narrowPx = (name: string) => {
      const n = px(narrow ?? '', name);
      return Number.isNaN(n) ? px(tokens, name) : n;
    };
    const column = { left: '--spacing-nav', right: '--spacing-analyst', bottom: '--spacing-bottom' } as const;
    for (const pos of EDGES) {
      expect(EDGE_SPEC[pos].initial).toBe(px(tokens, column[pos]));
      expect(EDGE_SPEC[pos].initialNarrow).toBe(narrowPx(column[pos]));
    }
    expect(EDGE_STRIP).toBe(px(tokens, '--spacing-tab'));
  });

  it('fits the open edges of a mounted dock, and gives the size back when the tile leaves', () => {
    const edge = (pos: string, w: number, h: number, kinds: string[], collapsed = false) => {
      const e = {
        pos,
        api: {
          width: w,
          height: h,
          isCollapsed: () => collapsed,
          setSize: (s: { width?: number; height?: number }) => {
            e.api.width = s.width ?? e.api.width;
            e.api.height = s.height ?? e.api.height;
          },
        },
        group: { id: `edge-${pos}`, panels: kinds.map((k) => ({ api: { component: k } })) },
      };
      return e;
    };
    const left = edge('left', 256, 900, ['markets', 'analyst']);
    const right = edge('right', 392, 900, ['positions']);
    const bottom = edge('bottom', 1200, 192, ['analyst'], true);
    const edges = [left, right, bottom];
    const api = {
      getEdgeGroup: (pos: string) => edges.find((e) => e.pos === pos)?.api,
      groups: edges.map((e) => e.group),
      isEdgeGroupVisible: () => true,
    } as unknown as Parameters<typeof fitEdges>[0];
    const roomOf = (kind: string) => (kind === 'analyst' ? 320 : 0);
    fitEdges(api, roomOf);
    expect([left.api.width, right.api.width, bottom.api.height]).toEqual([320, 392, 192]);
    left.group.panels = [{ api: { component: 'markets' } }];
    fitEdges(api, roomOf);
    expect(left.api.width).toBe(256);
    left.group.panels.push({ api: { component: 'analyst' } });
    fitEdges(api, roomOf);
    left.api.width = 340;
    left.group.panels = [{ api: { component: 'markets' } }];
    fitEdges(api, roomOf);
    expect(left.api.width).toBe(340);
  });

  it('opens a collapsed edge a tile is dropped on, never for a layout being applied or a reorder in it', async () => {
    let collapsed = true;
    let expanded = 0;
    const left = {
      id: 'edge-left',
      api: { location: { type: 'edge' } },
      element: { querySelector: () => null },
      panels: [],
    };
    const centre = { id: 'g-1', api: { location: { type: 'grid' } } };
    let move: (e: unknown) => void = () => undefined;
    const api = {
      onDidMovePanel: (l: (e: unknown) => void) => {
        move = l;
        return { dispose: () => undefined };
      },
      getEdgeGroup: (pos: string) =>
        pos === 'left'
          ? {
              isCollapsed: () => collapsed,
              expand: () => {
                expanded++;
                collapsed = false;
              },
            }
          : undefined,
      isEdgeGroupVisible: () => true,
      groups: [left, centre],
    } as unknown as Parameters<typeof installMoveOpensEdge>[0];
    let applying = true;
    const off = installMoveOpensEdge(api, () => applying);
    const tick = () => new Promise((r) => queueMicrotask(() => r(null)));
    move({ panel: { group: left }, from: centre });
    await tick();
    expect(expanded).toBe(0);
    applying = false;
    move({ panel: { group: left }, from: left });
    await tick();
    expect(expanded).toBe(0);
    move({ panel: { group: left }, from: centre });
    await tick();
    expect(expanded).toBe(1);
    off();
  });

  it('docks a drag to an edge only in the outer band of the centre’s side', () => {
    const rect = { left: 256, right: 1200, top: 40, bottom: 900 };
    expect(edgeBandAt(rect, 260, 400, 'left')).toBe('left');
    expect(edgeBandAt(rect, 275, 400, 'left')).toBeNull();
    expect(edgeBandAt(rect, 1195, 400, 'right')).toBe('right');
    expect(edgeBandAt(rect, 700, 895, 'bottom')).toBe('bottom');
    expect(edgeBandAt(rect, 700, 45, 'top')).toBeNull();
    expect(edgeBandAt(rect, 700, 45)).toBeNull();
    expect(edgeBandAt(rect, 2000, 400, 'right')).toBeNull();
    expect(edgeBandAt(rect, 262, 400)).toBe('left');
    expect(edgeBandAt(rect, 262, 400, 'right')).toBeNull();
    expect(edgeBandAt(rect, 600, 400)).toBeNull();
  });

  it('saves each edge as the user left it, not as focus mode or a narrow window has it', () => {
    const tree = {
      grid: {},
      edgeGroups: {
        left: { size: 256, collapsed: true, group: { id: 'edge-left', views: ['markets'], headerPosition: 'left' } },
        right: { size: 392, group: { id: 'edge-right', views: ['analyst'], headerPosition: 'top' } },
      },
    };
    const out = withUserCollapse(tree, { left: false, right: true }) as typeof tree;
    expect(out.edgeGroups.left).toEqual({
      size: 256,
      group: { id: 'edge-left', views: ['markets'], headerPosition: 'top' },
    });
    expect(out.edgeGroups.right).toMatchObject({ collapsed: true, group: { headerPosition: 'right' } });
    expect(withUserCollapse(tree, {})).toEqual(tree);
  });

  it('compares two windows’ trees without their collapsed edges', () => {
    const a = {
      edgeGroups: { left: { size: 256, collapsed: true, group: { views: ['markets'], headerPosition: 'left' } } },
    };
    const b = { edgeGroups: { left: { size: 300, group: { views: ['markets'], headerPosition: 'top' } } } };
    const c = { edgeGroups: { left: { size: 300, group: { views: ['markets', 'chart-2'] } } } };
    expect(dockShape(a)).toBe(dockShape(b));
    expect(dockShape(a)).not.toBe(dockShape(c));
  });
});

describe('the active chart follows the dock', () => {
  type Panel = { id: string; view: { contentComponent: string } };
  const fakeApi = () => {
    let fire: ((e: { panel: Panel | undefined }) => void) | null = null;
    const api = {
      onDidActivePanelChange: (fn: (e: { panel: Panel | undefined }) => void) => {
        fire = fn;
        return { dispose: () => (fire = null) };
      },
    } as unknown as Parameters<typeof installActiveChartFollow>[0];
    return { api, activate: (p: Panel | undefined) => fire?.({ panel: p }) };
  };

  it('a click on a chart’s tab (or ⌃Tab onto it) makes it the active chart; other tiles and loads leave it', () => {
    setActiveChartRef({ layoutId: 'ws', tileId: 'chart-1', source: null });
    const { api, activate } = fakeApi();
    let loading = false;
    const off = installActiveChartFollow(api, 'ws', () => loading);
    activate({ id: 'chart-2', view: { contentComponent: 'chart' } });
    expect(read(workspaceStore).activeChart?.tileId).toBe('chart-2');
    activate({ id: 'analyst', view: { contentComponent: 'analyst' } });
    activate(undefined);
    expect(read(workspaceStore).activeChart?.tileId).toBe('chart-2');
    loading = true;
    activate({ id: 'chart-1', view: { contentComponent: 'chart' } });
    expect(read(workspaceStore).activeChart?.tileId).toBe('chart-2');
    loading = false;
    off();
    activate({ id: 'chart-1', view: { contentComponent: 'chart' } });
    expect(read(workspaceStore).activeChart?.tileId).toBe('chart-2');
  });
});

describe('the dock’s stacking', () => {
  it('keeps a floating tile and every dockview overlay under the menus, popovers, tooltips and the environment rule', async () => {
    const style = document.createElement('style');
    style.textContent = [
      await appCss(),
      readFileSync(join(import.meta.dirname, '../src/styles/stage.css'), 'utf8'),
    ].join('\n');
    document.head.append(style);
    const root = document.createElement('div');
    root.className = 'dock-root';
    document.body.append(root);
    const z = (name: string) => Number(getComputedStyle(document.documentElement).getPropertyValue(name));
    const s = getComputedStyle(root);
    expect(s.isolation).toBe('isolate');
    expect(Number(s.zIndex)).toBeLessThan(z('--z-popover'));
    expect(z('--z-popover')).toBeLessThan(z('--z-env'));
    root.remove();
    style.remove();
  });
});

describe('a panel header narrower than its tabs and buttons', () => {
  const buttons: HeaderMeasure['folds'] = [
    { fold: 'add', width: 28 },
    { fold: 'popout', width: 28 },
    { fold: 'maximise', width: 28 },
    { fold: 'close', width: 28 },
    { fold: 'tab-close', width: 26 },
  ];
  const header = (room: number, over: Partial<HeaderMeasure> = {}): HeaderMeasure => ({
    room,
    fixed: 32,
    tabs: [80, 90, 110],
    active: 2,
    more: 50,
    folds: buttons,
    ...over,
  });
  const folded = (m: HeaderMeasure) => [...fitHeader(m).folded];
  const shown = (m: HeaderMeasure) => [...fitHeader(m).shown].sort();

  it('shows every tab and button while they all fit', () => {
    const fit = fitHeader(header(32 + 280 + 138));
    expect(fit.folded.size).toBe(0);
    expect(shown(header(32 + 280 + 138))).toEqual([0, 1, 2]);
    expect(fit.squeeze).toBe(0);
  });

  it('sends the other tabs to the overflow before any button folds, keeping the active one and each neighbour that fits whole', () => {
    expect(folded(header(32 + 138 + 110 + 50 + 80))).toEqual([]);
    expect(shown(header(32 + 138 + 110 + 50 + 80))).toEqual([0, 2]);
    expect(shown(header(32 + 138 + 110 + 50))).toEqual([2]);
  });

  it('folds buttons into More, Close first and the tab’s own close last, until the active tab fits whole', () => {
    const tight = (n: number) => header(32 + 138 + 110 + 50 - n);
    expect(folded(tight(1))).toEqual(['close']);
    expect(folded(tight(29))).toEqual(['close', 'popout']);
    expect(folded(tight(57))).toEqual(['close', 'popout', 'maximise']);
    expect(folded(tight(85))).toEqual(['close', 'popout', 'maximise', 'add']);
    expect(folded(tight(113))).toEqual<Fold[]>(['close', 'popout', 'maximise', 'add', 'tab-close']);
    expect(fitHeader(tight(113)).squeeze).toBe(0);
  });

  it('keeps Split chart past Maximise, and folds it before the add button', () => {
    const three: HeaderMeasure['folds'] = [
      { fold: 'add', width: 28 },
      { fold: 'split', width: 28 },
      { fold: 'maximise', width: 28 },
    ];
    const tight = (n: number) => header(32 + 110 + 50 + 84 - n, { folds: three });
    expect(folded(tight(1))).toEqual(['maximise']);
    expect(folded(tight(29))).toEqual(['maximise', 'split']);
    expect(folded(tight(57))).toEqual<Fold[]>(['maximise', 'split', 'add']);
  });

  it('shortens the active title only when nothing else is left to give', () => {
    const fit = fitHeader(header(32 + 110 + 50 - 10));
    expect(fit.folded.size).toBe(buttons.length);
    expect(fit.squeeze).toBe(10);
    expect([...fit.shown]).toEqual([2]);
  });

  it('needs no overflow count for a lone tab', () => {
    expect(folded(header(32 + 110 + 56, { tabs: [110], active: 0 }))).toEqual(['close', 'popout', 'maximise']);
    expect(fitHeader(header(32 + 100, { tabs: [110], active: 0 })).squeeze).toBe(10);
  });
});
