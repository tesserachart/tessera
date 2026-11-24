import type {
  AgentProviderInfo,
  AgentSessionSummary,
  CopyGroup,
  Fill,
  HealthUpdate,
  Money,
  Order,
  Position,
  TradingAccount,
} from '@tessera/protocol';
import { screen } from '@testing-library/react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalystData } from '../src/analyst/AnalystData.tsx';
import { AnalystPanel } from '../src/analyst/AnalystPanel.tsx';
import { analystStore, EMPTY_ANALYST } from '../src/analyst/analystStore.ts';
import { copyStore } from '../src/accounts/copy.ts';
import { patch, read } from '../src/app/store.ts';
import { AnalystWithSessions } from '../src/workspace/tiles/AnalystTile.tsx';
import { CopyPanel } from '../src/areas/copy/CopyPanel.tsx';
import { ShellDataProvider } from '../src/shell/ShellData.tsx';
import { runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
import { DeskEmpty } from '../src/workspace/dock/DeskEmpty.tsx';
import { LayoutKnownContext } from '../src/workspace/dock/layoutKnown.ts';
import { AccountsTile } from '../src/workspace/tiles/AccountsTile.tsx';
import { PositionsTile } from '../src/workspace/tiles/PositionsTile.tsx';
import { TradeTile } from '../src/workspace/tiles/TradeTile.tsx';
import {
  expectLoadsInOneGo,
  heldReads,
  mountSurface,
  RuntimeSettingsFeed,
  settle,
  SIM,
  unmountSurface,
  visibleText,
  type HeldReads,
  type SimReads,
} from './support/loading.tsx';
import { providerHealth } from './support/providers.ts';
import type { FakeClient } from './support/runtime.tsx';
import { EMPTY_SHELL_DATA, type ShellData } from '../src/shell/shellData.ts';

const TOOLS = [...Object.keys(SIM.tools), 'agent.get_transcript', 'agent.start_session'];

const NQ = 'NQZ6.CME';
const usd = (amount: number): Money => ({ amount, currency: 'USD' });

const FOLDS_FORGET_AFTER_MS = 450;

beforeEach(() => {
  asked.length = 0;
  patch(runtimeSettingsStore, { values: {}, loaded: false });
  patch(analystStore, EMPTY_ANALYST);
  patch(copyStore, { groups: null, sync: null });
});

afterEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    unmountSurface();
    vi.advanceTimersByTime(FOLDS_FORGET_AFTER_MS);
  } finally {
    vi.useRealTimers();
  }
});

const asked: string[] = [];

function withTopicsAnswered(client: FakeClient, topics: readonly string[]): FakeClient {
  return {
    request: (method, params, options) => {
      if (method === 'tools.invoke') asked.push(`tool ${(params as { name: string }).name}`);
      return client.request!(method, params, options);
    },
    subscribe: (topic, params, handler, options) => {
      asked.push(`topic ${topic}`);
      if (!topics.includes(topic)) return client.subscribe!(topic, params, handler, options);
      for (const data of SIM.topics[topic] ?? []) handler(data, { topic, seq: 0, subscriptionId: null });
      return () => undefined;
    },
  };
}

const STATIC_SHELL: ShellData = {
  ...EMPTY_SHELL_DATA,
  providers: (SIM.topics.health![0] as HealthUpdate).providers,
  accounts: SIM.topics.accounts!.map((u) => (u as { account: TradingAccount }).account),
  accountId: 'paper-main',
};

interface Mount {
  readonly shell?: 'app' | 'analyst' | 'static';
  readonly unrelated?: readonly string[];
}

function mount(held: HeldReads, surface: ReactNode, { shell = 'app', unrelated = [] }: Mount = {}) {
  const client = withTopicsAnswered(held.client, ['market.quotes', ...unrelated]);
  if (shell === 'app')
    return mountSurface(client, <ShellDataProvider>{surface}</ShellDataProvider>, { tools: TOOLS, shell: null });
  const shown =
    shell === 'analyst' ? (
      <>
        <AnalystData />
        <RuntimeSettingsFeed>{surface}</RuntimeSettingsFeed>
      </>
    ) : (
      surface
    );
  return mountSurface(client, shown, { tools: TOOLS, shell: STATIC_SHELL });
}

