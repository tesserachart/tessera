import type { AgentSessionSummary } from '@tessera/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSession, renameSession, stopFromCommand } from '../src/analyst/actions.ts';
import { analystStore, applySessions, selectSession } from '../src/analyst/analystStore.ts';
import { recheckProviders } from '../src/areas/agents/providers.ts';
import { makeStore, patch, read } from '../src/app/store.ts';
import { putLayout, setStageView, type PopoutRecord } from '../src/state/layouts.ts';
import { attachWorkspace } from '../src/workspace/controller.ts';
import { deskToasts } from '../src/workspace/dock/deskToasts.ts';
import { resetPopoutWatches, resumePopouts } from '../src/workspace/dock/popouts.ts';
import { newWorkspaceLayout } from '../src/workspace/layouts.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import type { DockviewApi } from 'dockview-react';

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'codex',
  model: 'gpt-5',
  mode: 'supervised',
  status: 'running',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const notices = () =>
  deskToasts
    .getSnapshot()
    .filter((t) => t.state === 'open')
    .map((t) => ({ tone: t.tone, title: t.title, detail: t.detail }));

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  deskToasts.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  deskToasts.clear();
  vi.restoreAllMocks();
});

describe('an analyst session the runtime will not change', () => {
  it('says the rename failed with the runtime’s reason, and the old title comes back', async () => {
    const rt = fakeRuntime();
    applySessions({ type: 'snapshot', sessions: [session()] });
    const done = renameSession('s_1', 'ES open');
    expect(read(analystStore).sessions?.[0]?.title).toBe('ES open');
    rt.pending('agent.rename_session').fail('not_found', 'That session is gone.');
    await done;
    expect(read(analystStore).sessions?.[0]?.title).toBe('NQ gamma plan');
    expect(notices()).toEqual([
      { tone: 'err', title: 'The session could not be renamed', detail: 'That session is gone.' },
    ]);
  });

  it('says the delete failed, and is quiet when it works', async () => {
    const rt = fakeRuntime();
    const ok = deleteSession('s_1');
    rt.pending('agent.delete_session').ok({ sessionId: 's_1', deleted: true });
    await ok;
    expect(notices()).toEqual([]);
    const lost = deleteSession('s_1');
    rt.pending('agent.delete_session').lost();
    await lost;
    expect(notices()).toEqual([{ tone: 'err', title: 'The session could not be deleted', detail: null }]);
  });

  it('says Stop did not stop the analyst', async () => {
    const rt = fakeRuntime();
    applySessions({ type: 'snapshot', sessions: [session()] });
    selectSession('s_1');
    stopFromCommand();
    rt.pending('agent.interrupt').fail('unavailable', 'The analyst is not answering.');
    await settle();
    expect(notices()).toEqual([
      { tone: 'err', title: 'The analyst could not be stopped', detail: 'The analyst is not answering.' },
    ]);
    patch(analystStore, { sessions: null, selected: null });
  });
});

describe('Check again on the models', () => {
  it('says the check failed, keeping an internal error’s words out of sight', async () => {
    const rt = fakeRuntime();
    const done = recheckProviders();
    rt.pending('agent.list_providers').fail('internal', 'sqlite: database is locked');
    await done;
    expect(notices()).toEqual([{ tone: 'err', title: 'The models could not be checked', detail: null }]);
  });
});

describe('a popped-out window that will not close', () => {
  afterEach(() => resetPopoutWatches());

  it('says so instead of leaving a stray window unexplained', async () => {
    putLayout(newWorkspaceLayout('ws-fail', 0, { instrument: 'NQ' }));
    const record: PopoutRecord = { panelId: 'chart-1', kind: 'chart', bounds: null, monitor: null, returnTo: null };
    setStageView('ws-fail', { popouts: [record] });
    const watched = vi.fn(() => () => undefined);
    fakeRuntime({
      bridge: {
        openWindow: () => Promise.resolve(true),
        onWindowClosed: watched,
        closeWindow: () => Promise.reject(new Error('webview: no such window')),
        screens: () => Promise.resolve(null),
        windowBounds: () => Promise.resolve(null),
        thisWindowBounds: () => Promise.resolve(null),
      },
    });
    const api = {
      getPanel: () => undefined,
      groups: [],
      panels: [],
      addPanel: () => undefined,
      getEdgeGroup: () => undefined,
      toJSON: () => ({}),
    } as unknown as DockviewApi;
    const detach = attachWorkspace({
      api,
      layoutId: 'ws-fail',
      tools: new Set(),
      reload: () => undefined,
      canSaveDock: () => true,
      allowDockSaves: () => undefined,
      tileWindows: true,
    });
    const stop = resumePopouts('ws-fail');
    await vi.waitFor(() => expect(watched).toHaveBeenCalled());
    stop(true);
    detach();
    await settle();
    expect(notices()).toEqual([{ tone: 'err', title: 'A popped-out window could not close', detail: null }]);
  });
});

describe('view settings the browser will not keep', () => {
  it('says so once, not on every change, and again after a save that worked', () => {
    let full = true;
    const kept: string[] = [];
    const storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        if (full) throw new DOMException('quota', 'QuotaExceededError');
        kept.push(value);
      },
    };
    const store = makeStore({ n: 0 }, { persist: { key: 'test.full', version: 1, fields: {}, storage } });
    patch(store, { n: 1 });
    expect(notices()).toEqual([{ tone: 'err', title: 'View settings could not be saved', detail: null }]);
    deskToasts.clear();
    patch(store, { n: 2 });
    expect(notices()).toEqual([]);
    full = false;
    patch(store, { n: 3 });
    expect(kept).toHaveLength(1);
    full = true;
    patch(store, { n: 4 });
    expect(notices()).toEqual([{ tone: 'err', title: 'View settings could not be saved', detail: null }]);
  });
});
