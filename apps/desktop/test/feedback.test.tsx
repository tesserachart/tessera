import type {
  FeedbackContextOutput,
  FeedbackSendInput,
  FeedbackSendOutput,
  FeedbackWriteUpOutput,
} from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { read } from '../src/app/store.ts';
import { registerBuiltinCommands } from '../src/commands/builtin.ts';
import { CommandRegistry } from '../src/commands/registry.ts';
import type * as Capture from '../src/feedback/capture.ts';
import { captureWindow, cleanClone, maskText, privateWordsOf } from '../src/feedback/capture.ts';
import { FeedbackDialog } from '../src/feedback/FeedbackDialog.tsx';
import { blankDraft, FEEDBACK_KEY, gotIt, sendInput, stepsOf, type Screenshot } from '../src/feedback/model.ts';
import { closeFeedback, feedbackStore, openFeedback } from '../src/feedback/store.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

vi.mock('../src/feedback/capture.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Capture>();
  return {
    ...real,
    captureWindow: vi.fn(() =>
      Promise.resolve({
        type: 'image/png',
        data: 'iVBORw0KGgo=',
        preview: 'data:image/png;base64,iVBORw0KGgo=',
        width: 1600,
        height: 1000,
        bytes: 9,
      }),
    ),
  };
});

beforeEach(() => closeFeedback());
afterEach(cleanup);

const ITEMS: FeedbackContextOutput['items'] = [
  { key: 'app', label: 'App', value: 'Tessera 0.2.0 (a4a9ad0)', detail: null },
  { key: 'account', label: 'Account kind', value: 'Paper', detail: null },
  {
    key: 'orders',
    label: 'Order and protect events',
    value: 'The last 2 on NQZ6.CME',
    detail: '2026-10-02 18:42:01.000Z  orders.submit  trader  ok  buy  1  market  NQZ6.CME',
  },
  { key: 'errors', label: 'Runtime errors', value: 'None since Tessera started', detail: null },
];

function context(writer: boolean, delivery: FeedbackContextOutput['delivery'] = 'cloud'): FeedbackContextOutput {
  return {
    items: ITEMS,
    delivery,
    writer: writer ? { provider: 'claude-code', name: 'Claude Code' } : null,
    queued: 0,
  };
}

const PICTURE: Screenshot = {
  type: 'image/png',
  data: 'iVBORw0KGgo=',
  preview: 'data:image/png;base64,iVBORw0KGgo=',
  width: 1600,
  height: 1000,
  bytes: 9,
};

const SENT: FeedbackSendOutput = {
  id: 'fb-0123456789ab',
  status: 'sent',
  issue: { number: 412 },
  delivery: 'cloud',
  reason: null,
};

const WRITTEN: FeedbackWriteUpOutput = {
  title: 'Market buy fills but the DOM keeps the old size',
  steps: ['Buy 1 NQ at market', 'Look at the DOM'],
  expected: 'The DOM shows the position',
  actual: 'It shows flat',
  writer: { provider: 'claude-code', name: 'Claude Code' },
};

function mount(
  ctx: FeedbackContextOutput,
  out: FeedbackSendOutput = SENT,
  writeUp: () => FeedbackWriteUpOutput | Promise<FeedbackWriteUpOutput> = () => WRITTEN,
) {
  const { client, calls } = answeringClient({
    'feedback.context': () => ctx,
    'feedback.send': () => out,
    'feedback.write_up': writeUp,
  });
  setTestServices(client);
  seedTools(['feedback.context', 'feedback.send', 'feedback.write_up']);
  render(
    <TestRuntime client={client}>
      <TooltipProvider>
        <FeedbackDialog />
      </TooltipProvider>
    </TestRuntime>,
  );
  const sent = () => calls.filter((c) => c.name === 'feedback.send').map((c) => c.input as FeedbackSendInput);
  const named = (name: string) => calls.filter((c) => c.name === name);
  return { sent, named };
}

const sheet = () => screen.getByRole('dialog', { name: 'Send feedback' });
const note = () => within(sheet()).getByRole('textbox', { name: 'Your note' });
const send = () => within(sheet()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });

describe('the feedback box', () => {
  it('paints its whole layout at once, and only once it is painted gathers the details and takes the picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    try {
      const w = mount(context(false));
      vi.mocked(captureWindow).mockClear();
      act(() => openFeedback());
      expect(within(sheet()).getByRole('group', { name: 'Kind' })).toBeTruthy();
      expect(note()).toBeTruthy();
      expect(within(sheet()).getByRole('region', { name: 'Sent with it' })).toBeTruthy();
      expect(send()).toBeTruthy();
      expect(captureWindow).not.toHaveBeenCalled();
      expect(w.named('feedback.context')).toEqual([]);
      expect(sheet().querySelectorAll('[data-feedback-pending]').length).toBeGreaterThan(0);
      const gathering = within(sheet()).getByRole('status', { name: 'Gathering the details' });
      expect(gathering.querySelectorAll('.fb-item .fb-item-row .fb-item-value').length).toBeGreaterThan(1);
      const picturing = within(sheet()).getByRole('status', { name: 'Taking the picture' });
      expect(picturing.querySelectorAll('.fb-item .fb-shot').length).toBe(1);

      act(() => vi.advanceTimersToNextFrame());
      expect(captureWindow).not.toHaveBeenCalled();
      expect(w.named('feedback.context')).toEqual([]);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(w.named('feedback.context')).toHaveLength(1);
      expect(captureWindow).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersToNextFrame();
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(captureWindow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
    expect(await within(sheet()).findByText('Order and protect events')).toBeTruthy();
    expect(within(sheet()).getByText(/1600×1000/)).toBeTruthy();
    expect(sheet().querySelectorAll('[data-feedback-pending]').length).toBe(0);
  });

  it('shows what goes with the report, sends only what the user kept, and answers with an id', async () => {
    const w = mount(context(false));
    act(() => openFeedback());
    expect(await within(sheet()).findByText('Order and protect events')).toBeTruthy();
    expect(await within(sheet()).findByText(/1600×1000/)).toBeTruthy();
    expect(send().disabled).toBe(true);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Bug' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Idea' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Bug' }));
    fireEvent.change(note(), { target: { value: 'The DOM kept the old size after a market buy' } });
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove Account kind' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Remove Runtime errors' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'Put back Runtime errors' }));
    expect(w.sent()).toEqual([]);
    fireEvent.click(send());
    expect(await within(sheet()).findByText('fb-0123456789ab')).toBeTruthy();
    expect(within(sheet()).getByText('The team has it as issue 412.')).toBeTruthy();
    const [input] = w.sent();
    expect(input?.kind).toBe('bug');
    expect(input?.text).toBe('The DOM kept the old size after a market buy');
    expect(input?.context.map((i) => i.key)).toEqual(['app', 'orders', 'errors']);
    expect(input?.screenshot?.type).toBe('image/png');
    expect(input?.writtenUp).toBe(false);
  });

  it('leaves the picture out once removed', async () => {
    const w = mount(context(false));
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    fireEvent.change(note(), { target: { value: 'An idea' } });
    fireEvent.click(await within(sheet()).findByRole('button', { name: 'Remove the picture' }));
    fireEvent.click(send());
    await within(sheet()).findByText('fb-0123456789ab');
    expect(w.sent()[0]?.screenshot).toBeNull();
  });

  it('waits for the picture when Send is pressed before it is taken, and sends it', async () => {
    let taken: (shot: Screenshot) => void = () => undefined;
    vi.mocked(captureWindow).mockImplementationOnce(() => new Promise((resolve) => (taken = resolve)));
    const w = mount(context(false));
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    await waitFor(() => expect(captureWindow).toHaveBeenCalled());
    fireEvent.change(note(), { target: { value: 'The stop line jumped back' } });
    fireEvent.click(send());
    expect(send().textContent).toContain('Sending');
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(w.sent()).toEqual([]);
    act(() => taken(PICTURE));
    await within(sheet()).findByText('fb-0123456789ab');
    expect(w.sent()).toHaveLength(1);
    expect(w.sent()[0]?.screenshot).toEqual({ type: 'image/png', data: PICTURE.data });
  });

  it('offers no write-up without a connected agent', async () => {
    const w = mount(context(false));
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    fireEvent.change(note(), { target: { value: 'stop didnt trail' } });
    expect(within(sheet()).queryByRole('button', { name: /Write it up/ })).toBeNull();
    expect(w.named('feedback.write_up')).toEqual([]);
  });

  it('has the connected agent write it up into fields the user edits, and sends nothing until Send', async () => {
    const w = mount(context(true));
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    const assist = within(sheet()).getByRole<HTMLButtonElement>('button', { name: /Write it up for me/ });
    expect(assist.disabled).toBe(true);
    fireEvent.change(note(), { target: { value: 'dom wrong after buy' } });
    fireEvent.click(assist);
    const title = await within(sheet()).findByDisplayValue('Market buy fills but the DOM keeps the old size');
    expect(w.named('feedback.write_up')).toHaveLength(1);
    expect(w.sent()).toEqual([]);
    fireEvent.change(title, { target: { value: 'DOM stays flat after a market buy' } });
    fireEvent.click(send());
    await within(sheet()).findByText('fb-0123456789ab');
    const input = w.sent()[0];
    expect(input?.title).toBe('DOM stays flat after a market buy');
    expect(input?.steps).toEqual(['Buy 1 NQ at market', 'Look at the DOM']);
    expect(input?.actual).toBe('It shows flat');
    expect(input?.writtenUp).toBe(true);
  });

  it('drops a write-up still on its way when the box is closed and opened again', async () => {
    let finish: (w: FeedbackWriteUpOutput) => void = () => undefined;
    mount(
      context(true),
      SENT,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    fireEvent.change(note(), { target: { value: 'dom wrong after buy' } });
    fireEvent.click(within(sheet()).getByRole('button', { name: /Write it up for me/ }));
    await within(sheet()).findByText('Writing it up…');
    act(() => closeFeedback());
    act(() => openFeedback());
    await within(sheet()).findByText('Order and protect events');
    await act(async () => {
      finish(WRITTEN);
      await Promise.resolve();
    });
    expect(within(sheet()).queryByDisplayValue(WRITTEN.title)).toBeNull();
    expect((note() as HTMLTextAreaElement).value).toBe('');
    expect(within(sheet()).getByRole('button', { name: /Write it up for me/ })).toBeTruthy();
  });

  it('says a queued report is saved and why it waits', async () => {
    mount(context(false, 'signed_out'), {
      id: 'fb-aaaaaaaaaaaa',
      status: 'queued',
      issue: null,
      delivery: 'signed_out',
      reason: 'Not signed in to Tessera: it goes once you sign in',
    });
    act(() => openFeedback());
    expect(await within(sheet()).findByText(/You’re not signed in/)).toBeTruthy();
    fireEvent.change(note(), { target: { value: 'offline' } });
    fireEvent.click(send());
    expect(await within(sheet()).findByText('Got it. It’s saved and goes by itself.')).toBeTruthy();
    expect(within(sheet()).getByText('fb-aaaaaaaaaaaa')).toBeTruthy();
    expect(within(sheet()).getByText('Not signed in to Tessera: it goes once you sign in')).toBeTruthy();
  });

  it('opens from its shortcut and from ⌘K', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry, { runtime: true, focusComposer: () => undefined });
    const command = registry.get('feedback.open');
    expect(command?.shortcut).toBe(FEEDBACK_KEY);
    expect(registry.search('bug').some((m) => m.command.id === 'feedback.open')).toBe(true);
    registry.handleKey(
      { key: '?', code: 'Slash', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true },
      'global',
      'other',
      true,
    );
    expect(read(feedbackStore).open).toBe(true);
  });
});