async function loads(held: HeldReads, container: Element) {
  try {
    return await expectLoadsInOneGo(held, () => container);
  } catch (e) {
    throw new Error(
      `${(e as Error).message}\n  answered so far: ${held.answered.join(', ')}\n  asked: ${asked.join(', ')}`,
      { cause: e },
    );
  }
}

const position = (qty: number): Position => ({
  accountId: 'paper-main',
  instrument: NQ,
  qty,
  avgPrice: 19_995,
  realizedPnl: usd(0),
  unrealizedPnl: usd(100),
  mark: 20_000,
  openedAt: 1,
});

const workingOrder = (): Order => ({
  id: 'o-1',
  brokerOrderId: null,
  draftId: null,
  role: 'entry',
  parentId: null,
  status: 'working',
  filledQty: 0,
  avgFillPrice: null,
  queueAhead: null,
  triggeredAt: null,
  environment: 'paper',
  reason: null,
  createdAt: 1,
  updatedAt: 1,
  request: {
    accountId: 'paper-main',
    instrument: NQ,
    side: 'buy',
    qty: 1,
    orderType: 'limit',
    limitPrice: 19_900,
    stopPrice: null,
    tif: 'day',
    bracket: null,
    clientOrderId: null,
    reduceOnly: false,
  },
});

const closedOrder = (): Order => ({ ...workingOrder(), id: 'o-0', status: 'filled' });

const fill = (): Fill => ({
  id: 'fill-1',
  brokerFillId: null,
  orderId: null,
  accountId: 'paper-main',
  instrument: NQ,
  side: 'buy',
  qty: 1,
  price: 19_995,
  ts: 1_790_966_550_000_000_000,
  fee: usd(0),
  realizedPnl: null,
  source: 'paper',
});

const evals = (): CopyGroup => ({
  id: 'g-1',
  name: 'Evals',
  enabled: true,
  leaderId: 'paper-main',
  followers: [{ accountId: 'paper-2', multiplier: 1 }],
  createdAt: 1,
  updatedAt: 1,
});

const tileProps = {
  api: { id: 'positions', getParameters: () => ({}), updateParameters: () => undefined },
} as unknown as IDockviewPanelProps;

describe('the Desk and its tiles show a loading state, then everything at once', () => {
  it('the empty desk says nothing until the layout and connections are known', async () => {
    const held = heldReads(SIM);
    const { container } = mount(
      held,
      <LayoutKnownContext.Provider value={true}>
        <DeskEmpty />
      </LayoutKnownContext.Provider>,
      { shell: 'static' },
    );
    const { loading, loaded } = await loads(held, container);
    expect(loading).toBe('');
    expect(loaded).toMatch(/No chart open|No market data/);
  });

  it('the empty desk stays blank while its layout is still loading', async () => {
    const held = heldReads(SIM);
    const { container } = mount(
      held,
      <LayoutKnownContext.Provider value={false}>
        <DeskEmpty />
      </LayoutKnownContext.Provider>,
      { shell: 'static' },
    );
    await loads(held, container);
    await settle();
    expect(visibleText(container)).toBe('');
  });

  it('Positions shows open, working and fills with account names in one go', async () => {
    const held = heldReads(
      {
        ...SIM,
        topics: { ...SIM.topics, positions: [{ position: position(1) }], orders: [{ order: workingOrder() }] },
      },
      { 'portfolio.get_fills': () => ({ fills: [fill()] }) },
    );
    const { container } = mount(held, <PositionsTile {...tileProps} />, {
      unrelated: ['copy.groups', 'copy.sync', 'health'],
    });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Flat|Open|Working|Fills|Paper|paper-main/);
    expect(loaded).toContain('Open · 1');
    expect(loaded).toContain('Working · 1');
    expect(loaded).toContain('Fills today · 1');
    expect(loaded).toContain('Paper');
    expect(loaded).not.toContain('paper-main');
  });

  it('Positions says Flat only once positions, orders and fills have all answered', async () => {
    const held = heldReads({
      ...SIM,
      topics: { ...SIM.topics, positions: [{ position: position(0) }], orders: [{ order: closedOrder() }] },
    });
    const { container } = mount(held, <PositionsTile {...tileProps} />, {
      unrelated: ['copy.groups', 'copy.sync', 'health'],
    });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toContain('Flat');
    expect(loaded).toContain('Flat');
  });

  it('Accounts lists accounts with connection names and copy words at once', async () => {
    const group = evals();
    const held = heldReads({
      ...SIM,
      topics: {
        ...SIM.topics,
        positions: [{ position: position(1) }],
        orders: [{ order: workingOrder() }],
        'copy.groups': [{ groups: [group] }],
      },
    });
    const { container } = mount(held, <AccountsTile {...tileProps} />, { unrelated: ['copy.sync'] });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Connect an account|Paper|Account|Leads/);
    expect(loaded).toContain('Paper');
    expect(loaded).toContain('Leads Evals');
    expect(loaded).toContain('Long 1 NQ Z6 · 1 working');
    expect(loaded).not.toContain('Connect an account');
  });

  it('Trade waits for the layout before saying there is no chart', async () => {
    const held = heldReads(SIM);
    const { container } = mount(
      held,
      <LayoutKnownContext.Provider value={false}>
        <TradeTile {...tileProps} />
      </LayoutKnownContext.Provider>,
      { shell: 'static' },
    );
    await loads(held, container);
    await settle();
    expect(visibleText(container)).not.toContain('Open a chart to trade from here.');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it('Trade says there is no chart once the layout is known', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, <TradeTile {...tileProps} />, { shell: 'static' });
    const { loaded } = await loads(held, container);
    expect(loaded).toContain('Open a chart to trade from here.');
  });
});

