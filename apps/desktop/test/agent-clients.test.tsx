import type { McpAddClientOutput, McpClientInfo } from '@tessera/protocol';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockContext, type RuntimeClock } from '../src/app/clock.ts';
import { InstallButton } from '../src/areas/agents/InstallButton.tsx';
import { INSTALL_PAGES, installPage, unavailableWhy, type ProviderView } from '../src/areas/agents/models.ts';
import { addedWords, clientHelp } from '../src/areas/settings/agentClients.ts';
import { AgentClients } from '../src/areas/settings/categories/AgentClients.tsx';
import { landingOf, modelEntries, searchSettings } from '../src/areas/settings/model.ts';
import { fakeRuntime } from './support/fakeRuntime.ts';
import { actPause } from './support/pause.ts';
import { answeringClient, TestRuntime } from './support/runtime.tsx';

const NOW_MS = Date.UTC(2026, 9, 11, 15, 0, 0);
const MIN_NS = 60e9;
const clock = { now: () => NOW_MS } as unknown as RuntimeClock;
const TOKEN = `tsk_${'0'.repeat(64)}`;

function client(over: Partial<McpClientInfo> = {}): McpClientInfo {
  return {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    kind: 'claude-desktop',
    policy: 'supervised',
    createdAt: (NOW_MS - 60 * 60_000) * 1e6,
    lastUsedAt: null,
    ...over,
  };
}

function added(c: McpClientInfo, file: string | null, format: 'json' | 'shell' | 'toml'): McpAddClientOutput {
  return {
    client: c,
    token: TOKEN,
    snippets: [{ label: 'Where it goes', file, format, text: `setup with ${TOKEN}` }],
  };
}

let clipboard: string[] = [];

beforeEach(() => {
  clipboard = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => (clipboard.push(t), Promise.resolve()) },
  });
});

afterEach(() => {
  cleanup();
});

const openMenu = () => fireEvent.keyDown(screen.getByRole('button', { name: 'Connect an agent' }), { key: 'Enter' });

describe('Use Tessera from your agent: the words', () => {
  it('is found by the words a user would search for', () => {
    const entries = modelEntries();
    for (const q of ['mcp', 'claude desktop', 'cursor', 'connect an agent'])
      expect(searchSettings(entries, q)[0]?.id, q).toBe('analyst.external');
    expect(landingOf('analyst.external')).toBe('analyst');
  });

  it('says a client’s kind only when its name is its own, its id beside a twin, and its last use', () => {
    const a = client();
    expect(clientHelp(a, [a], NOW_MS)).toBe('Not used yet');
    const used = client({ lastUsedAt: NOW_MS * 1e6 - 5 * MIN_NS });
    expect(clientHelp(used, [used], NOW_MS)).toBe('Last used 5m ago');
    const twin = client({ id: 'claude-desktop-2' });
    expect(clientHelp(twin, [a, twin], NOW_MS)).toBe('claude-desktop-2 · Not used yet');
    const own = client({ id: 'other', kind: 'other', name: 'My script', lastUsedAt: NOW_MS * 1e6 });
    expect(clientHelp(own, [own], NOW_MS)).toBe('MCP client · Last used just now');
    expect(addedWords('/c.json', null)).toBe('Added to /c.json. Restart Claude Desktop to use it.');
    expect(addedWords('/c.json', '/c.bak')).toContain('old file kept beside it');
  });
});

