import type { Layout } from '@tessera/protocol';
import { Menu, MenuContent, MenuTrigger } from '@tessera/ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createDockview, type DockviewApi, type SerializedGridObject } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry, commands } from '../src/commands/registry.ts';
import { PanelsSub } from '../src/frame/PanelsSub.tsx';
import {
  DEFAULT_VIEW,
  defaultChartState,
  layoutsStore,
  putLayout,
  setStageView,
  viewOfDock,
} from '../src/state/layouts.ts';
import { attachWorkspace } from '../src/workspace/controller.ts';
import { edgeGroup, installEdgeChrome, placeOf } from '../src/workspace/dock/edges.ts';
import { closeTile, moveTile, openTile, panelKind } from '../src/workspace/dock/open.ts';
import { chooseFromLibrary, libraryKinds } from '../src/workspace/dock/library.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { tileParams } from '../src/workspace/dock/tileSettings.ts';
import { tileDefinitions } from '../src/workspace/tiles/index.ts';
import { read } from '../src/app/store.ts';

const LAYOUT_ID = 'reopen';

const chart = (n: number) => defaultChartState(`chart-${String(n)}`, `Chart ${String(n)}`, 'QQQ', '5m', null);

const layoutOf = (charts: number): Layout => ({
  id: LAYOUT_ID,
  name: 'Trade',
  revision: 1,
  updatedAt: 0,
  activeChartId: 'chart-1',
  dock: null,
  trade: null,
  charts: Object.fromEntries(Array.from({ length: charts }, (_, i) => [`chart-${String(i + 1)}`, chart(i + 1)])),
});

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = '';
});

