import { HostError, type HostUpdates, type UpdateFound } from '@tessera/bridge';
import type { AgentSessionSummary } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySessions, analystStore, EMPTY_ANALYST } from '../src/analyst/analystStore.ts';
import { read, write } from '../src/app/store.ts';
import { IDLE, UP_TO_DATE_FOR, updateStore, type UpdateState } from '../src/app/updates.ts';
import { UpdateEntry } from '../src/areas/UpdateEntry.tsx';
import { UpdateDialog } from '../src/shell/UpdateDialog.tsx';
import { UpdatePrompt } from '../src/shell/UpdatePrompt.tsx';
import { wireOrder } from './support/orders.ts';
import { TestRuntime, topicFeed } from './support/runtime.tsx';

const FOUND: UpdateFound = { version: '0.2.0-alpha.1', notes: null };

const flat = topicFeed({
  orders: [{ order: wireOrder({ status: 'filled' }) }],
  positions: [
    {
      position: {
        accountId: 'paper-main',
        instrument: 'NQZ6.CME',
        qty: 0,
        avgPrice: 0,
        realizedPnl: { amount: 0, currency: 'USD' },
        unrealizedPnl: null,
        mark: null,
        openedAt: 0,
      },
    },
  ],
});

const working = topicFeed({ orders: [{ order: wireOrder({ status: 'working' }) }], positions: [] });

const session = (status: AgentSessionSummary['status']): AgentSessionSummary => ({
  id: 's_1',
  title: 'NQ gamma plan',
  preset: 'Trader',
  provider: 'codex',
  model: null,
  mode: 'supervised',
  status,
  origin: { kind: 'agent', sessionId: 's_1', provider: 'codex' },
  sourceLabel: null,
  createdAt: 0,
  updatedAt: 0,
});

function measuring(name: 'scrollHeight' | 'clientHeight', value: () => number): () => void {
  let owner: object | null = HTMLElement.prototype;
  while (owner && !Object.getOwnPropertyDescriptor(owner, name)) owner = Object.getPrototypeOf(owner) as object | null;
  if (!owner) throw new Error(`no ${name} to measure with`);
  const original = Object.getOwnPropertyDescriptor(owner, name)!;
  Object.defineProperty(owner, name, { configurable: true, get: value });
  return () => Object.defineProperty(owner, name, original);
}

function show(state: UpdateState) {
  act(() => write(updateStore, state));
}

function dialog(feed: ReturnType<typeof topicFeed>) {
  return render(
    <TestRuntime client={{ subscribe: feed.subscribe }}>
      <UpdateDialog />
    </TestRuntime>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  act(() => {
    write(updateStore, IDLE);
    write(analystStore, EMPTY_ANALYST);
  });
});

