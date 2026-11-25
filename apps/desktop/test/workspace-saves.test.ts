import type { Layout } from '@tessera/protocol';
import { createDockview, type DockviewApi } from 'dockview-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultChartState, layoutsStore, putLayout, seedLayout, takeSeededLayout } from '../src/state/layouts.ts';
import { read } from '../src/app/store.ts';
import {
  attachWorkspace,
  forgetLayoutRead,
  layoutSaved,
  mountWorkspace,
  readLayout,
  saveLayout,
  workspaceContext,
  type WorkspaceContext,
} from '../src/workspace/controller.ts';
import { buildDockFromLayout } from '../src/workspace/layouts.ts';
import { cleanupsAfterEach } from './support/cleanups.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import '../src/workspace/tiles/index.ts';

afterEach(() => {
  document.body.innerHTML = '';
});
const cleanups = cleanupsAfterEach();

function workspace(id: string, instrument: string, revision = 1): WorkspaceContext {
  const layout: Layout = {
    id,
    name: id,
    revision,
    updatedAt: 0,
    activeChartId: 'chart-1',
    dock: null,
    trade: null,
    charts: { 'chart-1': defaultChartState('chart-1', 'Chart 1', instrument, '5m', null) },
  };
  putLayout(layout);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const api: DockviewApi = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  });
  buildDockFromLayout(api, layout);
  return {
    api,
    layoutId: id,
    tools: new Set(['layout.save']),
    reload: () => undefined,
    canSaveDock: () => true,
    allowDockSaves: () => undefined,
  };
}

describe('saves of the workspaces kept mounted', () => {
  it('saves each mounted workspace’s own layout, whichever is shown', async () => {
    const saved: { layoutId: string; instrument: string }[] = [];
    let revision = 1;
    fakeRuntime({
      answers: {
        'layout.save': (input) => {
          const layoutId = input.layoutId ?? 'default';
          saved.push({ layoutId, instrument: input.charts!['chart-1']!.instrument });
          return { layoutId, revision: ++revision };
        },
      },
    });
    const shown = workspace('desk', 'NQZ6.CME');
    const kept = workspace('scalp', 'ESZ6.CME');
    cleanups.push(mountWorkspace(kept), attachWorkspace(shown));
    expect(workspaceContext()).toBe(shown);
    await saveLayout(kept);
    await saveLayout();
    expect(saved).toEqual([
      { layoutId: 'scalp', instrument: 'ESZ6.CME' },
      { layoutId: 'desk', instrument: 'NQZ6.CME' },
    ]);
  });

  it('runs one save at a time per workspace, and none once its dock is gone', async () => {
    const asked: string[] = [];
    const rt = fakeRuntime();
    const a = workspace('a', 'NQZ6.CME');
    const b = workspace('b', 'ESZ6.CME');
    const unmountB = mountWorkspace(b);
    cleanups.push(attachWorkspace(a));
    const first = saveLayout(a);
    const again = saveLayout(a);
    const other = saveLayout(b);
    await Promise.resolve();
    for (const c of rt.toolCalls('layout.save')) asked.push((c.input as { layoutId: string }).layoutId);
    expect(asked).toEqual(['a', 'b']);
    rt.toolCalls('layout.save')[1]!.ok({ layoutId: 'b', revision: 2 });
    await other;
    rt.toolCalls('layout.save')[0]!.ok({ layoutId: 'a', revision: 2 });
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.toolCalls('layout.save')).toHaveLength(3);
    rt.toolCalls('layout.save')[2]!.ok({ layoutId: 'a', revision: 3 });
    await Promise.all([first, again, layoutSaved()]);
    unmountB();
    await saveLayout(b);
    expect(rt.toolCalls('layout.save')).toHaveLength(3);
  });

  it('still sends a save asked for while one was on its way, when that one fails', async () => {
    const rt = fakeRuntime();
    const a = workspace('a', 'NQZ6.CME');
    cleanups.push(attachWorkspace(a));
    const first = saveLayout(a);
    const again = saveLayout(a);
    await Promise.resolve();
    expect(rt.toolCalls('layout.save')).toHaveLength(1);
    rt.toolCalls('layout.save')[0]!.fail('internal', 'The disk is full');
    await vi.waitFor(() => expect(rt.toolCalls('layout.save')).toHaveLength(2));
    rt.toolCalls('layout.save')[1]!.ok({ layoutId: 'a', revision: 2 });
    await Promise.all([first, again]);
  });

  it('holds the saves of a workspace the runtime is still making until it is made, then saves on its revision', async () => {
    const rt = fakeRuntime();
    const layout: Layout = {
      id: 'made',
      name: 'Scalp',
      revision: 0,
      updatedAt: 0,
      activeChartId: 'chart-1',
      dock: null,
      trade: null,
      charts: { 'chart-1': defaultChartState('chart-1', 'Chart 1', 'NQZ6.CME', '1m', null) },
    };
    let made!: (out: { revision: number }) => void;
    seedLayout(layout, new Promise((resolve) => (made = resolve)));
    expect(takeSeededLayout('made')).toBe(layout);
    expect(takeSeededLayout('made')).toBeNull();
    const ctx = workspace('made', 'NQZ6.CME', 0);
    cleanups.push(attachWorkspace(ctx));
    const saving = saveLayout(ctx);
    let settled = false;
    void layoutSaved().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(rt.toolCalls('layout.save')).toHaveLength(0);
    expect(settled).toBe(false);
    made({ revision: 1 });
    await vi.waitFor(() => expect(rt.toolCalls('layout.save')).toHaveLength(1));
    expect(read(layoutsStore).layouts.made?.revision).toBe(1);
    expect(rt.toolCalls('layout.save')[0]!.input).toMatchObject({ layoutId: 'made', expectedRevision: 1 });
    rt.toolCalls('layout.save')[0]!.ok({ layoutId: 'made', revision: 2 });
    await saving;
    await vi.waitFor(() => expect(settled).toBe(true));
  });
});

describe('reading a workspace’s layout', () => {
  const stored = (revision: number): Layout => ({
    id: 'a',
    name: 'a',
    revision,
    updatedAt: 0,
    activeChartId: null,
    dock: null,
    trade: null,
    charts: {},
  });

  it('takes only the newest read, whichever answers last, and none once a newer load has begun', async () => {
    const rt = fakeRuntime();
    const older = readLayout('a');
    const newer = readLayout('a');
    await vi.waitFor(() => expect(rt.toolCalls('layout.get')).toHaveLength(2));
    rt.toolCalls('layout.get')[1]!.ok(stored(3));
    rt.toolCalls('layout.get')[0]!.ok(stored(2));
    expect(await newer).toMatchObject({ kind: 'done', value: { revision: 3 } });
    expect(await older).toEqual({ kind: 'superseded' });
    const dropped = readLayout('a');
    forgetLayoutRead('a');
    expect(await dropped).toEqual({ kind: 'superseded' });
  });
});

describe('a save once the last chart has closed', () => {
  it('sends no charts and names no active chart', async () => {
    const rt = fakeRuntime();
    const ctx = workspace('emptied', 'NQZ6.CME');
    cleanups.push(attachWorkspace(ctx));
    ctx.api.getPanel('chart-1')!.api.close();
    const saving = saveLayout(ctx);
    await Promise.resolve();
    const [save] = rt.toolCalls('layout.save');
    expect(save!.input).toMatchObject({ layoutId: 'emptied', charts: {} });
    expect(save!.input).not.toHaveProperty('activeChartId');
    save!.ok({ layoutId: 'emptied', revision: 2 });
    await saving;
  });
});