const codex = (): AgentProviderInfo => ({
  ...(SIM.tools['agent.list_providers']![0]!.output as { providers: AgentProviderInfo[] }).providers[0]!,
  enabled: true,
  status: 'ok',
  message: null,
});

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'codex',
  model: null,
  mode: 'supervised',
  status: 'idle',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sourceLabel: null,
  createdAt: 1_790_966_000_000_000_000,
  updatedAt: 1_790_966_500_000_000_000,
  ...over,
});

const envelope = (seq: number, event: unknown) => ({ sessionId: 's_1', seq, ts: seq, turnId: 't_1', event });

function withCodexOn(topics: SimReads['topics']): SimReads['topics'] {
  const snapshot = topics.settings![0] as { type: 'snapshot'; values: Record<string, unknown> };
  const health = topics.health![0] as HealthUpdate;
  const codexHealth = providerHealth({ providerId: 'codex', kind: 'agent', displayName: 'Codex', checkedAt: 1 });
  return {
    ...topics,
    health: [{ ...health, providers: [...health.providers, codexHealth] }],
    settings: [{ ...snapshot, values: { ...snapshot.values, 'agent.providers': { codex: { enabled: true } } } }],
  };
}

describe('the Analyst shows a loading state, then the right screen at once', () => {
  it('the Analyst page offers to turn on a model when none is on', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, <AnalystWithSessions />, { shell: 'analyst' });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Turn on the analyst|No sessions yet|New session/);
    expect(loaded).toContain('Turn on the analyst');
    expect(loaded).toContain('No sessions yet');
    expect(screen.queryByRole('status', { name: 'Loading the desk analyst' })).toBeNull();
  });

  it('the Analyst page shows an open session with its transcript, not the starters', async () => {
    const held = heldReads(
      {
        ...SIM,
        topics: {
          ...withCodexOn(SIM.topics),
          'agent.sessions': [{ type: 'snapshot', sessions: [session()] }],
          'agent.session': [
            envelope(1, { type: 'user_message', text: 'Where is gamma flip?', attachments: [] }),
            envelope(2, { type: 'assistant_message', messageId: 'm1', text: 'Flip sits at 20,100.', blocks: [] }),
          ],
        },
      },
      {
        'agent.list_providers': () => ({ providers: [codex()] }),
        'agent.get_transcript': () => ({
          session: session(),
          entries: [{ seq: 1, ts: 1, role: 'user', text: 'Where is gamma flip?' }],
          lastSeq: 2,
          more: false,
        }),
      },
    );
    const { container } = mount(held, <AnalystWithSessions />, { shell: 'analyst' });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/NQ gamma plan|Where is gamma flip|No sessions yet|Ask the analyst/);
    expect(loaded).toContain('NQ gamma plan');
    expect(read(analystStore).transcript?.t.items).toHaveLength(2);
    expect(loaded).not.toContain('No sessions yet');
    expect(loaded).not.toContain('Ask the analyst');
  });

  it('the Desk Analyst panel draws its skeleton from a conversation and its composer', async () => {
    const held = heldReads(SIM);
    mount(held, <AnalystPanel />, { shell: 'analyst' });
    await settle();
    const skeleton = screen.getByRole('status', { name: 'Loading the analyst' });
    expect(skeleton.querySelectorAll('.ag-you .bubble').length).toBeGreaterThan(0);
    expect(skeleton.querySelector('.ag-say .md')).toBeTruthy();
    expect(skeleton.querySelector('.ag-compose textarea')).toBeTruthy();
  });

  it('the Desk Analyst panel with no model on shows the turn-on screen at once', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, <AnalystPanel />, { shell: 'analyst' });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Turn on the analyst|Ask the analyst/);
    expect(loaded).toContain('Turn on the analyst');
  });

  it('the Desk Analyst panel with a model on and no session shows the starters at once', async () => {
    const held = heldReads(
      { ...SIM, topics: withCodexOn(SIM.topics) },
      { 'agent.list_providers': () => ({ providers: [codex()] }) },
    );
    const { container } = mount(held, <AnalystPanel />, { shell: 'analyst' });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Turn on the analyst|Ask the analyst|Recent/);
    expect(loaded).not.toContain('Turn on the analyst');
  });

  it('the Desk Analyst panel replays an open session before it shows anything', async () => {
    const held = heldReads(
      {
        ...SIM,
        topics: {
          ...withCodexOn(SIM.topics),
          'agent.sessions': [{ type: 'snapshot', sessions: [session()] }],
          'agent.session': [
            envelope(1, { type: 'user_message', text: 'Where is gamma flip?', attachments: [] }),
            envelope(2, { type: 'assistant_message', messageId: 'm1', text: 'Flip sits at 20,100.', blocks: [] }),
          ],
        },
      },
      {
        'agent.list_providers': () => ({ providers: [codex()] }),
        'agent.get_transcript': () => ({
          session: session(),
          entries: [{ seq: 1, ts: 1, role: 'user', text: 'Where is gamma flip?' }],
          lastSeq: 2,
          more: false,
        }),
      },
    );
    const { container } = mount(held, <AnalystPanel />, { shell: 'analyst' });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Where is gamma flip|Ask the analyst|Turn on the analyst/);
    expect(read(analystStore).transcript?.t.items).toHaveLength(2);
    expect(loaded).not.toContain('Ask the analyst');
  });
});

