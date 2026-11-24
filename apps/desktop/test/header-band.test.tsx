import type { LayoutListOutput } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analystAway } from '../src/analyst/away.ts';
import { IDLE } from '../src/analyst/activity.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime, type FakeBridge } from './support/runtime.tsx';
import { AreaRail } from '../src/areas/AreaRail.tsx';
import { areaStore } from '../src/areas/store.ts';
import { AppMenu } from '../src/frame/AppMenu.tsx';
import { closeFeedback, feedbackStore } from '../src/feedback/store.ts';
import { openAppMenu, appMenuStore } from '../src/frame/appMenuStore.ts';
import { WindowControls } from '../src/shell/WindowControls.tsx';
import { layoutCreated, takeSeededLayout } from '../src/state/layouts.ts';
import { uiStore } from '../src/state/ui.ts';
import { markBand, placeInBand } from '../src/workspace/dock/headerBand.ts';
import { registerTile } from '../src/workspace/tiles/registry.ts';
import { patch, read } from '../src/app/store.ts';

const LIST: LayoutListOutput = {
  activeId: 'default',
  layouts: [
    {
      id: 'default',
      name: 'Day · QQQ/NQ',
      revision: 3,
      updatedAt: 0,
      charts: [
        { tileId: 'c1', instrument: 'QQQ', timeframe: '5m' },
        { tileId: 'c2', instrument: 'NQZ6.CME', timeframe: '1m' },
      ],
    },
    {
      id: 'scalp',
      name: 'Scalp',
      revision: 1,
      updatedAt: 0,
      charts: [{ tileId: 'c1', instrument: 'ESZ6.CME', timeframe: '1m' }],
    },
  ],
};

type Win = { trafficLights: boolean } | null;

function mount(children: ReactNode, win: Win = null) {
  const { client } = answeringClient({ 'layout.list': () => LIST });
  const controls = win
    ? {
        ...win,
        minimize: () => Promise.resolve(),
        toggleMaximize: () => Promise.resolve(),
        toggleFullscreen: () => Promise.resolve(),
        close: () => Promise.resolve(),
        startDragging: () => Promise.resolve(),
        isMaximized: () => Promise.resolve(false),
        onResized: () => () => undefined,
        focus: () => Promise.resolve(),
        setAppearance: () => Promise.resolve(),
      }
    : null;
  const bridge: FakeBridge = { kind: win ? 'tauri' : 'browser', window: controls };
  setTestServices(client, bridge);
  seedTools(['layout.list']);
  return render(
    <TestRuntime client={client} bridge={bridge}>
      <TooltipProvider>{children}</TooltipProvider>
    </TestRuntime>,
  );
}

beforeEach(() => {
  patch(uiStore, { workspace: 'default' });
  patch(areaStore, { area: 'desk', previous: null });
  patch(appMenuStore, { open: false, sub: null });
});
afterEach(cleanup);

