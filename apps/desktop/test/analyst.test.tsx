import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentSessionSummary,
  Approval,
  ChartLayer,
  Delivery,
  Level,
  LevelsUpdate,
  OrderPreview,
  PrintBars,
  ProviderHealth,
} from '@tessera/protocol';
import { PlatformProvider, ShownContext } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activityWords,
  analystActivity,
  briefLabel,
  resumable,
  starters,
  isWorking,
  jumpWords,
  needsYouCount,
  notifyBody,
  tradingDayStart,
} from '../src/analyst/activity.ts';
import { stopAnalyst } from '../src/analyst/actions.ts';
import {
  EMPTY_ANALYST,
  isLive,
  readyModels,
  selectTranscript,
  applySessions,
  analystStore,
  applyApprovals,
  resetApprovals,
  selectSession,
  beginTranscript,
  applyEnvelope,
  markSeen,
} from '../src/analyst/analystStore.ts';
import { AnalystTab } from '../src/analyst/AnalystTab.tsx';
import { InlineApproval } from '../src/analyst/InlineApproval.tsx';
import { AgentComposer } from '../src/areas/agents/AgentComposer.tsx';
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from '../src/app/agentTranscript.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';
import { queueView } from './support/queue.ts';
import { blocks } from '../src/analyst/blocks.ts';
import { TranscriptView } from '../src/shell/AgentTranscript.tsx';
import { setComposerDraft } from '../src/state/ui.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { patch, read, write } from '../src/app/store.ts';
import { useChartSight } from '../src/analyst/sight.ts';
import { defaultChartState, putLayout } from '../src/state/layouts.ts';
import { setActiveChartRef } from '../src/state/workspace.ts';
import { providerHealth } from './support/providers.ts';
import { ns } from './support/time.ts';

const env = (seq: number, event: AgentEvent, ts = seq): AgentEventEnvelope => ({
  sessionId: 's_1',
  seq,
  ts,
  turnId: 't_1',
  event,
});

const fold = (events: AgentEvent[], from: Transcript = EMPTY_TRANSCRIPT): Transcript =>
  events.reduce((t, e, i) => reduceTranscript(t, env(from.lastSeq + 1 + i, e)), from);

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'codex',
  model: 'gpt-5',
  mode: 'supervised',
  status: 'idle',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
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
  restatement: 'BUY 2 NQ LMT 20615 DAY',
  referencePrice: 20641,
  estPrice: 20615,
  estValue: null,
  estFees: null,
  riskToStop: { amount: 680, currency: 'USD' },
  buyingPowerAfter: null,
  positionAfter: 2,
  checks: [],
  createdAt: 0,
};

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'a_1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sessionId: 's_1',
  callId: 'c_1',
  tool: 'orders.submit',
  risk: 'financial',
  input: {},
  preview,
  previewHash: 'h1',
  draftId: 'd_1',
  environment: 'paper',
  instrument: 'NQZ6.CME',
  createdAt: 0,
  staleAt: Date.now() + 60_000,
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
  ...over,
});

const change = (over: Partial<Approval> = {}) =>
  approval({
    id: 'a_2',
    kind: 'modify',
    tool: 'chart.add_layer',
    risk: 'modify',
    input: { tileId: 'c1', period: 20 },
    preview: { restatement: 'VWAP on NQ Z6 5m' },
    environment: null,
    draftId: null,
    ...over,
  });

const codex = (status: ProviderHealth['status'] = 'ok'): ProviderHealth =>
  providerHealth({ providerId: 'codex', kind: 'agent', displayName: 'Codex', status });