function desk(charts = 1): DockviewApi {
  const layout = layoutOf(charts);
  putLayout(layout);
  setStageView(LAYOUT_ID, { ...DEFAULT_VIEW, v: 5 });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api = createDockview(host, {
    defaultRenderer: 'always',
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  buildDockFromLayout(api, layout);
  api.layout(1600, 900);
  const detach = attachWorkspace({
    api,
    layoutId: LAYOUT_ID,
    tools: new Set(),
    reload: () => undefined,
    canSaveDock: () => false,
    allowDockSaves: () => undefined,
  });
  const unchrome = installEdgeChrome(api);
  cleanups.push(() => {
    unchrome();
    detach();
    api.dispose();
  });
  return api;
}

function palette(): CommandRegistry {
  const registry = new CommandRegistry();
  cleanups.push(registerBuiltinCommands(registry, { focusComposer: () => undefined }));
  return registry;
}

const panelOf = (api: DockviewApi, kind: string) => api.panels.find((p) => panelKind(p) === kind);

const panels = () => libraryKinds().filter((d) => d.kind !== 'chart');

function arrangement(api: DockviewApi) {
  return api.panels
    .map((p) => ({
      id: p.id,
      place: placeOf(p.group),
      group: p.group.id,
      index: p.group.panels.indexOf(p),
      size: [p.group.width, p.group.height],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function gridShape(node: SerializedGridObject<{ views: string[] }>): unknown {
  return Array.isArray(node.data) ? node.data.map((n) => gridShape(n)) : node.data.views;
}

const centreShape = (api: DockviewApi) => gridShape(api.toJSON().grid.root);

function onScreen(api: DockviewApi, boxes: Record<string, DOMRect>) {
  for (const [panelId, box] of Object.entries(boxes))
    vi.spyOn(api.getPanel(panelId)!.group.element, 'getBoundingClientRect').mockReturnValue(box);
}

describe('a closed panel comes back without knowing a shortcut', () => {
  it('every panel but the chart has a palette line that brings it back once closed', () => {
    const api = desk();
    const registry = palette();
    const listed = panels();
    expect(listed.map((d) => d.kind).sort()).toEqual([
      'accounts',
      'alerts',
      'analyst',
      'copy',
      'dom',
      'indicators',
      'journal',
      'positions',
      'tape',
      'trade',
    ]);
    expect(
      tileDefinitions()
        .filter((d) => !listed.includes(d))
        .map((d) => d.kind),
    ).toEqual(['chart']);
    for (const def of listed) {
      openTile(def.kind);
      const panel = panelOf(api, def.kind);
      expect(panel, `${def.kind} opens`).toBeDefined();
      expect(closeTile(panel!.id), `${def.kind} closes`).toBe(true);
      expect(panelOf(api, def.kind), `${def.kind} is gone`).toBeUndefined();
      const id = registry
        .search(def.title)
        .slice(0, 7)
        .map((m) => m.command.id)
        .find((c) => c === `tile.show.${def.kind}` || c === `view.${def.kind}`);
      expect(id, `searching ${def.title}`).toBeDefined();
      expect(registry.isEnabled(id!)).toBe(true);
      registry.run(id!);
      expect(panelOf(api, def.kind), `${def.kind} is back`).toBeDefined();
    }
  });

  it('lists each panel once: Trade and Analyst by their keyed line, every other panel by Show <Title>', () => {
    desk();
    const registry = palette();
    for (const def of panels()) {
      const lines = registry
        .list()
        .filter((c) => c.title === `Show ${def.title}` || c.title.startsWith(`${def.title}: show`))
        .map((c) => c.title);
      expect(lines, def.kind).toEqual(
        def.kind === 'trade' || def.kind === 'analyst' ? [`${def.title}: show, focus or hide`] : [`Show ${def.title}`],
      );
    }
    expect(registry.get('tile.show.trade')?.hidden).toBe(true);
    expect(registry.search('show trade')[0]?.command.id).toBe('view.trade');
    expect(registry.search('show analyst')[0]?.command.id).toBe('view.analyst');
  });

  it('opens the Journal panel, not the Journal area, when Journal is typed and Enter pressed', () => {
    const api = desk();
    const registry = palette();
    const first = registry.search('Journal').find((m) => registry.isEnabled(m.command.id));
    expect(first?.command.title).toBe('Show Journal');
    registry.run(first!.command.id);
    expect(panelOf(api, 'journal')).toBeDefined();
  });
});

describe('where a closed panel goes back', () => {
  it('comes back into its old tab of the bottom, the rest of the desk as it was', () => {
    const api = desk();
    const registry = palette();
    openTile('alerts');
    const bottom = edgeGroup(api, 'bottom')!;
    api.getPanel('positions')!.api.moveTo({ group: bottom, position: 'center', index: 2 });
    expect(bottom.panels.map((p) => p.id)).toEqual(['accounts', 'alerts', 'positions']);
    const before = arrangement(api);
    expect(closeTile('positions')).toBe(true);
    expect(api.getPanel('positions')).toBeUndefined();
    registry.run('tile.show.positions');
    expect(arrangement(api)).toEqual(before);
    expect(read(layoutsStore).views[LAYOUT_ID]?.closed).toEqual([]);
  });

  it('comes back beside the chart where it was moved, on the side it stood', () => {
    const api = desk();
    const registry = palette();
    const charts = api.getPanel('chart-1')!.group;
    api.getPanel('positions')!.api.moveTo({ group: charts, position: 'bottom' });
    onScreen(api, { 'chart-1': new DOMRect(0, 0, 800, 450), positions: new DOMRect(0, 450, 800, 450) });
    const before = centreShape(api);
    closeTile('positions');
    expect(centreShape(api)).not.toEqual(before);
    registry.run('tile.show.positions');
    expect(placeOf(api.getPanel('positions')!.group)).toBe('centre');
    expect(centreShape(api)).toEqual(before);
  });

  it('brings a closed DOM back on its chart’s left with the instrument it was pinned to', () => {
    const api = desk();
    const registry = palette();
    const id = openTile('dom', { params: { instrument: 'ESZ6.CME' } })!;
    api.getPanel(id)!.api.moveTo({ group: api.getPanel('chart-1')!.group, position: 'left' });
    onScreen(api, { [id]: new DOMRect(0, 0, 264, 900), 'chart-1': new DOMRect(264, 0, 800, 900) });
    const before = centreShape(api);
    closeTile(id);
    expect(api.getPanel(id)).toBeUndefined();
    registry.run('tile.show.dom');
    const dom = api.getPanel(id)!;
    expect(tileParams<{ instrument: string }>(dom.api).instrument).toBe('ESZ6.CME');
    expect(centreShape(api)).toEqual(before);
    expect(api.panels.filter((p) => panelKind(p) === 'dom')).toHaveLength(1);
  });

  it('comes back at its home when the place it left is gone', () => {
    const api = desk(2);
    const registry = palette();
    moveTile('positions', 'centre');
    expect(placeOf(api.getPanel('positions')!.group)).toBe('centre');
    closeTile('positions');
    const [record] = read(layoutsStore).views[LAYOUT_ID]!.closed;
    const beside = api.panels.find((p) => p.group.id === record!.place.referenceGroupId)!;
    expect(panelKind(beside)).toBe('chart');
    closeTile(beside.id);
    registry.run('tile.show.positions');
    expect(placeOf(api.getPanel('positions')!.group)).toBe('bottom');
  });

  it('is kept in the dock’s view as tessera.closed, a record it cannot read dropped', () => {
    const view = viewOfDock({
      tessera: {
        closed: [
          {
            panelId: 'dom-1',
            kind: 'dom',
            place: { referenceGroupId: 'g-1', direction: 'right' },
            params: { instrument: 'ESZ6.CME' },
          },
          {
            panelId: 'positions',
            kind: 'positions',
            place: { referenceGroupId: 'edge-bottom', direction: 'within', index: 1 },
          },
          { panelId: 'alerts', kind: 'alerts', place: { referenceGroupId: 'edge-bottom', direction: 'sideways' } },
          { panelId: 'journal', kind: 'journal' },
          { kind: 'copy', place: { referenceGroupId: 'g-1', direction: 'within' } },
        ],
      },
    });
    expect(view.closed).toEqual([
      {
        panelId: 'dom-1',
        kind: 'dom',
        place: { referenceGroupId: 'g-1', direction: 'right' },
        params: { instrument: 'ESZ6.CME' },
      },
      {
        panelId: 'positions',
        kind: 'positions',
        place: { referenceGroupId: 'edge-bottom', direction: 'within', index: 1 },
      },
    ]);
    expect(viewOfDock({ tessera: {} }).closed).toEqual([]);
  });
});

describe('every panel closes, and the library brings it back', () => {
  it('closes an edge’s last tab and the last chart instead of collapsing or refusing', () => {
    const api = desk();
    const registry = palette();
    expect(closeTile('trade')).toBe(true);
    expect(closeTile('analyst')).toBe(true);
    expect(edgeGroup(api, 'right')!.panels).toHaveLength(0);
    expect(api.isEdgeGroupVisible('right')).toBe(false);
    expect(closeTile('chart-1')).toBe(true);
    expect(api.panels.filter((p) => panelKind(p) === 'chart')).toHaveLength(0);
    expect(registry.get('tile.show.analyst')?.hint?.()).toBeNull();
    registry.run('tile.show.analyst');
    expect(placeOf(api.getPanel('analyst')!.group)).toBe('right');
    expect(api.isEdgeGroupVisible('right')).toBe(true);
    expect(registry.get('tile.show.analyst')?.hint?.()).toBe('Right side');
  });

  it('adds a closed panel into the zone whose + was pressed, and focuses an open one where it is', () => {
    const api = desk();
    const bottom = edgeGroup(api, 'bottom')!;
    chooseFromLibrary('journal', bottom);
    expect(api.getPanel('journal')!.group.id).toBe(bottom.id);
    chooseFromLibrary('trade', bottom);
    expect(placeOf(api.getPanel('trade')!.group)).toBe('right');
    expect(api.panels.filter((p) => panelKind(p) === 'trade')).toHaveLength(1);
    expect(edgeGroup(api, 'right')!.activePanel?.id).toBe('trade');
    const right = edgeGroup(api, 'right')!;
    chooseFromLibrary('dom', right);
    const dom = api.panels.find((p) => panelKind(p) === 'dom')!;
    expect(dom.group.id).toBe(right.id);
  });
});

describe('the Panels list in the app menu', () => {
  it('lists every panel with where it is; picking a closed one reopens it where it was', () => {
    const api = desk();
    cleanups.push(registerBuiltinCommands(commands, { focusComposer: () => undefined }));
    openTile('alerts');
    const bottom = edgeGroup(api, 'bottom')!;
    api.getPanel('positions')!.api.moveTo({ group: bottom, position: 'center', index: 2 });
    closeTile('positions');
    render(
      <Menu open>
        <MenuTrigger asChild>
          <button type="button">Menu</button>
        </MenuTrigger>
        <MenuContent>
          <PanelsSub />
        </MenuContent>
      </Menu>,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Panels' }));
    const rows = screen.getAllByRole('menuitem').filter((r) => r.textContent !== 'Panels');
    const words = (row: HTMLElement) => row.textContent.replace(/\s+/g, ' ').trim();
    expect(rows.map(words)).toEqual([
      'ChartCentreCtrl+T',
      'DOM',
      'Time & Sales',
      'Journal',
      'Trade copier',
      'Indicators',
      'TradeRight sideCtrl+E',
      'AnalystRight sideCtrl+J',
      'Positions',
      'AccountsBottomCtrl+Alt+A',
      'AlertsBottom',
    ]);
    fireEvent.click(rows.find((r) => r.textContent.startsWith('Positions'))!);
    expect(bottom.panels.map((p) => p.id)).toEqual(['accounts', 'alerts', 'positions']);
  });
});