describe('the feedback model', () => {
  it('reads steps one a line, numbered or bulleted', () => {
    expect(stepsOf('1. Buy\n- Sell\n\n  • Flat  \n2) Look')).toEqual(['Buy', 'Sell', 'Flat', 'Look']);
  });

  it('sends no write-up fields when there is none', () => {
    const input = sendInput({ ...blankDraft(), text: ' hi ' }, ITEMS, null, {
      version: '0.2.0',
      commit: null,
      shell: null,
    });
    expect(input.title).toBeNull();
    expect(input.steps).toEqual([]);
    expect(input.text).toBe('hi');
    expect(input.screenshot).toBeNull();
  });

  it('words a sent report by its issue', () => {
    expect(gotIt(SENT).detail).toBe('The team has it as issue 412.');
  });

  it('hides every broker account’s id, name and number in the picture', () => {
    const words = privateWordsOf([
      {
        id: 'rithmic-apex:APEX-1234567-01',
        displayName: 'APEX-1234567-01',
        externalRefMasked: '••••7-01',
        environment: 'eval',
      },
      { id: 'paper-main', displayName: 'Paper', externalRefMasked: null, environment: 'paper' },
    ]);
    expect(maskText('Long 1 on APEX-1234567-01 · rithmic-apex:APEX-1234567-01 · Paper', words)).toBe(
      'Long 1 on •••• · •••• · Paper',
    );
  });

  it('hides account words in the cloned text and attributes, and drops what XML cannot hold', () => {
    const cloned = document.createElement('div');
    cloned.setAttribute('aria-label', 'Account APEX-1234567-01');
    cloned.append('Long 1 on APEX-1234567-01\u0007', document.createElement('span'));
    const input = document.createElement('input');
    input.value = 'APEX-1234567-01';
    cleanClone(cloned, ['APEX-1234567-01']);
    cleanClone(input, ['APEX-1234567-01']);
    expect(cloned.firstChild?.textContent).toBe('Long 1 on ••••');
    expect(cloned.getAttribute('aria-label')).toBe('Account ••••');
    expect(input.value).toBe('••••');
  });
});