describe('what the analyst is doing', () => {
  it('says it in the runtime’s words first, then the running tool’s title, then the state', () => {
    const started = fold([
      { type: 'turn_started', turnId: 't_1' },
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'market.get_bars',
        risk: 'read',
        args: {},
        title: 'Reading NQ 5m bars',
      },
    ]);
    expect(activityWords(started)).toBe('Reading NQ 5m bars');
    const said = fold(
      [{ type: 'status', state: 'running_tool', text: 'Scanning the book', step: 1, totalSteps: 3 }],
      started,
    );
    expect(activityWords(said)).toBe('Scanning the book');
    const thinking = fold([
      { type: 'turn_started', turnId: 't_1' },
      { type: 'status', state: 'thinking', text: null, step: null, totalSteps: null },
    ]);
    expect(activityWords(thinking)).toBe('Thinking');
    const writing = fold([{ type: 'status', state: 'writing', text: null, step: null, totalSteps: null }], thinking);
    expect(activityWords(writing)).toBe('Writing');
    expect(analystActivity(thinking, session({ status: 'needs_you' }))).toEqual({
      phase: 'waiting',
      words: 'Waiting for you',
      since: 0,
    });
  });

  it('counts from the turn’s start, stops between turns, and says Stopped after a failure', () => {
    const t = fold([
      { type: 'turn_started', turnId: 't_1' },
      { type: 'status', state: 'thinking', text: null, step: null, totalSteps: null },
    ]);
    expect(analystActivity(t, null)).toMatchObject({ phase: 'working', since: 0 });
    expect(isWorking(analystActivity(t, null))).toBe(true);
    const done = fold([{ type: 'turn_finished', turnId: 't_1', end: 'completed', durationMs: 1_000, toolCalls: 0 }], t);
    expect(analystActivity(done, null)).toEqual({ phase: 'idle', words: null, since: null });
    const failed = fold(
      [
        { type: 'error', code: 'provider', message: 'Codex dropped. Retrying, 2nd try.', retryable: true },
        { type: 'turn_finished', turnId: 't_1', end: 'failed', durationMs: 1_000, toolCalls: 0 },
      ],
      t,
    );
    expect(analystActivity(failed, null)).toEqual({ phase: 'stopped', words: 'Stopped', since: null });
    expect(isWorking(analystActivity(failed, null))).toBe(false);
    expect(analystActivity(fold([{ type: 'user_message', text: 'again', attachments: [] }], failed), null).phase).toBe(
      'idle',
    );
    const stopped = fold(
      [{ type: 'turn_finished', turnId: 't_1', end: 'interrupted', durationMs: 900, toolCalls: 0 }],
      t,
    );
    expect(analystActivity(stopped, null).phase).toBe('idle');
  });

  it('takes a log that ended mid-turn as history once the runtime says the session is idle', () => {
    const t = fold([
      { type: 'turn_started', turnId: 't_1' },
      { type: 'status', state: 'writing', text: null, step: null, totalSteps: null },
    ]);
    expect(analystActivity(t, session({ status: 'idle' })).phase).toBe('idle');
    expect(analystActivity(t, session({ status: 'running' })).phase).toBe('working');
    expect(analystActivity(t, null).phase).toBe('working');
  });

  it('reads a session’s own status while its transcript loads, without a time', () => {
    expect(analystActivity(null, session({ status: 'running' }))).toEqual({
      phase: 'working',
      words: 'Working',
      since: null,
    });
    expect(analystActivity(null, session({ status: 'needs_you' })).phase).toBe('waiting');
    expect(analystActivity(null, session()).phase).toBe('idle');
    expect(analystActivity(null, null).phase).toBe('idle');
  });

  it('counts every approval waiting, and a session that needs you for something else once', () => {
    const asking = session({ id: 's_2', status: 'needs_you' });
    const drafting = session({ id: 's_1', status: 'needs_you' });
    expect(needsYouCount([approval(), change()], [drafting])).toBe(2);
    expect(needsYouCount([approval()], [drafting, asking])).toBe(2);
    expect(needsYouCount([approval({ sessionId: null })], [])).toBe(1);
    expect(needsYouCount([], [session()])).toBe(0);
  });

  it('words what waits for the jump bar and the OS notification', () => {
    expect(jumpWords(approval())).toBe('Draft waits · Buy 2 NQ Z6');
    expect(jumpWords(change())).toBe('Waits for you · Add layer');
    expect(notifyBody(approval())).toBe('Draft · Buy 2 NQ Z6 limit 20,615.00');
    expect(notifyBody(change())).toBe('Change · Add layer');
  });

  it('offers the day’s brief until the analyst has spoken since the trading day opened at 18:00 New York', () => {
    const now = Date.parse('2026-10-08T10:00:00-04:00');
    const open = tradingDayStart(now);
    expect(open).toBe(Date.parse('2026-10-07T18:00:00-04:00'));
    expect(tradingDayStart(Date.parse('2026-10-08T19:30:00-04:00'))).toBe(Date.parse('2026-10-08T18:00:00-04:00'));
    expect(tradingDayStart(Date.parse('2026-12-08T10:00:00-05:00'))).toBe(Date.parse('2026-12-07T18:00:00-05:00'));
    putRuntimeSettings({ 'display.timeZone': 'Asia/Tokyo' }, false);
    expect(tradingDayStart(now)).toBe(open);
    putRuntimeSettings({ 'display.timeZone': null }, false);
    expect(briefLabel('NQ Z6', null, open)).toBe('Brief NQ Z6 for today');
    expect(briefLabel('NQ Z6', open - 60_000, open)).toBe('Brief NQ Z6 for today');
    expect(briefLabel('NQ Z6', open + 60_000, open)).toBeNull();
    expect(briefLabel(null, null, open)).toBeNull();
  });

  it('opens an empty log on questions about the active chart, which prefill and never send', () => {
    const labels = (o: { brief: boolean; levels: boolean }) => starters('NQ Z6', o).map((s) => s.label);
    expect(labels({ brief: true, levels: true })).toEqual([
      'Brief NQ Z6 for today',
      'Where NQ Z6 trades against its levels',
      'Plan a pullback entry on NQ Z6',
      'What moved NQ Z6 this session',
    ]);
    expect(labels({ brief: false, levels: false })).toEqual([
      'Plan a pullback entry on NQ Z6',
      'What moved NQ Z6 this session',
    ]);
    expect(starters(null, { brief: true, levels: true })).toEqual([]);
    expect(starters('NQ Z6', { brief: false, levels: false })[0]!.prompt).toMatch(
      /Draft it for me to review; send nothing/,
    );
    for (const st of starters('NQ Z6', { brief: true, levels: true })) {
      expect(st.note.length).toBeGreaterThan(0);
      expect(st.note.length).toBeLessThanOrEqual(64);
      expect(st.note).not.toMatch(/guarantee|will (win|profit)|best/i);
    }
  });

  it('offers the other named sessions to resume, newest first, three at most', () => {
    const s = (id: string, title: string, updatedAt: number) => ({ id, title, updatedAt }) as AgentSessionSummary;
    const all = [
      s('a', 'NQ open drive plan', 10),
      s('b', 'Analyst', 50),
      s('c', 'Gamma reversion', 40),
      s('d', '', 60),
      s('e', 'ES levels', 30),
      s('f', 'Overnight range', 20),
    ];
    expect(resumable(all, 'c').map((x) => x.id)).toEqual(['e', 'f', 'a']);
    expect(resumable(null, null)).toEqual([]);
  });
});

