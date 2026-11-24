import type { AgentEvent, AgentSessionSummary, Approval, OrderPreview, ProviderHealth } from '@tessera/protocol';
import { makeBrowserBridge } from '@tessera/bridge';
import { createStore, type ConnectionState, type RuntimeClient } from '@tessera/protocol';
import { Count, Icon, RailItem } from '@tessera/ui';
import { useEffect } from 'react';
import '../styles/app.css';
import { AnalystPanel } from '../analyst/AnalystPanel.tsx';
import { AnalystBadge, AnalystTab } from '../analyst/AnalystTab.tsx';
import {
  analystStore,
  setProviders,
  applySessions,
  applyApprovals,
  beginTranscript,
  applyEnvelope,
} from '../analyst/analystStore.ts';
import { SessionMenu } from '../analyst/SessionMenu.tsx';
import { RuntimeProvider } from '../app/RuntimeProvider.tsx';
import type { AppServices } from '../app/services.ts';
import { analystAway } from '../analyst/away.ts';
import { useAnalystStatus } from '../analyst/status.ts';
import { AnalystWithSessions } from '../workspace/tiles/AnalystTile.tsx';
import { patch } from '../app/store.ts';

const NOW = Date.now();

function AwayRailItem() {
  const away = analystAway(useAnalystStatus(), false);
  return (
    <span className="an-kit-rail" title={away?.words}>
      <RailItem
        icon="analyst"
        label="Agents"
        data-working={away?.working ? '' : undefined}
        badge={
          away && away.count > 0 ? (
            <Count n={away.count} />
          ) : away?.unread ? (
            <i className="an-unread" aria-hidden="true" />
          ) : null
        }
      />
      <span>{away?.words ?? 'nothing to say'}</span>
    </span>
  );
}
const ns = (ms: number) => ms * 1e6;

const codex: ProviderHealth = {
  providerId: 'codex',
  kind: 'agent',
  displayName: 'Codex',
  status: 'ok',
  latencyMs: null,
  lastMessageAt: null,
  message: 'ChatGPT · plus',
  checkedAt: 0,
};

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 'S1',
  title: 'NQ open drive plan',
  preset: 'Trader',
  provider: 'codex',
  model: 'gpt-5',
  mode: 'supervised',
  status: 'running',
  origin: { kind: 'agent', sessionId: 'S1', provider: 'codex' },
  sourceLabel: null,
  createdAt: ns(NOW - 3_600_000),
  updatedAt: ns(NOW - 5_000),
  ...over,
});

const preview: OrderPreview = {
  request: {
    accountId: 'paper-main',
    instrument: 'NQZ6.CME',
    side: 'buy',
    qty: 2,
    orderType: 'limit',
    limitPrice: 20615,
    stopPrice: null,
    tif: 'day',
    bracket: { stopLoss: 20598, takeProfit: 20700 },
    clientOrderId: null,
    reduceOnly: false,
  },
  environment: 'paper',
  restatement: 'BUY 2 NQ Z6 LMT 20,615.00 DAY',
  referencePrice: 20641.25,
  estPrice: 20615,
  estValue: null,
  estFees: null,
  riskToStop: { amount: 680, currency: 'USD' },
  buyingPowerAfter: null,
  positionAfter: 2,
  checks: [],
  createdAt: ns(NOW - 41_000),
};

const draft: Approval = {
  id: 'A1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'agent', sessionId: 'S1', provider: 'codex' },
  sessionId: 'S1',
  callId: 'c3',
  tool: 'orders.submit',
  risk: 'financial',
  input: { accountId: 'paper-main', instrument: 'NQZ6.CME', qty: 2, limitPrice: 20615 },
  preview,
  previewHash: 'h1',
  draftId: 'D1',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  createdAt: ns(NOW - 41_000),
  staleAt: ns(NOW + 60_000),
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
};

const change: Approval = {
  ...draft,
  id: 'A2',
  kind: 'modify',
  callId: 'c4',
  tool: 'chart.add_layer',
  risk: 'modify',
  input: { tileId: 'c1', kind: 'vwap', bands: 2 },
  preview: { restatement: 'VWAP with 2 bands on NQ Z6 5m' },
  previewHash: 'h2',
  draftId: null,
  environment: null,
  createdAt: ns(NOW - 20_000),
};

type Scene = 'working' | 'approval' | 'jump' | 'error' | 'idle' | 'nomodel' | 'sheet' | 'long';

