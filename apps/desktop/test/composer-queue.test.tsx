import type {
  AgentEvent,
  AgentEventEnvelope,
  AgentSendOutput,
  AgentSessionSummary,
  QueuedMessage,
} from '@tessera/protocol';
import { PlatformProvider, TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analystStore,
  applyEnvelope,
  applySessions,
  beginTranscript,
  EMPTY_ANALYST,
  selectSession,
} from '../src/analyst/analystStore.ts';
import { composerToasts } from '../src/analyst/composerFiles.ts';
import { alternateOf, dispatchMode, followUpOf } from '../src/analyst/dispatch.ts';
import { beginEdit, endWithoutSave, stillQueued } from '../src/analyst/queueEdit.ts';
import { EMPTY_TRANSCRIPT, reduceTranscript, type Transcript } from '../src/app/agentTranscript.ts';
import { queryClient } from '../src/app/queries.ts';
import { patch, write } from '../src/app/store.ts';
import { AnalystWithSessions } from '../src/workspace/tiles/AnalystTile.tsx';
import { agentsUiStore } from '../src/areas/agents/store.ts';
import { timelineRows, type Row } from '../src/areas/agents/timeline.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { DEFAULT_UI, uiStore } from '../src/state/ui.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';

const queued = (id: string, text: string): QueuedMessage => ({ id, text, attachments: [], queuedAt: 0 });

