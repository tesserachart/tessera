import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentProviderInfo,
  AgentSessionSummary,
  Approval,
  ProviderHealth,
} from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  analystStore,
  applySessions,
  EMPTY_ANALYST,
  newConversation,
  selectCurrent,
  selectSession,
} from '../src/analyst/analystStore.ts';
import { IDLE } from '../src/analyst/activity.ts';
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from '../src/app/agentTranscript.ts';
import { Conversation } from '../src/areas/agents/Conversation.tsx';
import { ModelPicker } from '../src/areas/agents/ModelPicker.tsx';
import {
  effortOf,
  findModel,
  pickLabel,
  providerViews,
  resolvePick,
  searchModels,
  unavailableWhy,
} from '../src/areas/agents/models.ts';
import { groupSessions } from '../src/areas/agents/sessions.ts';
import { foldWords, groupWords, stableRows, timelineRows, type Row } from '../src/areas/agents/timeline.ts';
import { read, write } from '../src/app/store.ts';
import { providerHealth } from './support/providers.ts';

afterEach(cleanup);

const env = (seq: number, event: AgentEvent): AgentEventEnvelope => ({
  sessionId: 's_1',
  seq,
  ts: seq,
  turnId: 't_1',
  event,
});

const fold = (events: AgentEvent[], from: Transcript = EMPTY_TRANSCRIPT): Transcript =>
  events.reduce((t, e, i) => reduceTranscript(t, env(from.lastSeq + 1 + i, e)), from);

const started = (callId: string, tool = 'chart.get_state'): AgentEvent => ({
  type: 'tool_call_started',
  callId,
  tool,
  risk: 'read',
  args: { tileId: 'c1' },
  title: null,
});
const finished = (callId: string, tool = 'chart.get_state'): AgentEvent => ({
  type: 'tool_call_finished',
  callId,
  tool,
  risk: 'read',
  outcome: 'ok',
  resultSummary: null,
  artifactRefs: [],
  durationMs: 120,
  error: null,
  result: '{"last":487.35}',
});
const ask = (text: string): AgentEvent => ({ type: 'user_message', text, attachments: [] });
const say = (id: string, text: string): AgentEvent => ({ type: 'assistant_message', messageId: id, text, blocks: [] });
const done = (end: 'completed' | 'interrupted' | 'failed' = 'completed'): AgentEvent => ({
  type: 'turn_finished',
  turnId: 't_1',
  end,
  durationMs: 12_300,
  toolCalls: 2,
});

const kinds = (rows: Row[]) => rows.map((r) => r.kind);
const rows = (t: Transcript, over: Partial<Parameters<typeof timelineRows>[0]> = {}) =>
  timelineRows({ transcript: t, waiting: [], settled: true, working: false, open: new Set(), ...over });

const DRAFTED: AgentEvent[] = [
  ask('Buy the pullback'),
  { type: 'approval_requested', approvalId: 'a_1', draftId: 'd_1', tool: 'orders.submit', kind: 'financial' },
  say('m1', 'Drafted.'),
  done(),
];

const TURN = [
  ask('Where is QQQ?'),
  { type: 'reasoning_summary', text: '**Read** the chart first.\nThen the levels.', durationMs: 1_500 } as AgentEvent,
  started('c1'),
  finished('c1'),
  say('m0', 'Let me look at the levels too.'),
  started('c2', 'levels.get'),
  finished('c2', 'levels.get'),
  say('m1', 'QQQ is **487.35**, below VWAP.'),
  done(),
];