describe('the analyst’s store', () => {
  afterEach(() => write(analystStore, EMPTY_ANALYST));

  it('keeps sessions most recent first and approvals oldest first, and shows the session that matters', () => {
    applySessions({
      type: 'snapshot',
      sessions: [session({ id: 'old', updatedAt: 1 }), session({ id: 'new', updatedAt: 5 })],
    });
    expect(read(analystStore).sessions?.map((x) => x.id)).toEqual(['new', 'old']);
    applyApprovals({
      type: 'snapshot',
      pending: [approval({ id: 'b', createdAt: 2 }), approval({ id: 'a', createdAt: 1 })],
    });
    expect(read(analystStore).approvals?.map((a) => a.id)).toEqual(['a', 'b']);
    applyApprovals({ type: 'resolved', approval: approval({ id: 'a', status: 'approved' }) });
    expect(read(analystStore).approvals?.map((a) => a.id)).toEqual(['b']);
    resetApprovals();
    expect(read(analystStore).approvals).toBeNull();
    selectSession('old');
    beginTranscript('old');
    expect(selectTranscript(read(analystStore))).toEqual(EMPTY_TRANSCRIPT);
  });

  it('marks an answer unread only when a turn ends live while the tab is out of view', () => {
    applySessions({ type: 'snapshot', sessions: [session()] });
    const end: AgentEvent = { type: 'turn_finished', turnId: 't_1', end: 'completed', durationMs: 1, toolCalls: 0 };
    const now = Date.parse('2026-10-08T14:00:00Z');
    applyEnvelope(env(1, end, ns(now - 120_000)), false, now);
    expect(read(analystStore).unread).toBe(false);
    applyEnvelope(env(2, end, ns(now - 1_000)), true, now);
    expect(read(analystStore).unread).toBe(false);
    applyEnvelope(env(3, end, ns(now - 1_000)), false, now);
    expect(read(analystStore).unread).toBe(true);
    markSeen();
    expect(read(analystStore).unread).toBe(false);
    expect(isLive(now - 29_000, now)).toBe(true);
    expect(isLive(Number.NaN, now)).toBe(false);
  });

  it('names the ready models in the runtime’s order', () => {
    const claude = { ...codex(), providerId: 'claude-code', displayName: 'Claude Code' };
    expect(readyModels([codex('disconnected'), claude, { ...codex(), kind: 'market_data' }])).toEqual(['claude-code']);
  });
});

