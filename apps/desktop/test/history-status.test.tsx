import type { PullSummary } from '@tessera/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { historyStore } from '../src/areas/settings/history.ts';
import { settingsNavStore } from '../src/areas/settings/store.ts';
import { areaStore } from '../src/areas/store.ts';
import { read, write } from '../src/app/store.ts';
import { refreshTools } from '../src/app/tools.ts';
import { HistoryStatus } from '../src/shell/HistoryStatus.tsx';
import { pull, refusingClient } from './support/history.tsx';
import { seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

function mount(pulls: () => PullSummary[]) {
  const { client } = refusingClient({ 'market.list_pulls': () => ({ pulls: pulls() }) });
  setTestServices(client);
  seedTools(['market.list_pulls']);
  return render(
    <TestRuntime client={client}>
      <HistoryStatus />
    </TestRuntime>,
  );
}

const failedPull = (root: string, failed: number): PullSummary =>
  pull(root, 5, {
    state: 'done',
    current: null,
    progress: {
      days: 5,
      saved: 5 - failed,
      alreadySaved: 0,
      noTrades: 0,
      outOfReach: 0,
      failed,
      later: 0,
      waiting: 0,
      prints: 9,
    },
  });

describe('the status bar’s history item', () => {
  beforeEach(() => {
    write(historyStore, { ran: [] });
  });
  afterEach(() => {
    cleanup();
  });

  it('shows nothing while no pull runs', async () => {
    const { container } = mount(() => []);
    await vi.waitFor(() => expect(container.querySelector('.t-conn')).toBeNull());
    await act(async () => {
      await refreshTools('market.list_pulls');
    });
    expect(container.querySelector('.t-conn')).toBeNull();
  });

  it('counts the days of every running pull, and lists each in its tooltip', async () => {
    mount(() => [pull('NQ', 3), pull('ES', 0)]);
    const item = await screen.findByRole('button', { name: 'Downloading history: 3 of 10 days' });
    expect(item.textContent).toBe('History 3/10 days');
    fireEvent.pointerMove(item);
    fireEvent.focus(item);
    expect((await screen.findAllByText('NQ Z6 · 3 of 5 days')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('ES Z6 · 0 of 5 days')).length).toBeGreaterThan(0);
  });

  it('goes away when the pulls finish clean', async () => {
    let pulls = [pull('NQ', 3)];
    const { container } = mount(() => pulls);
    await screen.findByRole('button', { name: /Downloading history/ });
    pulls = [pull('NQ', 5, { state: 'done', current: null })];
    await act(async () => {
      await refreshTools('market.list_pulls');
    });
    await vi.waitFor(() => expect(container.querySelector('.t-conn')).toBeNull());
  });

  it('says days failed once the pulls that ran here end, until it is clicked, which opens Settings › Data', async () => {
    let pulls = [pull('NQ', 3)];
    const { container } = mount(() => pulls);
    await screen.findByRole('button', { name: /Downloading history/ });
    pulls = [failedPull('NQ', 2)];
    await act(async () => {
      await refreshTools('market.list_pulls');
    });
    const item = await screen.findByRole('button', { name: 'History: 2 days failed' });
    expect(item.textContent).toBe('History: 2 days failed');
    fireEvent.click(item);
    expect(read(areaStore).area).toBe('settings');
    expect(read(settingsNavStore).target?.id).toBe('data.pulls');
    await vi.waitFor(() => expect(container.querySelector('.t-conn')).toBeNull());
  });

  it('opens Settings › Data from the running state too', async () => {
    mount(() => [pull('NQ', 1)]);
    fireEvent.click(await screen.findByRole('button', { name: /Downloading history/ }));
    expect(read(areaStore).area).toBe('settings');
    expect(read(settingsNavStore).target?.id).toBe('data.pulls');
  });

  it('stays quiet about failed days of a pull that did not run in this window', async () => {
    const { container } = mount(() => [failedPull('NQ', 2)]);
    await act(async () => {
      await refreshTools('market.list_pulls');
    });
    expect(container.querySelector('.t-conn')).toBeNull();
  });
});