describe('the conversation as rows (T3 Code’s thread)', () => {
  it('reads a card Tessera wrote after a turn ended after that turn’s answer', () => {
    const report: AgentEvent = {
      type: 'card',
      card: {
        id: 'card-session-s_1',
        body: {
          kind: 'trading_session',
          date: '2026-10-02',
          accountId: 'paper-main',
          accountName: 'Paper',
          environment: 'paper',
          startedAt: 1,
          endedAt: 2,
          trades: [],
          netPnl: 0,
          log: 'Flat all session.',
          issues: [],
        },
        actions: [],
        updatedAt: 2,
      },
    };
    const t = fold([ask('The session is over'), started('c1'), finished('c1'), say('m1', 'My log.'), done(), report]);
    expect(kinds(rows(t))).toEqual(['user', 'fold', 'assistant', 'card']);
  });

  it('folds a finished turn’s work behind one line and keeps its answer out', () => {
    const t = fold(TURN);
    const r = rows(t);
    expect(kinds(r)).toEqual(['user', 'fold', 'assistant']);
    const f = r[1] as Extract<Row, { kind: 'fold' }>;
    expect(foldWords(f)).toBe('Worked for 12.3s');
    expect(r[2]).toMatchObject({ kind: 'assistant', text: 'QQQ is **487.35**, below VWAP.', answer: true });
  });

  it('opens the fold into its steps, consecutive work grouped, and a group into its entries', () => {
    const t = fold(TURN);
    const fk = rows(t)[1]!.key;
    const open = rows(t, { open: new Set([fk]) });
    expect(kinds(open)).toEqual(['user', 'fold', 'group', 'assistant', 'entry', 'assistant']);
    const group = open[2] as Extract<Row, { kind: 'group' }>;
    expect(group.depth).toBe(1);
    expect(groupWords(group.entries).text).toBe('Thought for 1.5s · Used 1 tool');
    const deeper = rows(t, { open: new Set([fk, group.key]) });
    expect(kinds(deeper)).toEqual(['user', 'fold', 'group', 'entry', 'entry', 'assistant', 'entry', 'assistant']);
    const tool = deeper.find((x) => x.kind === 'entry' && x.entry.kind === 'tool');
    expect(tool).toMatchObject({ depth: 2 });
    expect(tool?.kind === 'entry' && tool.entry.kind === 'tool' ? tool.entry.args : null).toEqual({ tileId: 'c1' });
    expect(tool?.kind === 'entry' && tool.entry.kind === 'tool' ? tool.entry.result : null).toBe('{"last":487.35}');
  });

  it('shows a running turn as it happens, with the live line last', () => {
    const t = fold([ask('Where is QQQ?'), started('c1')]);
    const r = rows(t, { working: true });
    expect(kinds(r)).toEqual(['user', 'entry', 'live']);
    expect(r[1]).toMatchObject({ kind: 'entry', entry: { outcome: 'running' } });
  });

  it('keeps a waiting approval and an error out of the fold, and says how a stopped turn ended', () => {
    const waiting = { id: 'a_1', callId: 'c9', sessionId: 's_1' } as Approval;
    const t = fold([
      ask('Buy the pullback'),
      started('c1'),
      finished('c1'),
      { type: 'approval_requested', approvalId: 'a_1', draftId: 'd_1', tool: 'orders.submit', kind: 'financial' },
      { type: 'error', code: 'provider', message: 'Codex dropped', retryable: true },
      done('interrupted'),
    ]);
    const r = rows(t, { waiting: [waiting] });
    expect(kinds(r)).toEqual(['user', 'fold', 'approval', 'error', 'end']);
    expect(foldWords(r[4] as Extract<Row, { kind: 'end' }>)).toBe('Stopped after 12.3s');
    const other = { id: 'a_2', callId: 'c8', sessionId: null } as Approval;
    expect(kinds(rows(t, { waiting: [waiting, other] })).at(-1)).toBe('approval');
  });

  it('shares unchanged rows between renders, so only the streaming answer renders again', () => {
    let t = fold([ask('Hi'), { type: 'assistant_delta', messageId: 'm1', text: 'Hel' }]);
    const first = rows(t, { working: true });
    const shared = new Map(first.map((r) => [r.key, r]));
    const again = stableRows(shared, rows(t, { working: true }));
    expect(again.every((r, i) => r === first[i])).toBe(true);
    t = fold([{ type: 'assistant_delta', messageId: 'm1', text: 'lo' }], t);
    const next = stableRows(shared, rows(t, { working: true }));
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    expect(next[1]).toMatchObject({ text: 'Hello', streaming: true });
  });

  it('keeps a draft shown apart out of the rows, still waiting rather than folded away as expired', () => {
    const draft = { id: 'a_1', callId: 'c9', sessionId: 's_1', kind: 'financial' } as Approval;
    const t = fold(DRAFTED);
    const apart = (a: Approval) => a.kind === 'financial';
    expect(kinds(rows(t, { waiting: [draft], shownApart: apart }))).toEqual(['user', 'assistant']);
    expect(kinds(rows(t, { waiting: [], shownApart: apart }))).toEqual(['user', 'fold', 'assistant']);
  });
});

