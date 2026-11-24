import type { LevelSourceInfo, ProviderHealth, SourceDraft, ToolCallEvent, TradingAccount } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { accountsUiStore } from '../src/accounts/accountsUi.ts';
import { AddConnection } from '../src/accounts/AddConnection.tsx';
import { patch, read } from '../src/app/store.ts';
import { settingsNavStore } from '../src/areas/settings/store.ts';
import { areaStore } from '../src/areas/store.ts';
import { ConnectionStatus } from '../src/shell/ConnectionStatus.tsx';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { uiStore } from '../src/state/ui.ts';
import { connectionItem, connectionRows, listedConnections } from '../src/accounts/connections.ts';
import { EMPTY_FORM, specFromForm } from '../src/accounts/levelSource.ts';
import { useListedConnections } from '../src/accounts/useConnections.ts';
import { DeskEmpty } from '../src/workspace/dock/DeskEmpty.tsx';
import { providerHealth } from './support/providers.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime, topicFeed } from './support/runtime.tsx';

afterEach(cleanup);

const health = (providerId: string, kind: ProviderHealth['kind'], displayName: string): ProviderHealth =>
  providerHealth({ providerId, kind, displayName });

const levels: LevelSourceInfo = {
  providerId: 'levels-vendor',
  displayName: 'Mock gamma levels',
  vendor: 'Mock',
  packages: [],
  instruments: ['QQQ', 'NQ'],
  schedule: null,
  callsToday: [],
  spec: null,
  editable: false,
  sendsSecret: false,
  history: null,
  health: { ...health('levels-vendor', 'intelligence', 'Mock gamma levels'), status: 'degraded', message: null },
};

const draft = {
  id: 'walls',
  spec: { name: 'Walls API' },
  samples: {},
  note: null,
  problems: [],
} as unknown as SourceDraft;

describe('Settings › Connections, the one home of connections', () => {
  it('lists logins, then levels providers and drafts, then paper, each with what it gives and its state', () => {
    const providers = [
      { ...health('mock', 'market_data', 'Mock market'), latencyMs: 12 },
      health('paper', 'broker', 'Paper broker'),
    ];
    const rows = connectionRows(providers, []);
    const items = listedConnections(rows, [levels], providers, [draft]).map((l) => connectionItem(l, []));
    expect(items.map((i) => [i.id, i.name, i.provides, i.state, i.end, i.shownInChrome])).toEqual([
      ['mock', 'Mock market', '', '12 ms', null, true],
      ['levels-vendor', 'Mock gamma levels', 'Levels for QQQ, NQ', 'Data is late', 'remove', true],
      ['draft:walls', 'Walls API', 'Levels, once you try it with your key and save it', 'Draft', 'discard', false],
      ['paper', 'Paper trading', 'Accounts and orders, filled at your market data’s prices', 'Connected', null, false],
    ]);
    expect(items[0]!.latencyMs).toBe(12);
  });

  it('says what a Rithmic login gives and whom it serves, and offers Disconnect, or Connect once it is off', () => {
    const on = connectionRows(
      [{ ...health('rithmic-apex', 'market_data', 'Apex · Rithmic'), latencyMs: 31 }],
      [],
      [{ id: 'rithmic-apex-1', displayName: 'APEX-1', connectionId: 'rithmic-apex' } as TradingAccount],
    );
    const [item] = listedConnections(on, [], [], []).map((l) =>
      connectionItem(l, [{ displayName: 'APEX-1', connectionId: 'rithmic-apex' } as TradingAccount]),
    );
    expect(item).toMatchObject({
      name: 'Apex · Rithmic',
      short: 'Apex',
      provides: 'Prices, accounts and fills',
      serves: 'APEX-1',
      state: '31 ms',
      test: true,
      edit: true,
      end: 'disconnect',
    });
  });

  it('reads a login’s state from its connection phase, with no message', () => {
    const reconnecting = {
      ...health('rithmic-apex', 'market_data', 'Apex · Rithmic'),
      status: 'degraded' as const,
      connection: { state: 'reconnecting' as const, attempt: 2, reason: 'connection closed' },
    };
    const [item] = listedConnections(connectionRows([reconnecting], []), [], [], []).map((l) => connectionItem(l, []));
    expect(item).toMatchObject({
      status: 'degraded',
      state: 'Connection lost. Reconnecting, 2nd try.',
    });

    const takenOver = { ...reconnecting, status: 'down' as const, connection: { state: 'taken_over' as const } };
    const [down] = listedConnections(connectionRows([takenOver], []), [], [], []).map((l) => connectionItem(l, []));
    expect(down).toMatchObject({
      state: 'Another session of this login took over. Close it, then reconnect in Connections.',
      end: 'disconnect',
    });
  });

  it('takes a provider’s live health over the one its listing was read with', () => {
    const live = { ...levels.health, status: 'ok' as const };
    const [item] = listedConnections([], [levels], [live], []).map((l) => connectionItem(l, []));
    expect(item).toMatchObject({ status: 'ok', state: 'Connected' });
  });

  it('adds a Rithmic login or a levels source the user brings, and nothing built in', async () => {
    const { client } = answeringClient({ 'intel.list_sources': () => ({ sources: [] }) });
    setTestServices(client);
    seedTools(['connections.list', 'intel.list_sources']);
    render(
      <TestRuntime client={client}>
        <AddConnection />
      </TestRuntime>,
    );
    const button = screen.getByRole('button', { name: 'Add connection' });
    fireEvent.keyDown(button, { key: 'Enter' });
    await screen.findByRole('menuitem', { name: /Any API, with the analyst/ });
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Rithmic…Prices, depth, accounts, orders',
      'Any API, with the analyst…From its docs or a sample',
      'Write a spec…Form or JSON',
    ]);
  });
});

