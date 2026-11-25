import type {
  AccountUpdate,
  AgentEvent,
  AgentEventEnvelope,
  AgentSessionSummary,
  Approval,
  Environment,
  OrderPreview,
  ProviderHealth,
} from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from '../src/app/agentTranscript.ts';
import { dismissApproval, NO_APPROVALS, reduceApprovals } from '../src/app/approvals.ts';
import { ClockContext, RuntimeClock } from '../src/app/clock.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';
import { BRACKET_ON } from './support/oco.ts';
import { patch } from '../src/app/store.ts';
import { tradeSettingsStore } from '../src/state/tradeSettings.ts';
import { ApprovalCard } from '../src/shell/ApprovalCard.tsx';
import { EMPTY_SHELL_DATA, ShellDataContext } from '../src/shell/shellData.ts';
import { TranscriptView } from '../src/shell/AgentTranscript.tsx';
import { emptyAction, NO_PROVIDER, sendPlan } from '../src/shell/analyst.ts';
import {
  applyEdit,
  approvalEnv,
  approveLabel,
  describeApproval,
  draftedBy,
  editFields,
  expiresIn,
  orderLines,
  validUntil,
} from '../src/shell/approval.ts';
import { providerHealth } from './support/providers.ts';

const env = (seq: number, event: AgentEvent): AgentEventEnvelope => ({
  sessionId: 's_1',
  seq,
  ts: seq,
  turnId: 't_1',
  event,
});

const fold = (events: AgentEvent[], from: Transcript = EMPTY_TRANSCRIPT): Transcript =>
  events.reduce((t, e, i) => reduceTranscript(t, env(from.lastSeq + 1 + i, e)), from);

const provider = (providerId: string, displayName: string, status: ProviderHealth['status']): ProviderHealth =>
  providerHealth({ providerId, kind: 'agent', displayName, status });

describe('the analyst’s empty log', () => {
  const codex = provider('codex', 'Codex', 'ok');
  const claude = provider('claude-code', 'Claude Code', 'ok');

  it('offers every connected model, in the runtime’s order, so either can start the first session', () => {
    expect(emptyAction([codex, claude], null, true)).toEqual({ kind: 'start', providers: [codex, claude] });
    const down = provider('claude-code', 'Claude Code', 'down');
    const feed = { ...provider('rithmic-apex', 'Apex · Rithmic', 'ok'), kind: 'market_data' as const };
    expect(emptyAction([feed, down, codex], null, true)).toEqual({ kind: 'start', providers: [codex] });
  });

  it('asks to connect one when none is ready or the runtime cannot start a session, and steps aside for a session', () => {
    expect(emptyAction([provider('codex', 'Codex', 'down')], null, true)).toEqual({ kind: 'connect' });
    expect(emptyAction([codex, claude], null, false)).toEqual({ kind: 'connect' });
    expect(emptyAction([codex], { id: 'S1' } as AgentSessionSummary, true)).toBeNull();
  });

  it('a question asked before a session starts one with the first connected model; without a model it says so', () => {
    const empty = emptyAction([codex, claude], null, true);
    expect(sendPlan({ provider: codex, canSend: true, session: null, empty })).toEqual({
      kind: 'start',
      providerId: 'codex',
    });
    const session = { id: 'S1' } as AgentSessionSummary;
    expect(sendPlan({ provider: codex, canSend: true, session, empty: null })).toEqual({
      kind: 'send',
      sessionId: 'S1',
    });
    const down = provider('codex', 'Codex', 'down');
    expect(sendPlan({ provider: down, canSend: true, session: null, empty: emptyAction([down], null, true) })).toEqual({
      kind: 'blocked',
      text: NO_PROVIDER,
    });
    const blocked = sendPlan({ provider: codex, canSend: true, session: null, empty: { kind: 'connect' } });
    expect(blocked.kind === 'blocked' && blocked.text).not.toMatch(/Agents/);
  });
});