describe('the app menu', () => {
  it('is the logo, named by the shown workspace; its head names it once, then the workspaces’ verbs, Arrange and Send feedback', async () => {
    mount(<AppMenu />);
    const logo = await screen.findByRole('button', { name: 'Tessera menu: Day · QQQ/NQ' });
    expect(logo.querySelector('i[data-size]')).not.toBeNull();
    fireEvent.keyDown(logo, { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(menu.querySelector('.app-menu-head .nm')?.textContent).toBe('Day · QQQ/NQ');
    expect(menu.querySelector('.app-menu-head .br')?.textContent).toBe('QQQ 5m · NQ Z6 1m');
    expect(menu.textContent.split('Day · QQQ/NQ').length).toBe(2);
    const rows = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
      (r) => r.getAttribute('aria-label') ?? r.textContent,
    );
    expect(rows).toEqual([
      'Switch workspace',
      'New workspace',
      'New from preset',
      'SaveCtrl+S',
      'Save as…',
      'Rename…',
      'Reset to default',
      'Delete…the default',
      'Panels',
      'Arrange charts: 1 chart',
      'Send feedback…Ctrl+Shift+/',
    ]);
    expect(screen.getByRole('menuitem', { name: /^Delete…/ }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Send feedback…/ }));
    expect(read(feedbackStore).open).toBe(true);
    closeFeedback();
  });

  it('New from preset shows the new workspace at once, while the runtime saves it, and goes back if it refuses', async () => {
    patch(uiStore, { recentSymbols: ['NQ'] });
    const saves: { layoutId: string; name: string }[] = [];
    let answer!: (result: unknown) => void;
    const refused = (code: string, message: string) => ({
      ok: false,
      status: 'error',
      output: null,
      error: { code, message, details: null, retryable: false },
    });
    const client = {
      request: (method: string, params?: { name?: string; input?: unknown }) => {
        if (method !== 'tools.invoke') return new Promise(() => undefined);
        if (params?.name === 'layout.list') return Promise.resolve({ ok: true, status: 'ok', output: LIST });
        if (params?.name === 'settings.get') return Promise.resolve(refused('unavailable', 'not now'));
        if (params?.name === 'layout.save') {
          saves.push(params.input as { layoutId: string; name: string });
          return new Promise((resolve) => (answer = resolve));
        }
        return new Promise(() => undefined);
      },
    };
    const bridge: FakeBridge = { kind: 'browser', window: null };
    setTestServices(client, bridge);
    seedTools(['layout.list', 'layout.save', 'settings.get']);
    render(
      <TestRuntime client={client} bridge={bridge}>
        <TooltipProvider>
          <AppMenu />
        </TooltipProvider>
      </TestRuntime>,
    );
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Tessera menu: Day · QQQ/NQ' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'New from preset' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Scalp/ }));
    await vi.waitFor(() => expect(saves).toHaveLength(1));
    const id = saves[0]!.layoutId;
    expect(saves[0]!.name).toBe('Scalp 2');
    expect(read(uiStore).workspace).toBe(id);
    expect(layoutCreated(id)).not.toBeNull();
    expect(takeSeededLayout(id)?.name).toBe('Scalp 2');
    answer(refused('not_found', 'unknown instrument NQ'));
    await vi.waitFor(() => expect(read(uiStore).workspace).toBe('default'));
    expect(await screen.findByText('Scalp opens on NQ, which no connection serves now')).toBeDefined();
    await vi.waitFor(() => expect(layoutCreated(id)).toBeNull());
  });

  it('⌘K’s Switch workspace… opens it at the workspaces, the shown one checked; a pick shows it', async () => {
    mount(<AppMenu />);
    await screen.findByRole('button', { name: 'Tessera menu: Day · QQQ/NQ' });
    act(() => openAppMenu('workspaces'));
    const list = screen.getAllByRole('menuitemradio');
    expect(list.map((r) => r.querySelector('.nm')?.textContent)).toEqual(['Day · QQQ/NQ', 'Scalp']);
    expect(list.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(list[0]!.textContent).toContain('default');
    fireEvent.click(list[1]!);
    expect(read(uiStore).workspace).toBe('scalp');
  });

  it('⌘K’s Arrange charts… opens it at the arrangements, as pictures with Link all charts and Share interval', () => {
    mount(<AppMenu />);
    act(() => openAppMenu('arrange'));
    const pics = screen.getAllByRole('menuitemradio');
    expect(pics.map((p) => p.getAttribute('aria-label'))).toHaveLength(6);
    expect(screen.getByRole('menuitemcheckbox', { name: 'Link all charts' })).toBeTruthy();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Share interval' })).toBeTruthy();
  });
});

describe('the rail’s top cell', () => {
  it('is the band’s first cell: a drag region holding the logo; no clock, no market status', () => {
    const { container } = mount(<AreaRail />, { trafficLights: false });
    const head = container.querySelector('.ar-rail-head')!;
    expect(head.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(head.querySelector('.app-menu-btn')).not.toBeNull();
    expect(container.querySelector('.ar-rail-brand')).toBeNull();
    expect(container.textContent).not.toMatch(/\bET\b|closed|open|close \d/i);
    expect(screen.getByRole('navigation', { name: 'Areas' }).contains(head)).toBe(false);
  });

  it('on macOS is the traffic lights’ cell: empty, and the logo stands under it', () => {
    const { container } = mount(<AreaRail />, { trafficLights: true });
    expect(container.querySelector('.ar-rail-head')?.childElementCount).toBe(0);
    expect(container.querySelector('.ar-rail-brand .app-menu-btn')).not.toBeNull();
  });
});

describe('an area’s tile dragged from the rail', () => {
  it('brings the desk forward once the drag has started, and goes back when nothing took the tile', async () => {
    registerTile({ kind: 'analyst', title: 'Analyst', icon: 'analyst', component: () => null });
    mount(<AreaRail />);
    act(() => patch(areaStore, { area: 'journal' }));
    const agents = document.querySelector('[data-area="agents"]')!;
    fireEvent.dragStart(agents, { dataTransfer: { setData: () => undefined, setDragImage: () => undefined } });
    expect(read(areaStore).area).toBe('journal');
    await act(() => new Promise((done) => setTimeout(done, 0)));
    expect(read(areaStore).area).toBe('desk');
    fireEvent.dragEnd(agents);
    expect(read(areaStore).area).toBe('journal');
  });
});

describe('the window’s controls', () => {
  it('draw in an undecorated window, never under macOS’s traffic lights nor in a browser', () => {
    const custom = mount(<WindowControls />, { trafficLights: false });
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Minimise',
      'Maximise',
      'Close',
    ]);
    custom.unmount();
    expect(mount(<WindowControls />, { trafficLights: true }).container.childElementCount).toBe(0);
    cleanup();
    expect(mount(<WindowControls />).container.childElementCount).toBe(0);
  });
});