describe('the log with approvals inline', () => {
  it('puts a waiting approval at its point in the log and folds a resolved one into the work line', () => {
    const t = fold([
      { type: 'user_message', text: 'Add VWAP', attachments: [] },
      { type: 'tool_call_started', callId: 'c1', tool: 'market.get_bars', risk: 'read', args: {}, title: 'Read bars' },
      { type: 'approval_requested', approvalId: 'a_2', draftId: null, tool: 'chart.add_layer', kind: 'modify' },
      { type: 'reasoning_summary', text: 'more', durationMs: 10 },
    ]);
    const waiting = new Map([['a_2', change()]]);
    expect(blocks(t.items, waiting).map((b) => b.kind)).toEqual(['item', 'work', 'approval', 'work']);
    expect(blocks(t.items).map((b) => b.kind)).toEqual(['item', 'work']);
  });

  it('reads a line that no longer waits as expired once the waiting set is known', () => {
    const t = fold([
      {
        type: 'tool_call_started',
        callId: 'c9',
        tool: 'chart.add_layer',
        risk: 'modify',
        args: {},
        title: 'Add layer',
      },
      {
        type: 'tool_call_finished',
        callId: 'c9',
        tool: 'chart.add_layer',
        risk: 'modify',
        outcome: 'pending_approval',
        resultSummary: null,
        artifactRefs: [],
        durationMs: 12,
        error: null,
      },
      { type: 'approval_requested', approvalId: 'gone', draftId: null, tool: 'chart.add_layer', kind: 'modify' },
    ]);
    const [fold1] = blocks(t.items, new Map(), true);
    expect(
      fold1?.kind === 'work' &&
        fold1.items.map((i) => (i.kind === 'approval' ? i.status : i.kind === 'tool' ? i.summary : null)),
    ).toEqual(['expired', 'stale']);
    const [fold2] = blocks(t.items, new Map(), false);
    expect(fold2?.kind === 'work' && fold2.items.map((i) => (i.kind === 'approval' ? i.status : null))).toEqual([
      null,
      'pending',
    ]);
  });

  it('renders the cards where they were asked for, and approvals with no line after the log', () => {
    const t = fold([
      { type: 'user_message', text: 'Add VWAP', attachments: [] },
      { type: 'approval_requested', approvalId: 'a_2', draftId: null, tool: 'chart.add_layer', kind: 'modify' },
      { type: 'assistant_message', messageId: 'm1', text: 'Asked.', blocks: [] },
    ]);
    render(
      <TranscriptView
        transcript={t}
        notices={[]}
        onFollowUp={() => undefined}
        waiting={[change(), approval({ id: 'mcp', sessionId: null })]}
        renderApproval={(a) => <p data-testid={`card-${a.id}`}>{a.id}</p>}
      />,
    );
    const cards = screen.getAllByTestId(/^card-/).map((e) => e.textContent);
    expect(cards).toEqual(['a_2', 'mcp']);
    const order = [...document.querySelectorAll('.cx-you, [data-testid], .cx-say')].map(
      (e) => e.className || e.textContent,
    );
    expect(order).toEqual(['cx-you', 'a_2', 'cx-say', 'mcp']);
    cleanup();
  });

  it('says a change the user allowed in its own words', () => {
    const t = fold([
      { type: 'approval_requested', approvalId: 'a_2', draftId: null, tool: 'chart.add_layer', kind: 'modify' },
      { type: 'approval_resolved', approvalId: 'a_2', status: 'approved' },
    ]);
    render(<TranscriptView transcript={t} notices={[]} onFollowUp={() => undefined} />);
    expect(document.querySelector('.cx-work li')?.textContent).toBe('Add layer allowed');
    cleanup();
  });

  it('offers Retry on a retryable error that ended the log', () => {
    const onRetry = vi.fn();
    const t = fold([
      { type: 'user_message', text: 'Brief me', attachments: [] },
      { type: 'error', code: 'provider', message: 'Codex dropped. Retrying, 2nd try.', retryable: true },
    ]);
    render(<TranscriptView transcript={t} notices={[]} onFollowUp={() => undefined} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    cleanup();
  });
});

const NOW = Date.parse('2026-10-08T14:00:00Z');

describe('the analyst’s controls', () => {
  let client: FakeClient;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    client = {};
    request = vi.fn((method: string) =>
      Promise.resolve(
        method === 'tools.invoke'
          ? { ok: true, status: 'ok', callId: 'c', output: { sessionId: 's_1', interrupted: true } }
          : { approval: change(), replacement: null },
      ),
    );
    client.request = request as FakeClient['request'];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    patch(analystStore, { sessions: null, approvals: null, transcript: null, selected: null, unread: false });
    setComposerDraft('');
  });

  const wrap = (node: ReactNode) => render(<TestRuntime client={client}>{node}</TestRuntime>);
  const calls = (method: string) =>
    request.mock.calls
      .filter(([m, p]) => m === method || (m === 'tools.invoke' && (p as { name?: string }).name === method))
      .map(([m, p]) => (m === 'tools.invoke' ? (p as { input: object }).input : (p as object)));

  it('arms Allow after 600 ms, never focused for you; Deny and Allow resolve as the user', async () => {
    wrap(<InlineApproval approval={change()} />);
    const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow' });
    expect(document.activeElement).not.toBe(allow);
    expect(allow.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(allow.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(allow);
      await Promise.resolve();
    });
    expect(calls('approvals.resolve')).toEqual([
      {
        approvalId: 'a_2',
        decision: 'approve',
        previewHash: 'h1',
        deadline: expect.any(Number),
        idempotencyKey: expect.any(String),
      },
    ]);
    cleanup();
    request.mockClear();
    wrap(<InlineApproval approval={change()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
      await Promise.resolve();
    });
    expect(calls('approvals.resolve')).toEqual([
      {
        approvalId: 'a_2',
        decision: 'reject',
        previewHash: 'h1',
        deadline: expect.any(Number),
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  it('a change asked while the analyst is out of sight arms Allow only 600 ms after it is shown', () => {
    const at = (shown: boolean) => (
      <ShownContext.Provider value={shown}>
        <InlineApproval approval={change()} />
      </ShownContext.Provider>
    );
    const { rerender } = wrap(at(false));
    const allow = screen.getByRole<HTMLButtonElement>('button', { name: 'Allow' });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(allow.disabled).toBe(true);
    rerender(<TestRuntime client={client}>{at(true)}</TestRuntime>);
    act(() => {
      vi.advanceTimersByTime(599);
    });
    expect(allow.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(allow.disabled).toBe(false);
  });

  it('edits a change in place and resolves it as an edit with the new input', async () => {
    wrap(<InlineApproval approval={change()} />);
    expect(screen.getByText('Add layer')).toBeTruthy();
    expect(screen.getByText('VWAP on NQ Z6 5m')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '50' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    expect(calls('approvals.resolve')).toEqual([
      {
        approvalId: 'a_2',
        decision: 'edit',
        previewHash: 'h1',
        input: { tileId: 'c1', period: 50 },
        deadline: expect.any(Number),
        idempotencyKey: expect.any(String),
      },
    ]);
  });

  it('keeps Stop for the whole turn and Send beside it once there is text: Enter does the follow-up, Ctrl+Enter or a Ctrl-click the other', async () => {
    const onStop = vi.fn();
    const onSend = vi.fn();
    const composer = (working: boolean, followUp: Delivery) => (
      <PlatformProvider value="other">
        <AgentComposer
          providers={[]}
          pick={null}
          sessionProvider={null}
          reader={null}
          working={working}
          sending={false}
          followUp={followUp}
          queue={queueView()}
          onPick={() => undefined}
          onSend={onSend}
          onStop={onStop}
        />
      </PlatformProvider>
    );
    setComposerDraft('');
    wrap(composer(true, 'steer'));
    expect(screen.queryByRole('button', { name: 'Steer message' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: 'take the ORB with more risk if it absorbs' } });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    const steer = screen.getByRole<HTMLButtonElement>('button', { name: 'Steer message' });
    expect(steer.disabled).toBe(false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith(true);
    fireEvent.click(steer, { ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith(true);
    fireEvent.click(steer);
    expect(onSend).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(window, { key: 'Control', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
    fireEvent.keyUp(window, { key: 'Control', ctrlKey: false });
    expect(screen.getByRole('button', { name: 'Steer message' })).toBeTruthy();
    cleanup();

    wrap(composer(true, 'queue'));
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
    cleanup();

    setComposerDraft('');
    onSend.mockClear();
    wrap(composer(false, 'steer'));
    const idle = screen.getByRole('textbox');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    fireEvent.change(idle, { target: { value: 'Brief me' } });
    fireEvent.keyDown(idle, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(idle, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();

    applySessions({ type: 'snapshot', sessions: [session({ status: 'running' })] });
    await expect(stopAnalyst()).resolves.toBe(true);
    expect(calls('agent.interrupt')).toEqual([{ sessionId: 's_1' }]);
  });

  it('reads Analyst, what it does and for how long, and the count on its tab', () => {
    applySessions({ type: 'snapshot', sessions: [session({ status: 'needs_you' })] });
    applyApprovals({ type: 'snapshot', pending: [approval()] });
    beginTranscript('s_1');
    for (const [i, ev] of (
      [
        { type: 'turn_started', turnId: 't_1' },
        { type: 'status', state: 'waiting_approval', text: null, step: null, totalSteps: null },
      ] as AgentEvent[]
    ).entries())
      applyEnvelope(env(i, ev, (NOW - 41_000) * 1e6), true, NOW);
    wrap(<AnalystTab />);
    const tab = document.querySelector('.an-tab')!;
    expect(tab.textContent).toBe('AnalystWaiting for you·41s1');
    expect(screen.getByRole('img', { name: '1 needs you' }).textContent).toBe('1');
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(tab.querySelector('time')?.textContent).toBe('43s');
  });
});

describe('what the analyst sees', () => {
  const NQ = 'NQZ6.CME';
  const layer = (id: string, kind: string, params: object): ChartLayer => ({
    id,
    kind,
    params: params as ChartLayer['params'],
    visible: true,
    namespace: 'user',
    sessionId: null,
  });
  const level = (vendor: string, pkg: string, field: string, group: string, price: number): Level => ({
    key: `${vendor}.${pkg}.${field}`.toLowerCase(),
    instrument: NQ,
    label: field,
    short: null,
    group,
    price,
    unavailableReason: null,
    nativePrice: null,
    source: { vendor, package: pkg, field, basis: 'NQ', endpoint: null, asOf: 0, conversion: null },
    concept: null,
  });
  const priorDay = [level('Tessera', 'Concepts', 'pdh', 'pd', 20700), level('Tessera', 'Concepts', 'pdl', 'pd', 20500)];
  const mockGamma = [
    level('Zeta', 'Classic', 'zero_gamma', 'gamma', 20640),
    level('Zeta', 'Classic', 'major_pos_vol', 'gamma', 20800),
  ];

  function Sees() {
    return <p data-testid="sees">{useChartSight().sees}</p>;
  }

  async function seen(gamma: Level[], printBars?: PrintBars): Promise<string | null> {
    putLayout({
      id: 'sees',
      name: 'Trade',
      revision: 1,
      updatedAt: 0,
      activeChartId: 'chart-1',
      dock: null,
      trade: null,
      charts: {
        'chart-1': {
          ...defaultChartState('chart-1', 'Chart 1', NQ, '5m', null),
          ...(printBars ? { printBars } : {}),
          layers: [
            layer('volume-1', 'volume', {}),
            layer('vwap-1', 'vwap', {}),
            layer('levels-zeta', 'levels', {
              vendor: 'Zeta',
              package: 'Classic',
              fields: ['zero_gamma', 'major_pos_vol', 'major_neg_vol'],
            }),
            layer('levels-pd', 'levels', { group: 'pd', fields: ['pdh', 'pdl'] }),
          ],
        },
      },
    });
    setActiveChartRef({ layoutId: 'sees', tileId: 'chart-1', source: null });
    const answers: Record<string, LevelsUpdate | null> = {
      'intel.levels': gamma.length > 0 ? { instrument: NQ, levels: gamma, asOf: 0, provider: 'mock-gamma' } : null,
      'concepts.levels': { instrument: NQ, levels: priorDay, asOf: 0, provider: 'tessera-concepts' },
    };
    const client: FakeClient = {
      subscribe: (topic, _params, handler) => {
        const answer = answers[topic];
        if (answer) queueMicrotask(() => handler(answer, { topic, seq: 0, subscriptionId: topic }));
        return () => undefined;
      },
    };
    render(
      <TestRuntime client={client}>
        <Sees />
      </TestRuntime>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const text = screen.getByTestId('sees').textContent;
    cleanup();
    setActiveChartRef(null);
    return text;
  }

  it('names Zeta only while the chart has Zeta levels to draw', async () => {
    expect(await seen([])).toBe('Sees NQ Z6 5m · Volume · VWAP · Prior day');
    expect(await seen(mockGamma)).toBe('Sees NQ Z6 5m · Volume · VWAP · Zeta · Prior day');
  });

  it('names the tick, range or volume bars the chart draws instead of its timeframe', async () => {
    expect(await seen([], { kind: 'range', size: 10 })).toBe('Sees NQ Z6 10R · Volume · VWAP · Prior day');
  });
});