const ASK: AgentEvent = {
  type: 'user_message',
  text: 'Plan the NQ open: where would you buy a pullback?',
  attachments: [],
};
const tool = (callId: string, title: string, done: boolean): AgentEvent[] => [
  { type: 'tool_call_started', callId, tool: 'market.get_bars', risk: 'read', args: {}, title },
  ...(done
    ? [
        {
          type: 'tool_call_finished',
          callId,
          tool: 'market.get_bars',
          risk: 'read',
          outcome: 'ok',
          resultSummary: '288 bars',
          artifactRefs: [],
          durationMs: 420,
          error: null,
        } as AgentEvent,
      ]
    : []),
];
const SAY: AgentEvent = {
  type: 'assistant_message',
  messageId: 'm1',
  text: 'NQ held **20,598** twice this morning; the gamma flip sits at **20,610**. A pullback into 20,615 with the stop under 20,598 risks 17 points for a move back to the overnight high.',
  blocks: [
    {
      kind: 'measured',
      title: 'NQ Z6 5m, last 20 sessions',
      text: '',
      sourceCallId: 'c1',
      rows: [
        ['Pullbacks to the flip that held', '64%'],
        ['Median move after', '+38 pts'],
      ],
    },
  ],
};

function longSession(turns: number): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let t = 1; t <= turns; t++) {
    out.push({ type: 'turn_started', turnId: `t${String(t)}` });
    out.push({
      type: 'user_message',
      text: `Question ${String(t)}: where does NQ stand against the overnight range?`,
      attachments: [],
    });
    out.push({ type: 'reasoning_summary', text: 'Read the chart, then the levels, then answer.', durationMs: 1_800 });
    for (let c = 0; c < 6; c++) out.push(...tool(`c${String(t)}-${String(c)}`, 'Read NQ 5m bars', true));
    const text = `NQ is **20,6${String(t % 10)}0**, inside the overnight range.\n\n- Overnight high 20,702\n- Prior close 20,588\n- Gamma flip 20,610\n\n| Level | Distance |\n|---|---|\n| ONH | +82 |\n| Flip | −10 |`;
    for (const piece of text.match(/.{1,24}/gs) ?? [])
      out.push({ type: 'assistant_delta', messageId: `m${String(t)}`, text: piece });
    out.push({ type: 'assistant_message', messageId: `m${String(t)}`, text, blocks: [] });
    out.push({ type: 'turn_finished', turnId: `t${String(t)}`, end: 'completed', durationMs: 14_000, toolCalls: 6 });
  }
  return out;
}

function events(scene: Scene): AgentEvent[] {
  const start: AgentEvent[] = [{ type: 'turn_started', turnId: 't1' }, ASK];
  switch (scene) {
    case 'long':
      return longSession(42);
    case 'working':
      return [
        ...start,
        { type: 'reasoning_summary', text: 'Look at the morning range first', durationMs: 2_100 },
        ...tool('c1', 'Reading NQ 5m bars', false),
      ];
    case 'approval':
    case 'jump':
      return [
        ...start,
        ...tool('c1', 'Read NQ 5m bars', true),
        ...tool('c2', 'Read the gamma levels', true),
        SAY,
        { type: 'approval_requested', approvalId: 'A1', draftId: 'D1', tool: 'orders.submit', kind: 'financial' },
        { type: 'approval_requested', approvalId: 'A2', draftId: null, tool: 'chart.add_layer', kind: 'modify' },
        ...(scene === 'jump'
          ? ([
              {
                type: 'assistant_message',
                messageId: 'm2',
                text: 'While that waits: the overnight high is 20,702, the prior day’s close 20,588. Volume into the open ran 1.4× its 20-day average, mostly on the bid after 09:42. I would not chase above 20,650; the book thins there and the last two pushes failed at 20,662.\n\nIf the draft goes stale I will re-check the levels before drafting again.',
                blocks: [],
              },
            ] as AgentEvent[])
          : []),
        { type: 'status', state: 'waiting_approval', text: null, step: null, totalSteps: null },
      ];
    case 'error':
      return [
        ...start,
        ...tool('c1', 'Read NQ 5m bars', true),
        { type: 'error', code: 'provider', message: 'Codex dropped. Retrying, 2nd try.', retryable: true },
        { type: 'turn_finished', turnId: 't1', end: 'failed', durationMs: 12_400, toolCalls: 1 },
      ];
    case 'idle':
    case 'sheet':
      return [
        ...start,
        ...tool('c1', 'Read NQ 5m bars', true),
        SAY,
        { type: 'turn_finished', turnId: 't1', end: 'completed', durationMs: 16_400, toolCalls: 2 },
        {
          type: 'suggestions',
          items: [
            { label: 'Split by volatility', tool: 'research.run_event_study', input: {} },
            { label: 'Draft the order', tool: 'orders.submit', input: {} },
          ],
        },
      ];
    case 'nomodel':
      return [];
  }
}