describe('Use Tessera from your agent', () => {
  it('lists each connected agent, sets what it may do and revokes it', async () => {
    let clients = [
      client({ lastUsedAt: NOW_MS * 1e6 - 3 * MIN_NS }),
      client({ id: 'cursor', name: 'Cursor', kind: 'cursor', policy: 'read_only' }),
    ];
    const { client: fake, calls } = answeringClient({
      'mcp.list_clients': () => ({ clients }),
      'mcp.set_client_policy': ({ id, policy }) => {
        clients = clients.map((c) => (c.id === id ? { ...c, policy } : c));
        return { client: clients.find((c) => c.id === id)! };
      },
      'mcp.revoke_client': ({ id }) => {
        clients = clients.filter((c) => c.id !== id);
        return { revoked: true };
      },
    });
    render(
      <TestRuntime client={fake} clock={clock}>
        <AgentClients />
      </TestRuntime>,
    );
    await vi.waitFor(() => expect(screen.getByText('Last used 3m ago')).toBeTruthy());
    expect(screen.getByRole('region', { name: 'Use Tessera from your agent' })).toBeTruthy();
    expect(screen.getByText('Not used yet')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'What Claude Desktop may do' }).textContent).toContain('Supervised');
    expect(screen.getByRole('combobox', { name: 'What Cursor may do' }).textContent).toContain('Read only');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'What Claude Desktop may do' }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /Read only/ }));
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        name: 'mcp.set_client_policy',
        input: { id: 'claude-desktop', policy: 'read_only' },
      }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'What Claude Desktop may do' }).textContent).toContain('Read only'),
    );

    const row = screen.getByText('Cursor').closest<HTMLElement>('.t-set-row')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText('Its token stops working at once.')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm' })).getByRole('button', { name: /^Revoke/ }));
    await vi.waitFor(() => expect(calls).toContainEqual({ name: 'mcp.revoke_client', input: { id: 'cursor' } }));
    await vi.waitFor(() => expect(screen.queryByText('Cursor')).toBeNull());
  });

  it('connects Claude Desktop: the setup once with Copy, the one click, and the token gone once closed', async () => {
    let clients: McpClientInfo[] = [];
    const { client: fake, calls } = answeringClient({
      'mcp.list_clients': () => ({ clients }),
      'mcp.add_client': ({ kind }) => {
        const c = client({ kind });
        clients = [c];
        return added(c, '~/Library/Application Support/Claude/claude_desktop_config.json', 'json');
      },
      'mcp.add_to_claude_desktop': () => ({
        path: '/home/me/.config/Claude/claude_desktop_config.json',
        backup: '/home/me/.config/Claude/claude_desktop_config.backup-1.json',
      }),
    });
    render(
      <TestRuntime client={fake} clock={clock}>
        <AgentClients />
      </TestRuntime>,
    );
    await actPause();
    expect(screen.queryByRole('combobox')).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Claude Desktop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect Claude Desktop' });
    expect(dialog.textContent).toContain('Orders it places wait for your approval in Tessera.');
    await vi.waitFor(() => expect(dialog.textContent).toContain(`setup with ${TOKEN}`));
    expect(dialog.textContent).toContain('claude_desktop_config.json');
    expect(calls).toContainEqual({ name: 'mcp.add_client', input: { kind: 'claude-desktop' } });

    fireEvent.click(screen.getByRole('button', { name: 'Copy: Where it goes' }));
    await vi.waitFor(() => expect(clipboard).toEqual([`setup with ${TOKEN}`]));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copy: Where it goes' }).textContent).toBe('Copied'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add to Claude Desktop' }));
    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        name: 'mcp.add_to_claude_desktop',
        input: { id: 'claude-desktop', token: TOKEN },
      }),
    );
    await vi.waitFor(() => expect(dialog.textContent).toContain('Restart Claude Desktop to use it.'));
    expect(screen.queryByRole('button', { name: 'Add to Claude Desktop' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).not.toContain(TOKEN);
    await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'What Claude Desktop may do' })).toBeTruthy());
  });

  it('connects Codex without the Claude Desktop click, and says the runtime’s refusal', async () => {
    const rt = fakeRuntime({ answers: { 'mcp.list_clients': () => ({ clients: [] }) } });
    render(
      <ClockContext.Provider value={clock}>
        <AgentClients />
      </ClockContext.Provider>,
    );
    await actPause();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
    await vi.waitFor(() => rt.pending('mcp.add_client'));
    rt.pending('mcp.add_client').ok(
      added(client({ id: 'codex', name: 'Codex', kind: 'codex' }), '~/.codex/config.toml', 'toml'),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Connect Codex' });
    await vi.waitFor(() => expect(dialog.textContent).toContain('~/.codex/config.toml'));
    expect(screen.queryByRole('button', { name: 'Add to Claude Desktop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cursor' }));
    await vi.waitFor(() => rt.pending('mcp.add_client'));
    rt.pending('mcp.add_client').fail('internal', 'the database: disk full');
    const refused = await screen.findByRole('dialog', { name: 'Connect Cursor' });
    await vi.waitFor(() => expect(refused.textContent).toContain('The database: disk full.'));
  });
});

describe('a provider whose CLI is not installed', () => {
  const view = (over: Partial<ProviderView>): ProviderView => ({
    id: 'claude-code',
    name: 'Claude Code',
    enabled: true,
    status: 'down',
    message: 'Claude Code is not installed',
    models: [],
    defaultModel: null,
    readsPdfs: false,
    ready: false,
    ...over,
  });

  it('links to its install page, and only then', () => {
    expect(installPage('claude-code', 'down', 'Claude Code is not installed')).toBe(
      'https://docs.anthropic.com/en/docs/claude-code/setup',
    );
    expect(installPage('codex', 'down', 'Codex is not installed')).toBe(
      'https://github.com/openai/codex/releases/latest',
    );
    expect(installPage('codex', 'disconnected', 'Not signed in')).toBeNull();
    expect(installPage('codex', 'down', 'Codex did not run: boom')).toBeNull();
    expect(installPage('local', 'down', 'not installed')).toBeNull();
    expect(unavailableWhy(view({}))).toBe('Not installed. Install it and sign in; it connects here by itself.');
    expect(Object.keys(INSTALL_PAGES)).toEqual(['claude-code', 'codex']);
  });

  it('opens the page in the system browser', async () => {
    const opened: string[] = [];
    const openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    render(
      <TestRuntime client={{}} bridge={{ openExternal }}>
        <InstallButton url={INSTALL_PAGES.codex!} name="Codex" download />
      </TestRuntime>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download Codex' }));
    await vi.waitFor(() => expect(opened).toEqual(['https://github.com/openai/codex/releases/latest']));
  });
});