describe('a connection the analyst changes', () => {
  const call = (tool: string, risk: 'read' | 'modify'): ToolCallEvent => ({
    phase: 'finished',
    call: {
      callId: tool,
      tool,
      risk,
      origin: { kind: 'agent', sessionId: 's1', provider: 'codex' },
      sessionId: 's1',
      inputHash: '',
      input: {},
      status: 'ok',
      startedAt: 0,
      finishedAt: 1,
      durationMs: 1,
      error: null,
      approvalId: null,
      deduped: false,
      idempotencyKey: null,
      summary: null,
      approvedBy: null,
    },
  });

  function Listed() {
    const ids = useListedConnections().map((l) => connectionItem(l, []).id);
    return (
      <ul>
        {ids.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    );
  }

  const drafted: SourceDraft = {
    id: 'walls',
    spec: specFromForm({
      ...EMPTY_FORM,
      vendor: 'Walls API',
      url: 'https://api.walls.test/levels/{ticker}',
      tickers: [{ root: 'NQ', ticker: 'NDX', add: '' }],
      fields: [{ field: 'call_wall', path: 'cw', label: 'Call Wall' }],
    }),
    samples: {},
    note: null,
    problems: [],
    draftedAt: 0,
  };

  it('shows up without a reload once the analyst drafts it, and a read the analyst makes asks for nothing', async () => {
    let drafts: SourceDraft[] = [];
    const { client, calls } = answeringClient({
      'connections.list': () => ({ connections: [], dataSource: null }),
      'intel.list_sources': () => ({ sources: [] }),
      'intel.list_source_drafts': () => ({ drafts }),
    });
    const feed = topicFeed();
    const live = { ...client, subscribe: feed.subscribe };
    setTestServices(live);
    seedTools(['connections.list', 'intel.list_sources', 'intel.list_source_drafts']);
    render(
      <TestRuntime client={live}>
        <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
          <Listed />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    await waitFor(() => expect(calls.some((c) => c.name === 'intel.list_source_drafts')).toBe(true));
    const asked = calls.length;
    act(() => feed.push('tool.calls', call('intel.list_source_drafts', 'read')));
    expect(calls).toHaveLength(asked);

    drafts = [drafted];
    act(() => feed.push('tool.calls', call('intel.draft_source', 'modify')));
    expect(await screen.findByText('draft:walls')).toBeTruthy();
  });
});

describe('the status bar’s connections', () => {
  const shell = (providers: ProviderHealth[]) => ({ ...EMPTY_SHELL_DATA, providers });

  it('shows each connection but paper with its state, follows a disconnect, and opens its row in Settings', () => {
    const { client } = answeringClient({ 'connections.list': () => ({ connections: [], dataSource: null }) });
    setTestServices(client);
    seedTools(['connections.list']);
    const live = [
      { ...health('rithmic-apex', 'market_data', 'Apex · Rithmic'), latencyMs: 31 },
      health('paper', 'broker', 'Paper broker'),
    ];
    const view = render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={shell(live)}>
          <ConnectionStatus />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    const bar = screen.getByRole('navigation', { name: 'Connection status' });
    const apex = within(bar).getByRole('button', { name: 'Apex · Rithmic: 31 ms' });
    expect(apex.textContent).toBe('Apex31 ms');
    expect(within(bar).queryByRole('button', { name: /Paper/ })).toBeNull();

    view.rerender(
      <TestRuntime client={client}>
        <ShellDataContext.Provider
          value={shell([{ ...live[0]!, status: 'disconnected', latencyMs: null, message: null }, live[1]!])}
        >
          <ConnectionStatus />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    const off = within(bar).getByRole('button', { name: 'Apex · Rithmic: Off' });
    expect(off.getAttribute('data-status')).toBe('disconnected');

    fireEvent.click(off);
    expect(read(areaStore).area).toBe('settings');
    expect(read(uiStore).settingsSection).toBe('connections');
    expect(read(settingsNavStore).target?.id).toBe('connections.rithmic-apex');
  });

  it('offers to connect Rithmic while there is no connection', () => {
    const { client } = answeringClient({ 'connections.list': () => ({ connections: [], dataSource: null }) });
    setTestServices(client);
    seedTools(['connections.list']);
    render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={shell([health('paper', 'broker', 'Paper broker')])}>
          <ConnectionStatus />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Connect Rithmic' }));
    expect(read(accountsUiStore).focus).toEqual({ kind: 'add', provider: 'rithmic' });
    patch(accountsUiStore, { focus: null });
  });
});

describe('the desk without a chart', () => {
  const desk = (providers: ProviderHealth[]) => {
    const { client } = answeringClient({ 'connections.list': () => ({ connections: [], dataSource: null }) });
    setTestServices(client);
    seedTools(['connections.list']);
    render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, providers }}>
          <DeskEmpty />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
  };

  it('says no market data is connected and offers to connect Rithmic', () => {
    desk([health('paper', 'broker', 'Paper broker')]);
    expect(screen.getByRole('heading', { name: 'No market data' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Rithmic' }));
    expect(read(accountsUiStore).focus).toEqual({ kind: 'add', provider: 'rithmic' });
    patch(accountsUiStore, { focus: null });
  });

  it('stays out of the desk’s side and bottom edges', () => {
    const { client } = answeringClient({ 'connections.list': () => ({ connections: [], dataSource: null }) });
    setTestServices(client);
    seedTools(['connections.list']);
    const edge = { api: { location: { type: 'edge' } } } as unknown as Parameters<typeof DeskEmpty>[0]['group'];
    render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={EMPTY_SHELL_DATA}>
          <DeskEmpty group={edge} />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('offers to open a chart from any symbol once a login serves prices, or to add any panel', () => {
    desk([{ ...health('rithmic-apex', 'market_data', 'Apex · Rithmic'), latencyMs: 31 }]);
    expect(screen.getByRole('heading', { name: 'No chart open' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add panel/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open a chart' }));
    expect(read(uiStore).paletteOpen).toBe(true);
  });
});