describe('the conversation', () => {
  const LAID_OUT = { offsetHeight: 600, scrollHeight: 2000 };
  beforeEach(() => {
    for (const [key, px] of Object.entries(LAID_OUT))
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  });
  afterEach(() => {
    for (const key of Object.keys(LAID_OUT)) Reflect.deleteProperty(HTMLElement.prototype, key);
  });
  const draft = { id: 'a_1', callId: 'c9', sessionId: 's_1', kind: 'financial' } as Approval;
  const view = (sessionId: string, transcript = fold(TURN), waiting: readonly Approval[] = []) => (
    <TooltipProvider>
      <Conversation
        sessionId={sessionId}
        transcript={transcript}
        waiting={waiting}
        settled
        working={false}
        activity={IDLE}
        renderApproval={(a) => <p>card {a.id}</p>}
        onFollowUp={() => undefined}
      />
    </TooltipProvider>
  );

  it('shows a waiting draft under the log, its request not folded away as finished work', () => {
    render(view('s_1', fold(DRAFTED), [draft]));
    expect(within(screen.getByRole('region', { name: 'Waiting drafts' })).getByText('card a_1')).toBeTruthy();
    const log = screen.getByRole('log', { name: 'Conversation' });
    expect(within(log).getByText('Drafted.')).toBeTruthy();
    expect(within(log).queryByText('card a_1')).toBeNull();
    expect(within(log).queryByText(/Worked for/)).toBeNull();
  });

  it('opens another session at its newest line, though the last one was read further up', () => {
    const { container, rerender } = render(view('s_1'));
    container.querySelector('.ag-scroll-view')!.scrollTop = 0;
    fireEvent.wheel(screen.getByRole('log', { name: 'Conversation' }), { deltaY: -120 });
    expect(screen.getByRole('button', { name: 'Latest' })).toBeTruthy();
    rerender(view('s_2'));
    expect(screen.queryByRole('button', { name: 'Latest' })).toBeNull();
  });
});

describe('the conversation entrances', () => {
  const LAID_OUT = { offsetHeight: 600, scrollHeight: 2000 };
  beforeEach(() => {
    for (const [key, px] of Object.entries(LAID_OUT))
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  });
  afterEach(() => {
    for (const key of Object.keys(LAID_OUT)) Reflect.deleteProperty(HTMLElement.prototype, key);
  });
  const at = (ts: number, seq: number, event: AgentEvent): AgentEventEnvelope => ({ ...env(seq, event), ts });
  const view = (transcript: Transcript) => (
    <TooltipProvider>
      <Conversation
        sessionId="s_1"
        transcript={transcript}
        waiting={[]}
        settled
        working={false}
        activity={IDLE}
        renderApproval={(a) => <p>card {a.id}</p>}
        onFollowUp={() => undefined}
      />
    </TooltipProvider>
  );
  const historyOf = (container: HTMLElement, text: string) =>
    [...container.querySelectorAll('.ag-row')].find((r) => r.textContent.includes(text))?.hasAttribute('data-history');

  it('keeps a reopened chat still and lets a message that arrives live animate', () => {
    const old = Date.now() - 3_600_000;
    const reopened = [ask('Old question'), say('m_1', 'Old answer')].reduce(
      (t, e, i) => reduceTranscript(t, at(old + i, i, e)),
      EMPTY_TRANSCRIPT,
    );
    const { container, rerender } = render(view(reopened));
    expect(historyOf(container, 'Old question')).toBe(true);
    expect(historyOf(container, 'Old answer')).toBe(true);
    rerender(view(reduceTranscript(reopened, at(Date.now(), 10, say('m_2', 'Fresh answer')))));
    expect(historyOf(container, 'Fresh answer')).toBe(false);
    expect(historyOf(container, 'Old answer')).toBe(true);
  });
});

describe('react-markdown, as the conversation calls it', () => {
  it('is a plain function: called outside a render, it gives the parsed tree', () => {
    const tree = ReactMarkdown({ children: 'QQQ is **487.35**', remarkPlugins: [remarkGfm] });
    const { container } = render(<>{tree}</>);
    expect(container.querySelector('strong')?.textContent).toBe('487.35');
  });
});

const info = (over: Partial<AgentProviderInfo> = {}): AgentProviderInfo => ({
  id: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  status: 'disconnected',
  message: 'Not signed in',
  models: [
    {
      id: 'claude-fable-5-1',
      label: 'Claude Fable 5.1',
      description: null,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'max', label: 'Max' },
      ],
      defaultEffort: 'medium',
    },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', description: null, efforts: [], defaultEffort: null },
  ],
  defaultModel: 'claude-fable-5-1',
  readsPdfs: true,
  ...over,
});
const codexInfo = info({
  id: 'codex',
  name: 'Codex',
  status: 'ok',
  message: 'ChatGPT · plus',
  models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra', description: null, efforts: [], defaultEffort: null }],
  defaultModel: 'gpt-6-astra',
  readsPdfs: false,
});
const health = (id: string, status: ProviderHealth['status'], message: string | null = null): ProviderHealth =>
  providerHealth({ providerId: id, kind: 'agent', status, message });