function seed(scene: Scene): void {
  patch(analystStore, { selected: null, transcript: null, unread: scene === 'idle', sheet: scene === 'sheet' });
  setProviders(scene === 'nomodel' ? [{ ...codex, status: 'down', message: 'Codex is not installed' }] : [codex]);
  if (scene === 'nomodel') {
    applySessions({ type: 'snapshot', sessions: [] });
    applyApprovals({ type: 'snapshot', pending: [] });
    return;
  }
  const waits = scene === 'approval' || scene === 'jump';
  const status = scene === 'working' ? 'running' : waits ? 'needs_you' : 'idle';
  applySessions({
    type: 'snapshot',
    sessions: [
      session({ status }),
      session({ id: 'S2', title: 'ES overnight inventory', status: 'idle', updatedAt: ns(NOW - 7_200_000) }),
      session({ id: 'S3', title: 'Gamma levels research', status: 'idle', updatedAt: ns(NOW - 90_000_000) }),
    ],
  });
  applyApprovals({ type: 'snapshot', pending: waits ? [draft, change] : [] });
  beginTranscript('S1');
  const list = events(scene);
  const startAt = NOW - (scene === 'working' ? 8_000 : 41_000);
  list.forEach((event, i) =>
    applyEnvelope({ sessionId: 'S1', seq: i, ts: ns(startAt + i * 500), turnId: 't1', event }, true, NOW),
  );
}

const idle = createStore<ConnectionState>({
  status: 'idle',
  attempt: 0,
  everConnected: false,
  server: null,
  lastError: null,
  lastErrorCode: null,
  nextRetryAt: null,
  connectedAt: null,
  endpoint: null,
});
const offline: RuntimeClient = {
  state: idle,
  behind: createStore(0),
  request: () => new Promise<never>(() => undefined),
  subscribe: () => () => undefined,
  onEvent: () => () => undefined,
  retryNow: () => undefined,
  close: () => undefined,
};
const host = makeBrowserBridge({ fetch: () => Promise.reject(new Error('the kit has no runtime')) });
const services: AppServices = { host, client: offline };

const SCENES: readonly Scene[] = ['working', 'approval', 'jump', 'error', 'idle', 'nomodel', 'sheet', 'long'];
const asked = new URLSearchParams(window.location.search).get('s') ?? 'working';
const SCENE: Scene = (SCENES as readonly string[]).includes(asked) ? (asked as Scene) : 'working';
if (new URLSearchParams(window.location.search).get('p') === 'analyst') seed(SCENE);
const AREA = new URLSearchParams(window.location.search).get('view') === 'area';

export function AnalystKit() {
  useEffect(() => {
    if (SCENE !== 'jump') return;
    const t = setTimeout(() => {
      const v = document.querySelector('.ag-scroll-view');
      if (v) v.scrollTop = v.scrollHeight;
    }, 300);
    return () => clearTimeout(t);
  }, []);
  if (AREA)
    return (
      <RuntimeProvider services={services}>
        <div className="an-kit-area ar-layer">
          <div className="tile analyst-tile">
            <AnalystWithSessions />
          </div>
        </div>
      </RuntimeProvider>
    );
  return (
    <RuntimeProvider services={services}>
      <div className="an-kit">
        <div className="an-kit-strip dockview-theme-tessera" aria-label="Collapsed strip">
          <div className="dock-tab is-strip" data-collapsed="">
            <span className="dock-tab-icon">
              <Icon name="analyst" />
              <AnalystBadge />
            </span>
          </div>
        </div>
        <div className="an-kit-tile">
          <div className="an-kit-tabs">
            <div className="dock-tab an-kit-on">
              <AnalystTab />
            </div>
            <span className="fill" />
            <SessionMenu />
          </div>
          <div className="tile analyst-tile">
            <AnalystPanel />
          </div>
        </div>
        <div className="an-kit-frame">
          <span>The rail’s Agents item, while the analyst is out of view:</span>
          <AwayRailItem />
        </div>
      </div>
    </RuntimeProvider>
  );
}