describe('the header band', () => {
  const dock = { top: 0, right: 1536 };

  it('holds the rows that start at the dock’s top; the one under the controls keeps their room clear', () => {
    expect(placeInBand(dock, { top: 0, left: 0, right: 572, vertical: false }, 88)).toEqual({
      inBand: true,
      end: 0,
      stripUnder: false,
    });
    expect(placeInBand(dock, { top: 0.5, left: 1144, right: 1536, vertical: false }, 88)).toEqual({
      inBand: true,
      end: 88,
      stripUnder: false,
    });
    expect(placeInBand(dock, { top: 561, left: 1144, right: 1536, vertical: false }, 88).inBand).toBe(false);
    expect(placeInBand(dock, { top: 0, left: 572, right: 1504, vertical: false }, 88).end).toBe(56);
    expect(placeInBand(dock, { top: 0, left: 1504, right: 1536, vertical: true }, 88).stripUnder).toBe(true);
    expect(placeInBand(dock, { top: 0, left: 1144, right: 1536, vertical: false }, 0).end).toBe(0);
  });

  function row(parent: HTMLElement, box: { top: number; left: number; right: number }, cls = ''): HTMLElement {
    const r = document.createElement('div');
    r.className = `dv-tabs-and-actions-container ${cls}`.trim();
    const tab = document.createElement('div');
    tab.className = 'dv-tab';
    const empty = document.createElement('div');
    empty.className = 'dv-void-container';
    r.append(tab, empty);
    r.getBoundingClientRect = () =>
      ({ top: box.top, left: box.left, right: box.right, width: box.right - box.left, height: 32 }) as DOMRect;
    parent.appendChild(r);
    return r;
  }

  it('makes the empty part of each top row the window’s drag region, never its tabs, nor a lower or floating row', () => {
    const root = document.createElement('div');
    root.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1536, width: 1536, height: 900 }) as DOMRect;
    const chart = row(root, { top: 0, left: 0, right: 760 });
    const trade = row(root, { top: 0, left: 761, right: 1536 });
    const analyst = row(root, { top: 561, left: 761, right: 1536 });
    const float = document.createElement('div');
    float.className = 'dv-resize-container';
    root.appendChild(float);
    const floating = row(float, { top: 0, left: 300, right: 600 });
    markBand(root, 88);
    const drag = (r: HTMLElement) => r.querySelector('.dv-void-container')!.hasAttribute('data-tauri-drag-region');
    expect([chart, trade, analyst, floating].map((r) => r.hasAttribute('data-band'))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect([chart, trade, analyst, floating].map(drag)).toEqual([true, true, false, false]);
    expect(chart.querySelector('.dv-tab')!.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(trade.style.getPropertyValue('--band-end')).toBe('88px');
    expect(chart.hasAttribute('data-band-end')).toBe(false);
    trade.remove();
    analyst.remove();
    const side = document.createElement('div');
    side.className = 'dv-groupview';
    side.getBoundingClientRect = () => ({ top: 0, left: 1504, right: 1536, width: 32, height: 900 }) as DOMRect;
    root.appendChild(side);
    const strip = row(side, { top: 32, left: 1504, right: 1536 }, 'dv-groupview-header-vertical');
    chart.getBoundingClientRect = () => ({ top: 0, left: 0, right: 1503, width: 1503, height: 32 }) as DOMRect;
    markBand(root, 88);
    expect(side.hasAttribute('data-band-under')).toBe(true);
    expect(strip.querySelector('.dv-void-container')!.hasAttribute('data-tauri-drag-region')).toBe(false);
    expect(chart.style.getPropertyValue('--band-end')).toBe('55px');
    strip.classList.remove('dv-groupview-header-vertical');
    markBand(root, 88);
    expect(side.hasAttribute('data-band-under')).toBe(false);
  });
});

describe('the analyst out of view', () => {
  const working = { phase: 'working' as const, words: 'Reading NQ 5m bars', since: 0 };

  it('is carried by the rail’s Agents item: what it does, what needs you, an unseen answer; nothing while shown', () => {
    expect(analystAway({ activity: working, count: 2, unread: false }, false)).toEqual({
      words: 'Reading NQ 5m bars · 2 need you',
      working: true,
      count: 2,
      unread: false,
    });
    expect(analystAway({ activity: IDLE, count: 0, unread: true }, false)).toEqual({
      words: 'Answered',
      working: false,
      count: 0,
      unread: true,
    });
    expect(analystAway({ activity: working, count: 1, unread: true }, true)).toBeNull();
    expect(analystAway({ activity: IDLE, count: 0, unread: false }, false)).toBeNull();
  });
});