const session = (over: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 's_1',
  title: 'ORB plan',
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

const env = (seq: number, event: AgentEvent, turnId: string | null = 's_1-t1'): AgentEventEnvelope => ({
  sessionId: 's_1',
  seq,
  ts: seq,
  turnId,
  event,
});

const fold = (events: [AgentEvent, string | null][]): Transcript =>
  events.reduce((t, [e, turn], i) => reduceTranscript(t, env(i + 1, e, turn)), EMPTY_TRANSCRIPT);

const ask = (text: string): AgentEvent => ({ type: 'user_message', text, attachments: [] });
const steers = (t: Transcript) => t.items.flatMap((i) => (i.kind === 'user' ? [i.steer] : []));
const say = (id: string, text: string): AgentEvent => ({ type: 'assistant_message', messageId: id, text, blocks: [] });
const tool = (callId: string): AgentEvent => ({
  type: 'tool_call_started',
  callId,
  tool: 'chart.get_state',
  risk: 'read',
  args: {},
  title: null,
});

describe('what Send does (T3 Code’s resolveComposerDispatchMode)', () => {
  it('starts a turn while idle, whatever the follow-up and the modifier', () => {
    for (const followUp of ['steer', 'queue'] as const)
      for (const alternate of [false, true])
        expect(dispatchMode({ running: false, followUp, alternate })).toBe('start');
  });

  it('does the follow-up while running and the other with Cmd or Ctrl', () => {
    expect(dispatchMode({ running: true, followUp: 'steer', alternate: false })).toBe('steer');
    expect(dispatchMode({ running: true, followUp: 'steer', alternate: true })).toBe('queue');
    expect(dispatchMode({ running: true, followUp: 'queue', alternate: false })).toBe('queue');
    expect(dispatchMode({ running: true, followUp: 'queue', alternate: true })).toBe('steer');
    expect(alternateOf('steer')).toBe('queue');
    expect(alternateOf('queue')).toBe('steer');
  });

  it('steers unless the setting says queue', () => {
    expect(followUpOf(undefined)).toBe('steer');
    expect(followUpOf('steer')).toBe('steer');
    expect(followUpOf('queue')).toBe('queue');
    expect(followUpOf('later')).toBe('steer');
  });
});

describe('editing a queued message (T3 Code’s recoverQueuedMessageEdit)', () => {
  const q1 = queued('q1', 'take the ORB');
  const q2 = queued('q2', 'size it down');

  it('sets the user’s draft aside once, even when they move on to another message', () => {
    const first = beginEdit(null, 's_1', q1, 'half a thought');
    expect(first).toEqual({ sessionId: 's_1', queuedId: 'q1', original: 'take the ORB', setAside: 'half a thought' });
    expect(beginEdit(first, 's_1', q2, 'take the ORB')).toMatchObject({ queuedId: 'q2', setAside: 'half a thought' });
  });

  it('knows when the message left the queue or the session changed', () => {
    const edit = beginEdit(null, 's_1', q1, '');
    expect(stillQueued(edit, 's_1', [q1, q2])).toBe(true);
    expect(stillQueued(edit, 's_1', [q2])).toBe(false);
    expect(stillQueued(edit, 's_2', [q1])).toBe(false);
  });

  it('gives the draft back, or keeps an unsaved edit when there was no draft to give back', () => {
    expect(endWithoutSave(beginEdit(null, 's_1', q1, 'mine'), 'take the ORB ')).toEqual({
      draft: 'mine',
      end: 'clean',
    });
    expect(endWithoutSave(beginEdit(null, 's_1', q1, ''), 'take the ORB at 9:45')).toEqual({
      draft: 'take the ORB at 9:45',
      end: 'kept',
    });
    expect(endWithoutSave(beginEdit(null, 's_1', q1, 'mine'), 'take the ORB at 9:45')).toEqual({
      draft: 'mine',
      end: 'discarded',
    });
  });
});

describe('a steer in the conversation', () => {
  const rows = (t: Transcript, working: boolean): Row[] =>
    timelineRows({ transcript: t, waiting: [], settled: true, working, open: new Set() });

  it('lands in the running turn as the user’s words, and stays out of the fold once the turn ends', () => {
    const running = fold([
      [{ type: 'turn_started', turnId: 's_1-t1' }, 's_1-t1'],
      [ask('Plan the ORB'), 's_1-t1'],
      [tool('c1'), 's_1-t1'],
      [ask('take it with more risk if it absorbs'), 's_1-t1'],
    ]);
    expect(steers(running)).toEqual([false, true]);
    expect(rows(running, true).map((r) => r.kind)).toEqual(['user', 'entry', 'user', 'live']);

    const ended = fold([
      [{ type: 'turn_started', turnId: 's_1-t1' }, 's_1-t1'],
      [ask('Plan the ORB'), 's_1-t1'],
      [tool('c1'), 's_1-t1'],
      [ask('take it with more risk if it absorbs'), 's_1-t1'],
      [say('m1', 'Wider stop, half size.'), 's_1-t1'],
      [{ type: 'turn_finished', turnId: 's_1-t1', end: 'completed', durationMs: 9_000, toolCalls: 1 }, 's_1-t1'],
    ]);
    const r = rows(ended, false);
    expect(r.map((x) => x.kind)).toEqual(['user', 'fold', 'user', 'assistant']);
    expect(r[2]).toMatchObject({ text: 'take it with more risk if it absorbs' });
  });

  it('is a new question when it starts its own turn', () => {
    const t = fold([
      [ask('Plan the ORB'), 's_1-t1'],
      [{ type: 'turn_finished', turnId: 's_1-t1', end: 'completed', durationMs: 1, toolCalls: 0 }, 's_1-t1'],
      [ask('Now the close'), 's_1-t2'],
    ]);
    expect(steers(t)).toEqual([false, false]);
  });
});

describe('the composer while the analyst works', () => {
  type Answer = (input: Record<string, unknown>) => unknown;

  function runtime(answers: Record<string, Answer>) {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const fake: FakeClient = {
      request: (method: string, params?: { name?: string; input?: Record<string, unknown> }) => {
        if (method === 'tools.invoke' && params?.name && answers[params.name]) {
          const input = params.input ?? {};
          calls.push({ name: params.name, input });
          return Promise.resolve({ ok: true, status: 'ok', output: answers[params.name]!(input) });
        }
        return new Promise(() => undefined);
      },
    };
    return { fake, calls };
  }

  const sent =
    (over: Partial<AgentSendOutput>): Answer =>
    () => ({
      sessionId: 's_1',
      delivered: 'steered',
      turnId: 's_1-t1',
      queuedId: null,
      notice: null,
      ...over,
    });
  const summary: Answer = () => ({ session: session() });

  function show(fake: FakeClient, s: AgentSessionSummary) {
    act(() => {
      applySessions({ type: 'snapshot', sessions: [s] });
      selectSession('s_1');
      beginTranscript('s_1');
      applyEnvelope(env(1, { type: 'turn_started', turnId: 's_1-t1' }), true, 0);
      applyEnvelope(env(2, ask('Plan the ORB')), true, 0);
      applyEnvelope(env(3, { type: 'status', state: 'thinking', text: null, step: null, totalSteps: null }), true, 0);
    });
    render(
      <TestRuntime client={fake}>
        <PlatformProvider value="other">
          <TooltipProvider>
            <AnalystWithSessions />
          </TooltipProvider>
        </PlatformProvider>
      </TestRuntime>,
    );
    return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Ask the analyst' });
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  afterEach(() => {
    cleanup();
    write(analystStore, EMPTY_ANALYST);
    write(uiStore, DEFAULT_UI);
    patch(agentsUiStore, { editing: null });
    putRuntimeSettings({}, true);
    composerToasts.clear();
    queryClient.clear();
  });

  it('steers on Enter and queues on Ctrl+Enter, each through agent.send, with Stop beside Send', async () => {
    const { fake, calls } = runtime({ 'agent.send': sent({}) });
    const box = show(fake, session());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    fireEvent.change(box, { target: { value: 'take it with more risk if it absorbs' } });
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Steer message' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(calls.at(-1)).toEqual({
      name: 'agent.send',
      input: { sessionId: 's_1', text: 'take it with more risk if it absorbs', delivery: 'steer' },
    });
    expect(box.value).toBe('');

    fireEvent.change(box, { target: { value: 'then journal it' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await settle();
    expect(calls.at(-1)?.input).toEqual({ sessionId: 's_1', text: 'then journal it', delivery: 'queue' });
  });

  it('queues on Enter when the follow-up setting says queue', async () => {
    const { fake, calls } = runtime({ 'agent.send': sent({ delivered: 'queued', turnId: null, queuedId: 'q1' }) });
    putRuntimeSettings({ 'agent.followUp': 'queue' }, true);
    const box = show(fake, session());
    fireEvent.change(box, { target: { value: 'then journal it' } });
    expect(screen.getByRole('button', { name: 'Queue message' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(calls.at(-1)?.input).toMatchObject({ delivery: 'queue' });
  });

  it('says in words when the provider could not take the steer and queued it', async () => {
    const notice = 'Codex can’t take messages mid-run, so it’s queued for when this run ends.';
    const { fake } = runtime({
      'agent.send': sent({ delivered: 'queued', turnId: null, queuedId: 'q1', notice }),
    });
    const box = show(fake, session());
    fireEvent.change(box, { target: { value: 'take it with more risk' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(screen.getByText(notice)).toBeTruthy();
  });

  it('lists the queue in order over the composer and follows it as it drains', () => {
    const { fake } = runtime({});
    show(fake, session({ queue: [queued('q1', 'size it down'), queued('q2', 'then journal it')] }));
    const list = screen.getByRole('region', { name: '2 queued messages' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['size it down', 'then journal it']);
    act(() => applySessions({ type: 'upsert', session: session({ queue: [queued('q2', 'then journal it')] }) }));
    expect(screen.getByRole('region', { name: '1 queued message' }).textContent).toContain('then journal it');
    act(() => applySessions({ type: 'upsert', session: session({ status: 'idle' }) }));
    expect(screen.queryByRole('region', { name: /queued message/ })).toBeNull();
  });

  it('edits a queued message in the composer and gives the draft back, and removes one', async () => {
    const { fake, calls } = runtime({ 'agent.edit_queued': summary, 'agent.remove_queued': summary });
    const box = show(fake, session({ queue: [queued('q1', 'size it down'), queued('q2', 'then journal it')] }));
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit queued message' })[0]!);
    expect(box.value).toBe('size it down');
    expect(screen.getByRole('button', { name: 'Cancel editing queued message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Attach files' })).toBeNull();
    fireEvent.change(box, { target: { value: 'size it down to 1 MNQ' } });
    expect(screen.getByRole('button', { name: 'Update queued message' })).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(calls.at(-1)).toEqual({
      name: 'agent.edit_queued',
      input: { sessionId: 's_1', queuedId: 'q1', text: 'size it down to 1 MNQ' },
    });
    expect(box.value).toBe('half a thought');

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove queued message' })[1]!);
    await settle();
    expect(calls.at(-1)).toEqual({ name: 'agent.remove_queued', input: { sessionId: 's_1', queuedId: 'q2' } });
  });

  it('cancels an edit with Escape, and keeps an unsaved edit when its message leaves the queue', () => {
    const { fake } = runtime({});
    const box = show(fake, session({ queue: [queued('q1', 'size it down')] }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Cancel editing queued message' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
    fireEvent.change(box, { target: { value: 'size it down to 1 MNQ' } });
    act(() => applySessions({ type: 'upsert', session: session() }));
    expect(box.value).toBe('size it down to 1 MNQ');
    expect(screen.getByText(/left the queue before your edit was saved/)).toBeTruthy();
  });

  it('holds the queue after Stop until Resume queue sends it on', async () => {
    const { fake, calls } = runtime({ 'agent.resume_queue': summary });
    show(fake, session({ status: 'idle', queue: [queued('q1', 'size it down')], queueHeld: true }));
    act(() =>
      applyEnvelope(env(4, { type: 'status', state: 'idle', text: null, step: null, totalSteps: null }), true, 0),
    );
    expect(screen.getByRole('region', { name: '1 queued message' }).textContent).toContain('Queued, paused');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    await settle();
    expect(calls.at(-1)).toEqual({ name: 'agent.resume_queue', input: { sessionId: 's_1' } });
  });
});