describe('the Trade copier shows its groups complete', () => {
  it('lists groups with account names and sync words at once', async () => {
    const group = evals();
    const held = heldReads({
      ...SIM,
      topics: {
        ...SIM.topics,
        'copy.groups': [{ groups: [group] }],
        'copy.sync': [
          {
            groups: [
              {
                groupId: 'g-1',
                leaderId: 'paper-main',
                leader: 'Paper',
                leaderHoldings: [],
                followers: [],
                outOfSync: 0,
                recent: [],
              },
            ],
            checkedAt: 1,
          },
        ],
      },
    });
    const { container } = mount(held, <CopyPanel />, { unrelated: ['positions', 'orders', 'health'] });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/Evals|paper-main|New group/);
    expect(loaded).toContain('Evals');
    expect(loaded).toContain('Paper');
    expect(loaded).not.toContain('paper-main');
  });

  it('draws its skeleton from the copier itself: groups beside a group’s followers', async () => {
    const held = heldReads(SIM);
    mount(held, <CopyPanel />, { unrelated: ['positions', 'orders', 'health', 'copy.sync'] });
    await settle();
    const skeleton = screen.getByRole('status', { name: 'Loading the trade copier' });
    expect(skeleton.querySelectorAll('.cp-nav-row').length).toBeGreaterThan(1);
    expect(skeleton.querySelector('.cp-group .cp-tbl')).toBeTruthy();
  });

  it('offers the first group only after the groups are known', async () => {
    const held = heldReads(SIM);
    const { container } = mount(held, <CopyPanel />, {
      unrelated: ['positions', 'orders', 'health', 'copy.sync'],
    });
    const { loading, loaded } = await loads(held, container);
    expect(loading).not.toMatch(/New group|Copy one account/);
    expect(loaded).toContain('Copy one account');
  });
});