describe('the restart confirmation', () => {
  it('puts focus on Not now when something is at stake', async () => {
    dialog(working);
    act(() => applySessions({ type: 'snapshot', sessions: [session('idle')] }));
    show({ kind: 'confirm', update: FOUND });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })));
    expect(screen.getByRole('dialog', { name: 'Update to Tessera 0.2.0-alpha.1' })).toBeTruthy();
    expect(screen.getByText('Tessera will restart to install it.')).toBeTruthy();
    expect(screen.getByText(/^You have 1 working order\. It stays at your broker/)).toBeTruthy();
  });

  it('puts focus on Restart and update when nothing is at stake', async () => {
    dialog(flat);
    act(() => applySessions({ type: 'snapshot', sessions: [session('idle')] }));
    show({ kind: 'confirm', update: FOUND });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restart and update' })),
    );
    expect(screen.queryByText(/stay at your broker|stays at your broker/)).toBeNull();
    expect(screen.queryByText(/isn’t connected/)).toBeNull();
  });

  it('warns about an analyst session in progress and about sources that have not answered', async () => {
    dialog(flat);
    act(() => applySessions({ type: 'snapshot', sessions: [session('running')] }));
    show({ kind: 'confirm', update: FOUND });
    await waitFor(() => expect(screen.getByText(/^1 analyst session is in progress\./)).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' }));
    cleanup();
    act(() => write(analystStore, EMPTY_ANALYST));
    dialog(topicFeed());
    show({ kind: 'confirm', update: FOUND });
    await waitFor(() =>
      expect(
        screen.getByText('Tessera isn’t connected, so it can’t count your working orders and positions.'),
      ).toBeTruthy(),
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' }));
  });

  it('closes on Escape back to the standing offer', async () => {
    dialog(flat);
    show({ kind: 'confirm', update: FOUND });
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
  });

  it('shows download progress with Hide', async () => {
    dialog(flat);
    show({ kind: 'downloading', update: FOUND, fraction: 0.426, shown: true });
    expect(await screen.findByText('Downloading 0.2.0-alpha.1 · 42%')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Hide' }).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart and update' })).toBeNull();
    show({ kind: 'downloading', update: FOUND, fraction: null, shown: true });
    expect(await screen.findByText('Downloading 0.2.0-alpha.1…')).toBeTruthy();
  });

  it('hides a download on Hide or Escape, and the download keeps going', async () => {
    dialog(flat);
    const downloading = { kind: 'downloading', update: FOUND, fraction: 0.3, shown: true } as const;
    const hidden = { ...downloading, shown: false };
    show(downloading);
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(read(updateStore)).toEqual(hidden);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    show(downloading);
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' });
    expect(read(updateStore)).toEqual(hidden);
  });

  it('offers a downloaded build with today’s warnings, and hides it on Not now', async () => {
    dialog(working);
    show({ kind: 'ready', update: FOUND, shown: true });
    const shown = await screen.findByRole('dialog', { name: 'Update to Tessera 0.2.0-alpha.1' });
    expect(shown.textContent).toContain('Tessera will restart to install it.');
    expect(screen.getByText(/^You have 1 working order\. It stays at your broker/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart and update' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Not now' })));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(read(updateStore)).toEqual({ kind: 'ready', update: FOUND, shown: false });
  });

  it('shows nothing for a download, ready build or failure that was hidden', () => {
    dialog(flat);
    for (const state of [
      { kind: 'downloading', update: FOUND, fraction: 0.3, shown: false },
      { kind: 'ready', update: FOUND, shown: false },
      { kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true, shown: false },
    ] as const) {
      show(state);
      expect(screen.queryByRole('dialog')).toBeNull();
    }
  });

  it('disables everything while installing and ignores Escape', async () => {
    dialog(flat);
    show({ kind: 'installing', update: FOUND });
    expect(await screen.findByText('Installing 0.2.0-alpha.1. Tessera restarts in a moment.')).toBeTruthy();
    for (const button of screen.getAllByRole<HTMLButtonElement>('button')) expect(button.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(read(updateStore)).toEqual({ kind: 'installing', update: FOUND });
  });

  it('says why a download failed, with Close and Try again', async () => {
    dialog(flat);
    show({ kind: 'error', failed: 'download', reason: 'signature mismatch', update: FOUND, asked: true, shown: true });
    expect(await screen.findByText('The update couldn’t be downloaded.')).toBeTruthy();
    expect(screen.getByText('signature mismatch')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(read(updateStore)).toEqual({ kind: 'available', update: FOUND });
  });
});

