import type { AgentProviderInfo, AgentSessionSummary } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderView } from '../src/areas/agents/models.ts';
import { newChatPlan } from '../src/analyst/newChat.ts';
import { SessionMenu } from '../src/analyst/SessionMenu.tsx';
import { analystStore, applySessions, EMPTY_ANALYST } from '../src/analyst/analystStore.ts';
import { read, write } from '../src/app/store.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'claude-code',
  model: 'claude-opus-5-5',
  mode: 'supervised',
  status: 'idle',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'claude-code' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const view = (over: Partial<ProviderView> = {}): ProviderView => ({
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  status: 'ok',
  message: 'Claude · Max',
  models: [],
  defaultModel: null,
  ready: true,
  readsPdfs: true,
  ...over,
});

const info = (over: Partial<AgentProviderInfo> = {}): AgentProviderInfo => ({
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  status: 'ok',
  message: 'Claude · Max',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: null, efforts: [], defaultEffort: null }],
  defaultModel: 'claude-opus-5-5',
  version: '2.1.3',
  configHome: '/home/me/.claude',
  checkedAt: 1,
  readsPdfs: true,
  ...over,
});

const off = (id: string, name: string): AgentProviderInfo => ({
  id,
  name,
  enabled: false,
  status: 'disabled',
  message: null,
  models: [],
  defaultModel: null,
  readsPdfs: false,
});

function menu(): HTMLElement {
  fireEvent.pointerDown(screen.getByRole('button', { name: /Session:/ }), { button: 0, ctrlKey: false });
  return screen.getByRole('menu');
}

function reasonOf(item: HTMLElement): string | null {
  const id = item.getAttribute('aria-describedby');
  return id ? (document.getElementById(id)?.textContent ?? null) : null;
}

function newChatRow(): HTMLElement {
  return screen.getByRole('menuitem', { name: /New chat/ });
}

afterEach(() => {
  cleanup();
  act(() => write(analystStore, EMPTY_ANALYST));
  putRuntimeSettings({}, true);
});

describe('whether New chat can start', () => {
  it('starts when a provider is ready', () => {
    expect(newChatPlan([view()], true, null)).toEqual({ kind: 'start' });
  });

  it('names the missing piece when no provider can start one', () => {
    expect(newChatPlan([view()], false, null)).toEqual({
      kind: 'blocked',
      reason: 'This build can’t start an analyst session.',
      fix: null,
    });
    expect(newChatPlan([], true, null)).toEqual({
      kind: 'blocked',
      reason: 'No model is on.',
      fix: { kind: 'settings' },
    });
  });

  it('offers to turn on the provider the trader last used', () => {
    const codex = view({ id: 'codex', name: 'Codex', enabled: false, status: 'disabled', ready: false });
    const claude = view({ enabled: false, status: 'disabled', ready: false });
    expect(newChatPlan([codex, claude], true, 'claude-code')).toEqual({
      kind: 'blocked',
      reason: 'Claude Code is off.',
      fix: { kind: 'turn-on', provider: claude },
    });
    expect(newChatPlan([codex, claude], true, 'codex')).toMatchObject({
      reason: 'Codex is off.',
      fix: { kind: 'turn-on', provider: { id: 'codex' } },
    });
  });

  it('says why a provider that is on cannot start one', () => {
    const checking = view({ status: 'unknown', ready: false, message: null });
    expect(newChatPlan([checking], true, null)).toEqual({
      kind: 'blocked',
      reason: 'Checking Claude Code…',
      fix: null,
    });
    const signedOut = view({ status: 'disconnected', ready: false, message: 'Not signed in' });
    expect(newChatPlan([signedOut], true, null)).toEqual({
      kind: 'blocked',
      reason: 'Claude Code is not signed in.',
      fix: { kind: 'settings' },
    });
    const missing = view({ status: 'down', ready: false, message: 'Claude Code is not installed' });
    expect(newChatPlan([missing], true, null)).toEqual({
      kind: 'blocked',
      reason: 'Claude Code is not installed.',
      fix: { kind: 'settings' },
    });
    const failing = view({ status: 'down', ready: false, message: 'It did not run' });
    expect(newChatPlan([failing], true, null)).toEqual({
      kind: 'blocked',
      reason: 'Claude Code: It did not run',
      fix: { kind: 'settings' },
    });
  });
});

describe('the New chat row', () => {
  it('says a model is off and turns it on from the menu', async () => {
    putRuntimeSettings({ 'agent.providers': {} }, true);
    const { client, calls } = answeringClient({
      'agent.list_providers': () => ({ providers: [off('codex', 'Codex'), off('claude-code', 'Claude Code')] }),
      'settings.set': ({ key, value }) => ({ key, value, previous: {} }),
    });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.start_session', 'settings.set']);
    act(() => applySessions({ type: 'snapshot', sessions: [session()] }));
    render(
      <TestRuntime client={client} bridge={bridge}>
        <TooltipProvider>
          <SessionMenu />
        </TooltipProvider>
      </TestRuntime>,
    );
    menu();
    const newChat = newChatRow();
    expect(newChat.getAttribute('aria-disabled')).toBe('true');
    expect(newChat.getAttribute('data-disabled')).toBe('');
    await waitFor(() => expect(reasonOf(newChatRow())).toBe('Claude Code is off.'));
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn on Claude Code' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        name: 'settings.set',
        input: { key: 'agent.providers', value: { 'claude-code': { enabled: true } } },
      }),
    );
    await screen.findByText('Checking Claude Code…');
    await waitFor(() => expect(reasonOf(newChatRow())).toBe('Checking Claude Code…'));
    expect(screen.queryByRole('menuitem', { name: 'Turn on Claude Code' })).toBeNull();
  });

  it('shows the reason when the keyboard reaches New chat, and keeps it reachable', async () => {
    putRuntimeSettings({ 'agent.providers': {} }, true);
    const { client } = answeringClient({
      'agent.list_providers': () => ({ providers: [off('claude-code', 'Claude Code')] }),
    });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.start_session']);
    act(() => applySessions({ type: 'snapshot', sessions: [session()] }));
    render(
      <TestRuntime client={client} bridge={bridge}>
        <TooltipProvider>
          <SessionMenu />
        </TooltipProvider>
      </TestRuntime>,
    );
    menu();
    await waitFor(() => expect(reasonOf(newChatRow())).toBe('Claude Code is off.'));
    const newChat = newChatRow();
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => newChat.focus());
    expect(document.activeElement).toBe(newChat);
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toBe('Claude Code is off.');
    expect(newChat.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(newChat);
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('starts a new conversation from the row when one can start', async () => {
    putRuntimeSettings({ 'agent.providers': { 'claude-code': { enabled: true } } }, true);
    const { client } = answeringClient({ 'agent.list_providers': () => ({ providers: [info()] }) });
    const bridge = {};
    setTestServices(client, bridge);
    seedTools(['agent.list_providers', 'agent.start_session']);
    act(() => applySessions({ type: 'snapshot', sessions: [session()] }));
    render(
      <TestRuntime client={client} bridge={bridge}>
        <TooltipProvider>
          <SessionMenu />
        </TooltipProvider>
      </TestRuntime>,
    );
    menu();
    await waitFor(() => expect(newChatRow().getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(newChatRow());
    expect(read(analystStore).fresh).toBe(true);
  });
});
