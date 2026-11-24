import type { DockviewApi } from 'dockview-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patch, read } from '../src/app/store.ts';
import { uiStore } from '../src/state/ui.ts';
import { attachWorkspace, type WorkspaceContext } from '../src/workspace/controller.ts';
import {
  answerLeave,
  confirmQuit,
  documentStore,
  isUnsaved,
  leaveWords,
  noteDocument,
  recoveredWords,
  switchWorkspace,
} from '../src/workspace/document.ts';
import { answeringClient, seedTools, setTestServices } from './support/runtime.tsx';

const TOOLS = ['layout.get', 'layout.list', 'workspace.save', 'workspace.revert'];

function desk(layoutId: string): WorkspaceContext {
  return {
    api: {} as DockviewApi,
    layoutId,
    tools: new Set(TOOLS),
    reload: () => undefined,
    canSaveDock: () => true,
    allowDockSaves: () => undefined,
  };
}

function runtime(unsaved: boolean) {
  const layout = {
    id: 'ws-a',
    name: 'Trade',
    revision: 4,
    updatedAt: 0,
    activeChartId: null,
    dock: null,
    trade: null,
    charts: {},
    ...(unsaved ? { unsaved: true } : {}),
  };
  const summary = (id: string, name: string, edited: boolean) => ({
    id,
    name,
    revision: 4,
    updatedAt: 0,
    charts: [],
    unsaved: edited,
    recovered: false,
  });
  const { client, calls } = answeringClient({
    'layout.get': () => layout,
    'layout.list': () => ({
      layouts: [summary('ws-a', 'Trade', unsaved), summary('ws-b', 'Scalp', false)],
      activeId: 'ws-a',
    }),
    'workspace.save': (input) => ({ layoutId: input.layoutId ?? 'ws-a', revision: 5 }),
    'workspace.revert': (input) => ({ layoutId: input.layoutId ?? 'ws-a', revision: 5 }),
  });
  setTestServices(client);
  seedTools(TOOLS);
  return calls;
}

async function asked(): Promise<void> {
  await vi.waitFor(() => expect(read(documentStore).ask).not.toBeNull());
}

describe('leaving a workspace with unsaved changes', () => {
  let detach: () => void = () => undefined;
  beforeEach(() => {
    patch(uiStore, { workspace: 'ws-a' });
    detach = attachWorkspace(desk('ws-a'));
  });
  afterEach(() => {
    detach();
    patch(documentStore, { known: {}, ask: null, recovered: null });
  });

  it('Cancel stays on it, changed', async () => {
    const calls = runtime(true);
    const left = switchWorkspace('ws-b');
    await asked();
    expect(read(documentStore).ask).toEqual({ names: ['Trade'], leaving: 'switch' });
    answerLeave('cancel');
    expect(await left).toBe(false);
    expect(read(uiStore).workspace).toBe('ws-a');
    expect(calls.map((c) => c.name)).not.toContain('workspace.revert');
  });

  it('Don’t save goes and brings the saved version back', async () => {
    const calls = runtime(true);
    const left = switchWorkspace('ws-b');
    await asked();
    answerLeave('discard');
    expect(await left).toBe(true);
    expect(read(uiStore).workspace).toBe('ws-b');
    expect(calls.at(-1)).toEqual({ name: 'workspace.revert', input: { layoutId: 'ws-a' } });
    expect(isUnsaved('ws-a')).toBe(false);
  });

  it('Save keeps the changes, then goes', async () => {
    const calls = runtime(true);
    const left = switchWorkspace('ws-b');
    await asked();
    answerLeave('save');
    expect(await left).toBe(true);
    expect(read(uiStore).workspace).toBe('ws-b');
    expect(calls.map((c) => c.name)).toContain('workspace.save');
    expect(calls.map((c) => c.name)).not.toContain('workspace.revert');
  });

  it('a saved workspace goes without asking', async () => {
    runtime(false);
    expect(await switchWorkspace('ws-b')).toBe(true);
    expect(read(documentStore).ask).toBeNull();
    expect(read(uiStore).workspace).toBe('ws-b');
  });

  it('quitting asks about every unsaved workspace and saves what the user keeps', async () => {
    const calls = runtime(true);
    const quit = confirmQuit();
    await asked();
    expect(read(documentStore).ask).toEqual({ names: ['Trade'], leaving: 'quit' });
    answerLeave('save');
    expect(await quit).toBe(true);
    expect(calls.at(-1)).toEqual({ name: 'workspace.save', input: { layoutId: 'ws-a' } });
  });
});

describe('the words', () => {
  it('name the workspace, or count them', () => {
    expect(leaveWords({ names: ['Trade'], leaving: 'switch' })).toEqual({
      title: 'Save changes to “Trade”?',
      description: 'If you don’t save, your changes are lost.',
    });
    expect(leaveWords({ names: ['Trade', 'Scalp'], leaving: 'quit' }).title).toBe(
      'Save changes to 2 workspaces before quitting?',
    );
    expect(recoveredWords({ ids: ['ws-a'], names: ['Trade'] })).toEqual({
      title: 'Tessera closed before you saved “Trade”',
      description: 'Your unsaved changes are back.',
    });
  });

  it('an older layout event never overrides a newer save', () => {
    noteDocument({ id: 'ws-z', revision: 7, unsaved: false });
    noteDocument({ id: 'ws-z', revision: 6, unsaved: true });
    expect(isUnsaved('ws-z')).toBe(false);
    noteDocument({ id: 'ws-z', revision: 8, unsaved: true });
    expect(isUnsaved('ws-z')).toBe(true);
  });
});