describe('agent transcript', () => {
  it('streams deltas into one assistant message and settles it with its blocks', () => {
    const t = fold([
      { type: 'user_message', text: 'Test the flip', attachments: [] },
      { type: 'assistant_delta', messageId: 'm1', text: 'First ' },
      { type: 'assistant_delta', messageId: 'm1', text: 'touches' },
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
    expect(t.items[1]).toMatchObject({ text: 'First touches', streaming: true });
    const done = fold(
      [
        {
          type: 'assistant_message',
          messageId: 'm1',
          text: 'First touches reverted.',
          blocks: [{ kind: 'measured', title: null, text: '', sourceCallId: null, rows: [['Reverted', '61.7%']] }],
        },
      ],
      t,
    );
    expect(done.items).toHaveLength(2);
    expect(done.items[1]).toMatchObject({ text: 'First touches reverted.', streaming: false, key: '1' });
  });

  it('merges a tool call’s start and finish into one work row', () => {
    const t = fold([
      {
        type: 'tool_call_started',
        callId: 'c1',
        tool: 'market.get_bars',
        risk: 'read',
        args: {},
        title: 'Loaded bars',
      },
      {
        type: 'tool_call_finished',
        callId: 'c1',
        tool: 'market.get_bars',
        risk: 'read',
        outcome: 'ok',
        resultSummary: '92,316 bars',
        artifactRefs: [],
        durationMs: 420,
        error: null,
      },
    ]);
    expect(t.items).toEqual([
      expect.objectContaining({ kind: 'tool', title: 'Loaded bars', outcome: 'ok', summary: '92,316 bars' }),
    ]);
  });

  it('skips replayed envelopes, clears follow-ups on a new message and status on turn end', () => {
    let t = fold([
      { type: 'status', state: 'running_tool', text: 'Loading bars', step: 1, totalSteps: 3 },
      { type: 'suggestions', items: [{ label: 'Split by volatility', tool: 'research.run_event_study', input: {} }] },
    ]);
    expect(t.status?.text).toBe('Loading bars');
    expect(t.suggestions).toHaveLength(1);
    expect(reduceTranscript(t, env(0, { type: 'user_message', text: 'again', attachments: [] }))).toBe(t);
    t = fold([{ type: 'turn_finished', turnId: 't_1', end: 'completed', durationMs: 16_400, toolCalls: 5 }], t);
    expect(t.status).toBeNull();
    t = fold([{ type: 'user_message', text: 'next', attachments: [] }], t);
    expect(t.suggestions).toEqual([]);
  });

  it('stops streaming an answer whose turn ended without its closing message, as a stop or a failure ends it', () => {
    const t = fold([
      { type: 'turn_started', turnId: 't_1' },
      { type: 'assistant_delta', messageId: 'm_1', text: 'Reading the' },
      { type: 'turn_finished', turnId: 't_1', end: 'interrupted', durationMs: 900, toolCalls: 0 },
    ]);
    expect(t.items.filter((it) => it.kind === 'assistant')).toEqual([
      expect.objectContaining({ text: 'Reading the', streaming: false }),
    ]);
  });

  it('counts the live line from the turn’s start, and starts a clock for a status that comes without one', () => {
    let t = fold([
      { type: 'turn_started', turnId: 't_1' },
      { type: 'status', state: 'thinking', text: null, step: null, totalSteps: null },
      { type: 'status', state: 'running_tool', text: 'Reading NQ 5m bars', step: 1, totalSteps: 2 },
    ]);
    expect(t.turnStartedAt).toBe(0);
    expect(t.status).toMatchObject({ text: 'Reading NQ 5m bars', since: 0 });
    t = fold(
      [
        { type: 'turn_finished', turnId: 't_1', end: 'completed', durationMs: 3_000, toolCalls: 1 },
        { type: 'status', state: 'idle', text: null, step: null, totalSteps: null },
      ],
      t,
    );
    expect(t.turnStartedAt).toBeNull();
    t = fold([{ type: 'status', state: 'thinking', text: null, step: null, totalSteps: null }], t);
    expect(t.turnStartedAt).toBe(5_000);
    expect(t.status?.since).toBe(5_000);
  });

  it('says what the analyst is doing with an elapsed time that ticks, and nothing that loops', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(10_000);
      const t = fold([
        { type: 'turn_started', turnId: 't_1' },
        { type: 'status', state: 'running_tool', text: 'Reading NQ 5m bars', step: 1, totalSteps: 2 },
      ]);
      render(
        <ClockContext.Provider value={new RuntimeClock()}>
          <TranscriptView transcript={{ ...t, turnStartedAt: 8_000 }} notices={[]} onFollowUp={() => undefined} />
        </ClockContext.Provider>,
      );
      const words = screen.getByRole('status');
      expect(words.textContent).toBe('Reading NQ 5m bars');
      const live = words.parentElement!;
      expect(live.textContent).toBe('Reading NQ 5m bars·2s');
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(live.textContent).toBe('Reading NQ 5m bars·8s');
      expect(live.querySelector('.dots, i')).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('updates an approval row when it resolves', () => {
    const t = fold([
      { type: 'approval_requested', approvalId: 'a1', draftId: 'd1', tool: 'orders.submit', kind: 'financial' },
      { type: 'approval_resolved', approvalId: 'a1', status: 'rejected' },
    ]);
    expect(t.items).toEqual([expect.objectContaining({ kind: 'approval', status: 'rejected', tool: 'orders.submit' })]);
  });

  it('stamps each line with the time it first appeared, for the log’s time column', () => {
    const at = Date.parse('2026-10-02T14:36:00-04:00');
    let t = reduceTranscript(EMPTY_TRANSCRIPT, {
      ...env(1, { type: 'assistant_delta', messageId: 'm1', text: 'Reclaimed ' }),
      ts: at * 1e6,
    });
    t = reduceTranscript(t, {
      ...env(2, { type: 'assistant_message', messageId: 'm1', text: 'Reclaimed the flip.', blocks: [] }),
      ts: (at + 5_000) * 1e6,
    });
    expect(t.items).toHaveLength(1);
    expect(t.times).toEqual({ '1': at });
  });
});

const preview: OrderPreview = {
  request: {
    accountId: 'paper-main',
    instrument: 'QQQ.NASDAQ',
    side: 'buy',
    qty: 25,
    orderType: 'limit',
    limitPrice: 487.25,
    stopPrice: null,
    tif: 'day',
    bracket: { stopLoss: 485.3, takeProfit: null },
    clientOrderId: null,
    reduceOnly: false,
  },
  environment: 'paper',
  restatement: 'BUY 25 QQQ LMT 487.25 DAY',
  referencePrice: 487.85,
  estPrice: 487.25,
  estValue: { amount: 12181.25, currency: 'USD' },
  estFees: null,
  riskToStop: { amount: 48.75, currency: 'USD' },
  buyingPowerAfter: null,
  positionAfter: 125,
  checks: [],
  createdAt: 0,
};

const approval = (environment: Environment | null = 'paper', over: Partial<Approval> = {}): Approval => ({
  id: 'a_1',
  kind: 'financial',
  status: 'pending',
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sessionId: 's_1',
  callId: 'c_1',
  tool: 'orders.submit',
  risk: 'financial',
  input: {},
  preview: preview,
  previewHash: 'h1',
  draftId: 'd_1',
  environment,
  instrument: 'QQQ.NASDAQ',
  createdAt: 0,
  staleAt: Date.now() + 60_000,
  maxTicks: null,
  ticksSeen: 0,
  resolution: null,
  replacedBy: null,
  replaces: null,
  ...over,
});

describe('approval rules', () => {
  it('draws a draft in its own account’s environment, whatever the window’s', () => {
    expect(approvalEnv(approval('paper'))).toBe('paper');
    expect(approvalEnv(approval('eval'))).toBe('eval');
    expect(approvalEnv(approval('funded'))).toBe('live');
    expect(approvalEnv(approval(null))).toBe('live');
    expect(approvalEnv(approval(null, { kind: 'modify' }))).toBe('paper');
  });

  it('names the environment; every environment approves on a click', () => {
    expect(approveLabel('financial', 'paper')).toBe('Approve on paper');
    expect(approveLabel('financial', 'live')).toBe('Approve on LIVE');
    expect(approveLabel('financial', 'eval')).toBe('Approve on eval');
    expect(approveLabel('modify', null)).toBe('Approve change');
    expect(expiresIn(48_200)).toBe('expires in 0:49');
    expect(expiresIn(808_000)).toBe('expires in 13:28');
    expect(expiresIn(0)).toBe('expired');
    const now = Date.parse('2026-10-02T14:42:30-04:00');
    expect(validUntil(Date.parse('2026-10-02T14:53:00-04:00'), now)).toBe('valid until 14:53');
    expect(validUntil(now - 1, now)).toBe('expired');
  });

  it('says who drafted it: the plan (the session) and the analyst, an MCP client, or you', () => {
    expect(draftedBy({ kind: 'agent', sessionId: 's_1', provider: 'codex' }, 'NQ gamma plan')).toBe(
      'NQ gamma plan · drafted by the analyst',
    );
    expect(draftedBy({ kind: 'agent', sessionId: 's_1', provider: 'codex' }, null)).toBe('Drafted by the analyst');
    const desktop = {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      kind: 'claude-desktop',
      policy: 'supervised',
      createdAt: 0,
      lastUsedAt: null,
    } as const;
    expect(draftedBy({ kind: 'external', clientId: 'claude-desktop' }, null, [desktop])).toBe(
      'Drafted by Claude Desktop',
    );
    expect(
      draftedBy({ kind: 'external', clientId: 'other' }, null, [
        { ...desktop, id: 'other', kind: 'other', name: 'MCP client' },
      ]),
    ).toBe('Drafted by an MCP client');
    expect(draftedBy({ kind: 'external', clientId: 'cursor-2' })).toBe('Drafted by an MCP client');
    expect(draftedBy({ kind: 'user' })).toBe('Drafted by you');
  });

  it('restates an order in the card’s words', () => {
    const v = describeApproval(approval());
    expect(v.heading).toBe('Draft');
    expect(v.order).toMatchObject({ side: 'Buy', qty: '25', symbol: 'QQQ', pre: 'at', price: '487.25' });
    expect(v.order?.post).toBe('limit · day');
    expect(v.facts).toEqual([
      { label: 'Stop', value: '485.30' },
      { label: 'Risk', value: '$48.75' },
      { label: 'After fill', value: 'Long 125' },
      { label: 'Value', value: '$12,181.25' },
    ]);
    expect(orderLines({ ...preview.request, orderType: 'market', limitPrice: null }).post).toBe('market · day');
  });

  it('offers the tool input’s scalars for an edit and puts the edit back', () => {
    const input = {
      account: 'paper-main',
      symbol: 'NQ',
      qty: 2,
      limitPrice: 20615,
      bracket: { stopLoss: 20598, takeProfit: null },
      flags: [1],
    };
    const fields = editFields(input);
    expect(fields.map((f) => [f.path, f.label, f.value])).toEqual([
      ['symbol', 'Symbol', 'NQ'],
      ['qty', 'Qty', '2'],
      ['limitPrice', 'Limit price', '20615'],
      ['bracket.stopLoss', 'Stop loss', '20598'],
      ['bracket.takeProfit', 'Take profit', ''],
    ]);
    expect(applyEdit(input, fields, { qty: '3', 'bracket.takeProfit': '20,700' })).toEqual({
      ...input,
      qty: 3,
      bracket: { stopLoss: 20598, takeProfit: 20700 },
    });
    expect(() => applyEdit(input, fields, { qty: 'two' })).toThrow('Qty is not a number');
    expect(input.qty).toBe(2);
  });

  it('shows other previews as fields, and blocks approve on a blocking check', () => {
    const v = describeApproval(
      approval(null, { kind: 'modify', tool: 'chart.add_layer', preview: { study: 'vwap', tileId: 'c1' } }),
    );
    expect(v).toMatchObject({ heading: 'Change', title: 'Add layer', order: null, raw: null });
    expect(v.facts).toEqual([
      { label: 'Study', value: 'vwap' },
      { label: 'Tile id', value: 'c1' },
    ]);
    const blocked = describeApproval(
      approval('paper', {
        preview: { ...preview, checks: [{ code: 'bp', severity: 'block', message: 'Not enough buying power' }] },
      }),
    );
    expect(blocked.blocked).toBe(true);
  });

  it('keeps the pending set from snapshot, requested and resolved events, and the drafts that expired', () => {
    let m = reduceApprovals(NO_APPROVALS, { type: 'snapshot', pending: [approval()] });
    m = reduceApprovals(m, { type: 'requested', approval: approval('paper', { id: 'a_2' }) });
    expect([...m.pending.keys()]).toEqual(['a_1', 'a_2']);
    m = reduceApprovals(m, { type: 'resolved', approval: approval('paper', { status: 'approved' }) });
    m = reduceApprovals(m, { type: 'stale', approval: approval('paper', { id: 'a_2', status: 'stale' }) });
    expect(m.pending.size).toBe(0);
    expect(m.expired.map((a) => a.id)).toEqual(['a_2']);
    m = reduceApprovals(m, { type: 'snapshot', pending: [] });
    expect(m.expired.map((a) => a.id)).toEqual(['a_2']);
    m = dismissApproval(m, 'a_2');
    expect(m.expired).toEqual([]);
  });
});

describe('approval card', () => {
  let client: FakeClient;
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'performance',
        'Date',
      ],
    });
    client = {};
    request = vi.fn().mockResolvedValue({ approval: approval(), replacement: null });
    client.request = request as FakeClient['request'];
    patch(tradeSettingsStore, { lastOco: { 'paper-main|QQQ': BRACKET_ON } });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    patch(tradeSettingsStore, { lastOco: {} });
  });

  const mount = (a: Approval) =>
    render(
      <TestRuntime client={client}>
        <button type="button">elsewhere</button>
        <ApprovalCard approval={a} more={0} sessionTitle="Gamma reversion" />
      </TestRuntime>,
    );
  const resolved = () => request.mock.calls.filter(([m]) => m === 'approvals.resolve').map(([, p]) => p as object);

  it('names the plan it serves by the session’s title, not its id or the raw restatement', () => {
    const { container } = mount(approval());
    expect(container.querySelector('.by')?.textContent).toBe(
      'Gamma reversion · drafted by the analyst · target from your bracket',
    );
  });

  it('is never focused by default and arms after 600ms; paper approves on one click', () => {
    mount(approval());
    const btn = screen.getByRole('button', { name: 'Approve on paper' });
    expect(btn.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(btn);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(btn);
    expect(resolved()).toEqual([]);
    act(() => vi.advanceTimersByTime(600));
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(btn);
    expect(resolved()).toMatchObject([{ approvalId: 'a_1', decision: 'approve', previewHash: 'h1' }]);
    expect(resolved()[0]).toEqual(
      expect.objectContaining({ idempotencyKey: expect.any(String), deadline: expect.any(Number) }),
    );
  });

  it('never approves on a chord or Space; focus lands on the card and ↓ reaches Approve', () => {
    mount(approval());
    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole('group', { name: 'Draft' });
    fireEvent.keyDown(card, { key: 'Enter', ctrlKey: true });
    expect(resolved()).toEqual([]);
    act(() => card.focus());
    fireEvent.keyDown(card, { key: 'ArrowDown' });
    const btn = screen.getByRole('button', { name: 'Approve on paper' });
    expect(document.activeElement).toBe(btn);
    fireEvent.keyDown(btn, { key: ' ' });
    expect(resolved()).toEqual([]);
    fireEvent.keyDown(btn, { key: 'Enter' });
    expect(resolved()).toHaveLength(1);
  });

  it('approves on one click on LIVE too, once armed', () => {
    mount(approval('live'));
    const btn = screen.getByRole('button', { name: /^Approve / });
    fireEvent.click(btn);
    expect(resolved()).toEqual([]);
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(btn);
    expect(resolved()).toMatchObject([{ approvalId: 'a_1', decision: 'approve', previewHash: 'h1' }]);
  });

  it('rejects with the preview hash it showed', () => {
    mount(approval());
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(resolved()).toMatchObject([{ approvalId: 'a_1', decision: 'reject', previewHash: 'h1' }]);
  });

  it('names the account by the user’s name for it, on the head and the Approve, never by its id', () => {
    const migrated = {
      account: { id: 'apex-50k-eval', displayName: 'Eval 50K', environment: 'eval' },
    } as unknown as AccountUpdate;
    const a = approval('eval', {
      preview: { ...preview, environment: 'eval', request: { ...preview.request, accountId: 'apex-50k-eval' } },
    });
    const { container } = render(
      <TestRuntime client={client}>
        <ShellDataContext.Provider value={{ ...EMPTY_SHELL_DATA, accounts: [migrated.account] }}>
          <ApprovalCard approval={a} more={0} sessionTitle="Gamma reversion" />
        </ShellDataContext.Provider>
      </TestRuntime>,
    );
    expect(screen.getByRole('button', { name: /^Approve / }).textContent).toContain('Eval 50K');
    expect(container.textContent).toContain('Eval 50K');
    expect(container.textContent).not.toMatch(/apex/i);
  });

  it('edits the tool input and resolves as an edit; approve waits while the edit is open', () => {
    mount(approval('paper', { input: { account: 'paper-main', symbol: 'QQQ', qty: 25, limitPrice: 487.25 } }));
    act(() => vi.advanceTimersByTime(600));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('button', { name: 'Approve on paper' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Qty' }), { target: { value: '30' } });
    expect(resolved()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(resolved()).toMatchObject([
      {
        approvalId: 'a_1',
        decision: 'edit',
        previewHash: 'h1',
        input: { account: 'paper-main', symbol: 'QQQ', qty: 30, limitPrice: 487.25 },
      },
    ]);
  });
});