const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ plan',
  preset: 'Trader',
  provider: 'claude-code',
  model: 'claude-fable-5-1',
  mode: 'auto_modify',
  status: 'idle',
  origin: { kind: 'user' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('the model selector’s logic', () => {
  it('takes each provider’s live health over the listed one, and says how to sign in', () => {
    const views = providerViews([info(), codexInfo], [health('claude-code', 'ok', 'Claude · Max')]);
    expect(views[0]).toMatchObject({ ready: true, message: 'Claude · Max' });
    const out = providerViews([info()], []);
    expect(out[0]!.ready).toBe(false);
    expect(unavailableWhy(out[0]!)).toBe('Not signed in. Sign in in Settings › Analyst.');
    expect(providerViews(undefined, [health('codex', 'ok')])).toMatchObject([{ id: 'codex', ready: true, models: [] }]);
  });

  it('runs a session’s own model; a new conversation the last pick, else the first ready default', () => {
    const views = providerViews([info(), codexInfo], []);
    expect(resolvePick(views, session({ effort: 'max' }), null)).toEqual({
      provider: 'claude-code',
      model: 'claude-fable-5-1',
      effort: 'max',
    });
    expect(resolvePick(views, null, { provider: 'claude-code', model: 'claude-opus-5-5', effort: null })).toEqual({
      provider: 'codex',
      model: 'gpt-6-astra',
      effort: null,
    });
    const ready = providerViews([info({ status: 'ok' }), codexInfo], []);
    const last = { provider: 'claude-code', model: 'claude-opus-5-5', effort: null };
    expect(resolvePick(ready, null, last)).toBe(last);
    expect(resolvePick([], null, null)).toBeNull();
  });

  it('reads an effort as the model’s own default when none is picked, and none for a model without', () => {
    const views = providerViews([info({ status: 'ok' })], []);
    const fable = findModel(views, { provider: 'claude-code', model: null, effort: null });
    expect(effortOf(fable, null)).toBe('medium');
    expect(effortOf(fable, 'max')).toBe('max');
    expect(effortOf(fable, 'ultra')).toBe('medium');
    const opus = findModel(views, { provider: 'claude-code', model: 'claude-opus-5-5', effort: null });
    expect(effortOf(opus, 'max')).toBeNull();
    expect(pickLabel(views, { provider: 'claude-code', model: 'claude-opus-5-5', effort: null })).toBe(
      'Claude Opus 5.5',
    );
    expect(searchModels(views, 'opus').map((m) => m.model.id)).toEqual(['claude-opus-5-5']);
  });

  it('draws providers on its rail, the model in use on its trigger, and a signed-out provider’s models off', () => {
    const views = providerViews([codexInfo, info()], []);
    let picked: unknown = null;
    render(
      <TooltipProvider>
        <ModelPicker
          providers={views}
          pick={{ provider: 'codex', model: 'gpt-6-astra', effort: null }}
          sessionProvider={null}
          onPick={(p) => {
            picked = p;
          }}
        />
      </TooltipProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Model: GPT-6 Astra' });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Codex' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }));
    expect(screen.getByText(/Sign in in Settings › Analyst/)).toBeTruthy();
    const opus = screen.getByRole('option', { name: /Claude Opus 5.5/ });
    expect(opus.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByRole('option', { name: /GPT-6 Astra/ }));
    expect(picked).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: null });
  });
});

describe('the sessions down the left', () => {
  afterEach(() => write(analystStore, EMPTY_ANALYST));

  it('groups them by when each was last active, newest first', () => {
    const now = new Date(2026, 9, 8, 15, 0).getTime();
    const at = (d: number, h = 10) => new Date(2026, 9, 8 - d, h, 0).getTime();
    const groups = groupSessions(
      [
        session({ id: 'a', updatedAt: at(0, 9) }),
        session({ id: 'b', updatedAt: at(0, 14) }),
        session({ id: 'c', updatedAt: at(1) }),
        session({ id: 'd', updatedAt: at(5) }),
        session({ id: 'e', updatedAt: at(30) }),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ['Today', ['b', 'a']],
      ['Yesterday', ['c']],
      ['Previous 7 days', ['d']],
      ['Earlier', ['e']],
    ]);
  });

  it('opens a new conversation with no session shown until its first message', () => {
    applySessions({ type: 'snapshot', sessions: [session()] });
    expect(selectCurrent(read(analystStore))?.id).toBe('s_1');
    newConversation();
    expect(selectCurrent(read(analystStore))).toBeNull();
    selectSession('s_1');
    expect(selectCurrent(read(analystStore))?.id).toBe('s_1');
  });
});
