import type { ScreenArea } from '@tessera/bridge';
import type { DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viewOfDock, type PopoutRecord, putLayout, setStageView, layoutsStore } from '../src/state/layouts.ts';
import { attachWorkspace } from '../src/workspace/controller.ts';
import {
  popoutBounds,
  resetPopoutWatches,
  resumePopouts,
  screenOf,
  standsOnScreens,
} from '../src/workspace/dock/popouts.ts';
import { returnToOf } from '../src/workspace/dock/returnPlace.ts';
import { newWorkspaceLayout } from '../src/workspace/layouts.ts';
import { read } from '../src/app/store.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import type { FakeBridge } from './support/runtime.tsx';

const box = (id: string, place: 'centre' | 'right' | 'floating', others: number, left: number, top = 40) => ({
  id,
  place,
  others,
  index: 0,
  rect: { left, top, width: 400, height: 600 },
});

describe('pop out (spec §2.5)', () => {
  it('sends a tile that shares its group (or sits in an edge) back into that group, at its tab', () => {
    expect(returnToOf({ ...box('g-1', 'centre', 1, 0), index: 1 }, [])).toEqual({
      referenceGroupId: 'g-1',
      direction: 'within',
      index: 1,
    });
    expect(returnToOf(box('edge-right', 'right', 0, 1200), [])).toEqual({
      referenceGroupId: 'edge-right',
      direction: 'within',
      index: 0,
    });
  });

  it('sends a lone chart back beside its nearest neighbour, on the side it was', () => {
    const own = box('g-2', 'centre', 0, 400);
    const left = box('g-1', 'centre', 0, 0);
    const far = box('g-3', 'centre', 0, 1200);
    expect(returnToOf(own, [left, own, far])).toEqual({ referenceGroupId: 'g-1', direction: 'right' });
    expect(returnToOf(box('g-0', 'centre', 0, 0), [box('g-0', 'centre', 0, 0), own])).toEqual({
      referenceGroupId: 'g-2',
      direction: 'left',
    });
    expect(returnToOf(own, [own])).toBeNull();
  });

  it('opens a pop-out over the app window at its size, never larger than the app window’s screen', () => {
    const app = { x: 120, y: 80, width: 1600, height: 1000 };
    const laptop = { name: 'Built-in', x: 0, y: 0, width: 1024, height: 768 };
    expect(popoutBounds(app, { name: 'Main', x: 0, y: 0, width: 1920, height: 1080 })).toEqual(app);
    expect(popoutBounds({ x: 0, y: 0, width: 1100, height: 768 }, laptop)).toEqual({
      x: 0,
      y: 0,
      width: 1024,
      height: 768,
    });
    expect(popoutBounds(app, null)).toEqual(app);
  });

  it('remembers the screen a window stands on, and docks it when that screen is gone', () => {
    const main = { name: 'Main', x: 0, y: 0, width: 1920, height: 1080 };
    const side = { name: 'Side', x: 1920, y: 0, width: 1920, height: 1080 };
    const bounds = { x: 2100, y: 100, width: 800, height: 600 };
    expect(screenOf(bounds, [main, side])?.name).toBe('Side');
    expect(screenOf({ x: 1700, y: 0, width: 800, height: 600 }, [main, side])?.name).toBe('Side');
    const record: PopoutRecord = { panelId: 'dom', kind: 'dom', bounds, monitor: 'Side', returnTo: null };
    expect(standsOnScreens(record, [main, side])).toBe(true);
    expect(standsOnScreens(record, [main])).toBe(false);
    expect(standsOnScreens({ ...record, monitor: null }, [main])).toBe(false);
    expect(standsOnScreens(record, null)).toBe(true);
    expect(standsOnScreens({ ...record, bounds: null }, [main])).toBe(true);
  });

  it('keeps a popped chart’s own params in the workspace view, to give back when it returns', () => {
    const view = viewOfDock({
      tessera: {
        v: 2,
        popouts: [
          {
            panelId: 'chart-2',
            kind: 'chart',
            bounds: { x: 1, y: 2, width: 800, height: 600 },
            returnTo: { referenceGroupId: 'g-1', direction: 'right' },
            params: { link: '2' },
          },
        ],
      },
    });
    expect(view.popouts[0]).toMatchObject({ panelId: 'chart-2', params: { link: '2' } });
  });
});