describe('the quiet prompt', () => {
  const prompt = () =>
    render(
      <TestRuntime client={{}}>
        <UpdatePrompt />
      </TestRuntime>,
    );

  it('offers the version with Later and Update, and does not take focus', () => {
    const before = document.activeElement;
    prompt();
    show({ kind: 'available', update: { version: '0.2.0-alpha.1', notes: 'Fewer interruptions' } });
    const region = screen.getByRole('region', { name: 'Update' });
    expect(region.textContent).toContain('Tessera 0.2.0-alpha.1 is available');
    expect(region.textContent).toContain('Fewer interruptions');
    expect(document.activeElement).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(read(updateStore)).toEqual({
      kind: 'confirm',
      update: { version: '0.2.0-alpha.1', notes: 'Fewer interruptions' },
    });
  });

  it('offers Show all only for notes that were clamped, and shows them in full on a click', () => {
    const heights = { scrollHeight: 60, clientHeight: 32 };
    const restore = [
      measuring('scrollHeight', () => heights.scrollHeight),
      measuring('clientHeight', () => heights.clientHeight),
    ];
    try {
      prompt();
      show({ kind: 'available', update: { version: '0.2.0-alpha.1', notes: 'A long note\nover many lines' } });
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
      expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
      expect(screen.getByText(/over many lines/).className).not.toContain('line-clamp-2');
      show(IDLE);
      heights.scrollHeight = 32;
      show({ kind: 'available', update: { version: '0.2.1', notes: 'Short' } });
      expect(screen.queryByRole('button', { name: 'Show all' })).toBeNull();
    } finally {
      for (const undo of restore) undo();
    }
  });

  it('snoozes on Later', () => {
    prompt();
    show({ kind: 'available', update: FOUND });
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(read(updateStore).kind).toBe('later');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows a failed check only to a person who asked', () => {
    prompt();
    show({ kind: 'error', failed: 'check', reason: 'offline', update: null, asked: false, shown: false });
    expect(screen.queryByRole('region')).toBeNull();
    show({ kind: 'error', failed: 'check', reason: 'offline', update: null, asked: true, shown: false });
    expect(screen.getByText('Couldn’t check for updates.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(read(updateStore).kind).toBe('idle');
  });

  it('shows nothing while idle, checking or snoozed', () => {
    prompt();
    for (const state of [
      IDLE,
      { kind: 'checking', asked: true },
      { kind: 'later', update: FOUND, until: 1 },
    ] as const) {
      show(state);
      expect(screen.queryByRole('region')).toBeNull();
    }
  });
});

describe('the rail’s Check for updates', () => {
  function shell() {
    let answer: { resolve: (found: UpdateFound | null) => void; reject: (error: unknown) => void } | null = null;
    const check = vi.fn<HostUpdates['check']>(
      () =>
        new Promise((resolve, reject) => {
          answer = { resolve, reject };
        }),
    );
    const updates: HostUpdates = {
      check,
      download: () => Promise.resolve(),
      installAndRestart: () => Promise.resolve(),
      onEvent: () => () => undefined,
    };
    const answerWith = async (found: UpdateFound | null | Error) => {
      const pending = answer;
      if (!pending) throw new Error('no check is waiting');
      answer = null;
      await act(async () => {
        if (found instanceof Error) pending.reject(found);
        else pending.resolve(found);
        await Promise.resolve();
      });
    };
    return { updates, check, answerWith };
  }

  function rail(updates: HostUpdates | null) {
    return render(
      <TestRuntime client={{ subscribe: flat.subscribe }} bridge={{ updates }}>
        <UpdateEntry />
        <UpdatePrompt />
        <UpdateDialog />
      </TestRuntime>,
    );
  }

  const item = () => {
    const found = document.querySelector<HTMLButtonElement>('button[data-update-entry]');
    if (!found) throw new Error('no rail item for updates');
    return found;
  };

  it('rests as Check for updates, like Feedback and Settings', () => {
    rail(shell().updates);
    const button = screen.getByRole('button', { name: 'Check for updates' });
    expect(button.className).toContain('t-rail-item');
    expect(button.textContent).toBe('Updates');
    expect(button.getAttribute('aria-busy')).toBeNull();
  });

  it('reads Checking… while it checks, then Up to date for a moment when nothing is newer, with no dialog', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const host = shell();
    rail(host.updates);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(host.check).toHaveBeenCalledOnce();
    expect(item().textContent).toBe('Checking…');
    expect(item().getAttribute('aria-label')).toBe('Checking for updates…');
    expect(item().getAttribute('aria-busy')).toBe('true');

    await host.answerWith(null);
    expect(item().textContent).toBe('Up to date');
    expect(item().getAttribute('aria-label')).toBe('Tessera is up to date');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Update' })).toBeNull();

    act(() => vi.advanceTimersByTime(UP_TO_DATE_FOR - 1));
    expect(item().textContent).toBe('Up to date');
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button', { name: 'Check for updates' }).textContent).toBe('Updates');
  });

  it('opens the update prompt when it finds a build, and Update still asks before the restart', async () => {
    const host = shell();
    rail(host.updates);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await host.answerWith(FOUND);
    const card = screen.getByRole('region', { name: 'Update' });
    expect(card.textContent).toContain('Tessera 0.2.0-alpha.1 is available');
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update to Tessera 0.2.0-alpha.1' });
    expect(dialog.textContent).toContain('Tessera will restart to install it.');
    expect(read(updateStore)).toEqual({ kind: 'confirm', update: FOUND });
  });

  it('brings a snoozed build back at once', async () => {
    const host = shell();
    rail(host.updates);
    show({ kind: 'later', update: FOUND, until: Date.now() + 60_000 });
    expect(screen.queryByRole('region', { name: 'Update' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await host.answerWith(FOUND);
    expect(screen.getByRole('region', { name: 'Update' }).textContent).toContain('is available');
  });

  it('says a failed check failed and tries again on a click', async () => {
    const host = shell();
    rail(host.updates);
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await host.answerWith(new HostError({ operation: 'updates.check', reason: new Error('offline') }));
    const failed = screen.getByRole('button', { name: 'Couldn’t check for updates. Try again' });
    expect(failed.textContent).toBe('Try again');

    fireEvent.click(failed);
    expect(host.check).toHaveBeenCalledTimes(2);
    expect(item().textContent).toBe('Checking…');
    await host.answerWith(null);
    expect(item().textContent).toBe('Up to date');
  });

  it('stays quiet through the timer’s own checks', async () => {
    const host = shell();
    rail(host.updates);
    show({ kind: 'checking', asked: false });
    expect(item().textContent).toBe('Updates');
    show({ kind: 'idle', checkedAt: Date.now(), asked: false });
    expect(item().textContent).toBe('Updates');
    show({ kind: 'error', failed: 'check', reason: 'offline', update: null, asked: false, shown: false });
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeTruthy();
    expect(host.check).not.toHaveBeenCalled();
  });

  const bar = () => item().querySelector<HTMLElement>('.t-rail-progress > span');

  it('draws the download as a thin bar under the icon, with the version and percent in its name', () => {
    rail(shell().updates);
    show({ kind: 'downloading', update: FOUND, fraction: 0.51, shown: false });
    expect(item().dataset.updateEntry).toBe('downloading');
    expect(item().textContent).toBe('Updating');
    expect(item().getAttribute('aria-label')).toBe('Downloading 0.2.0-alpha.1 · 51%');
    expect(item().getAttribute('aria-busy')).toBe('true');
    expect(item().querySelector('.ic .t-rail-progress')).toBeTruthy();
    expect(bar()?.style.transform).toBe('scaleX(0.51)');
    show({ kind: 'downloading', update: FOUND, fraction: null, shown: false });
    expect(item().getAttribute('aria-label')).toBe('Downloading 0.2.0-alpha.1…');
    expect(bar()?.style.transform).toBe('scaleX(0)');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads Restart once the build is ready, without a bar', () => {
    rail(shell().updates);
    show({ kind: 'ready', update: FOUND, shown: false });
    expect(item().dataset.updateEntry).toBe('ready');
    expect(item().textContent).toBe('Restart');
    expect(item().getAttribute('aria-label')).toBe('Update ready · Restart to install 0.2.0-alpha.1');
    expect(bar()).toBeNull();
  });

  it('takes the failed look when a hidden download fails', () => {
    rail(shell().updates);
    show({ kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true, shown: false });
    expect(item().dataset.updateEntry).toBe('update_failed');
    expect(item().textContent).toBe('Try again');
    expect(item().getAttribute('aria-label')).toBe('Couldn’t update to 0.2.0-alpha.1. Try again');
  });

  it('reopens the same download, the ready build or the failure on a click, without checking', async () => {
    const host = shell();
    rail(host.updates);
    show({ kind: 'downloading', update: FOUND, fraction: 0.51, shown: false });
    fireEvent.click(item());
    expect(await screen.findByText('Downloading 0.2.0-alpha.1 · 51%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    show({ kind: 'ready', update: FOUND, shown: false });
    fireEvent.click(item());
    expect(await screen.findByRole('button', { name: 'Restart and update' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    show({ kind: 'error', failed: 'download', reason: 'gone', update: FOUND, asked: true, shown: false });
    fireEvent.click(item());
    expect(await screen.findByText('The update couldn’t be downloaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(host.check).not.toHaveBeenCalled();
  });

  it('is not in the browser, where there are no updates', () => {
    rail(null);
    expect(document.querySelector('[data-update-entry]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });
});