describe('pop out across workspaces', () => {
  afterEach(() => resetPopoutWatches());

  function fakeBridge(screens: ScreenArea[] | null = null) {
    const opened: string[] = [];
    const closed: string[] = [];
    const closers = new Map<string, () => void>();
    const bridge: FakeBridge = {
      openWindow: (tile) => {
        opened.push(tile.id);
        return Promise.resolve(true);
      },
      onWindowClosed: (id, onClose) => {
        closers.set(id, () => {
          closers.delete(id);
          onClose();
        });
        return () => closers.delete(id);
      },
      closeWindow: (id) => {
        closed.push(id);
        return Promise.resolve();
      },
      screens: () => Promise.resolve(screens),
      windowBounds: () => Promise.resolve(null),
      thisWindowBounds: () => Promise.resolve(null),
    };
    return {
      bridge,
      opened,
      closed,
      watching: (id: string) => closers.has(id),
      close: (id: string) => closers.get(id)?.(),
    };
  }

  function fakeDock() {
    const added: string[] = [];
    const api = {
      getPanel: () => undefined,
      groups: [],
      panels: [],
      addPanel: (p: { id: string }) => added.push(p.id),
      getEdgeGroup: () => undefined,
      toJSON: () => ({}),
    } as unknown as DockviewApi;
    return { api, added };
  }

  const record: PopoutRecord = { panelId: 'chart-1', kind: 'chart', bounds: null, monitor: null, returnTo: null };
  const mount = (layoutId: string, api: DockviewApi) =>
    attachWorkspace({
      api,
      layoutId,
      tools: new Set(),
      reload: () => undefined,
      canSaveDock: () => true,
      allowDockSaves: () => undefined,
      tileWindows: true,
    });

  it('opens a workspace’s windows as it shows and closes them as it leaves, keeping them in the workspace', async () => {
    for (const id of ['ws-a', 'ws-b']) {
      putLayout(newWorkspaceLayout(id, 0, { instrument: 'NQ' }));
      setStageView(id, { popouts: [record] });
    }
    const host = fakeBridge();
    fakeRuntime({ bridge: host.bridge });
    const a = fakeDock();
    let detach = mount('ws-a', a.api);
    let stop = resumePopouts('ws-a');
    await vi.waitFor(() => expect(host.watching('pop-ws-a-chart-1')).toBe(true));
    expect(host.opened).toEqual(['pop-ws-a-chart-1']);
    stop(true);
    detach();
    expect(host.closed).toEqual(['pop-ws-a-chart-1']);
    expect(read(layoutsStore).views['ws-a']?.popouts).toHaveLength(1);
    const b = fakeDock();
    detach = mount('ws-b', b.api);
    stop = resumePopouts('ws-b');
    await vi.waitFor(() => expect(host.watching('pop-ws-b-chart-1')).toBe(true));
    expect(host.opened).toEqual(['pop-ws-a-chart-1', 'pop-ws-b-chart-1']);
    stop(true);
    detach();
  });

  it('sends a panel whose window the user closed to the library, never back onto the desk', async () => {
    putLayout(newWorkspaceLayout('ws-c', 0));
    const dom: PopoutRecord = {
      panelId: 'dom',
      kind: 'dom',
      bounds: null,
      monitor: null,
      returnTo: { referenceGroupId: 'g-1', direction: 'right' },
      params: { link: '2' },
    };
    setStageView('ws-c', { popouts: [dom] });
    const host = fakeBridge();
    fakeRuntime({ bridge: host.bridge });
    const c = fakeDock();
    const detach = mount('ws-c', c.api);
    const stop = resumePopouts('ws-c');
    await vi.waitFor(() => expect(host.watching('pop-ws-c-dom')).toBe(true));
    host.close('pop-ws-c-dom');
    await vi.waitFor(() => expect(read(layoutsStore).views['ws-c']?.popouts).toEqual([]));
    expect(c.added).toEqual([]);
    const view = read(layoutsStore).views['ws-c'];
    expect(view?.closed).toEqual([
      { panelId: 'dom', kind: 'dom', place: { referenceGroupId: 'g-1', direction: 'right' }, params: { link: '2' } },
    ]);
    stop(true);
    detach();
  });

  it('docks a window whose screen is gone instead of opening it off screen', async () => {
    putLayout(newWorkspaceLayout('ws-d', 0, { instrument: 'NQ' }));
    setStageView('ws-d', {
      popouts: [{ ...record, bounds: { x: 2100, y: 100, width: 800, height: 600 }, monitor: 'Side' }],
    });
    const host = fakeBridge([{ name: 'Main', x: 0, y: 0, width: 1920, height: 1080 }]);
    fakeRuntime({ bridge: host.bridge });
    const d = fakeDock();
    const detach = mount('ws-d', d.api);
    const stop = resumePopouts('ws-d');
    await vi.waitFor(() => expect(d.added).toEqual(['chart-1']));
    expect(host.opened).toEqual([]);
    expect(read(layoutsStore).views['ws-d']?.popouts).toEqual([]);
    stop(true);
    detach();
  });
});
