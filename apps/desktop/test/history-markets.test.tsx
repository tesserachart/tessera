import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryMarkets } from '../src/areas/settings/HistoryMarkets.tsx';
import { SavedTradesSections } from '../src/areas/settings/categories/SavedTrades.tsx';
import { patch } from '../src/app/store.ts';
import { areaStore } from '../src/areas/store.ts';
import {
  ALL_SAVED,
  UNMEASURED,
  deskOf,
  emptyDesk,
  estimate,
  estimates,
  pull,
  refusingClient,
  specs,
} from './support/history.tsx';
import { seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

const TOOLS = [
  'market.estimate_pull',
  'market.get_contract_spec',
  'market.pull_trades',
  'market.list_pulls',
  'market.saved_trades',
];

describe('the last week in Settings › Data', () => {
  beforeEach(() => {
    deskOf(['NQ']);
  });
  afterEach(() => {
    cleanup();
    emptyDesk();
    vi.useRealTimers();
  });

  const base = {
    ...specs(['NQ']),
    'market.pull_trades': (r: { instrument: string }) => pull(r.instrument, 0),
    'market.list_pulls': () => ({ pulls: [] }),
    'market.saved_trades': () => ({ path: null, diskBytes: 0, keepSessions: 60, contracts: [] }),
  };

  it('is the first row of the pulls section, with its label and help, over the same market list', async () => {
    patch(areaStore, { area: 'settings' });
    const { client } = refusingClient({
      ...base,
      ...estimates({ NQ: estimate('NQ'), ES: estimate('ES', UNMEASURED), MNQ: estimate('MNQ', ALL_SAVED) }),
    });
    setTestServices(client);
    seedTools(TOOLS);
    const { container } = render(
      <TestRuntime client={client}>
        <SavedTradesSections dataDir="/data" />
      </TestRuntime>,
    );
    const row = await vi.waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-setting="data.pullWeek"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const pulls = container.querySelector('[data-setting="data.pulls"]')!;
    expect(pulls.querySelector('[data-setting]:not(section)')).toBe(row);
    expect(row.querySelector('.t')?.textContent).toBe('The last week');
    expect(row.querySelector('.help')?.textContent).toBe(
      'Every session of the last week for the markets you pick, saved on this computer.',
    );
    await vi.waitFor(() => expect(within(row).queryByRole('checkbox', { name: /^NQ Z6/ })).not.toBeNull());
    expect(within(row).getByRole<HTMLInputElement>('checkbox', { name: /^NQ Z6/ }).checked).toBe(true);
    expect(within(row).getByRole<HTMLInputElement>('checkbox', { name: /^MNQ Z6/ }).disabled).toBe(true);
    expect(within(row).getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Not now' })).toBeNull();
  });

  it('is not offered by a runtime without the estimate', async () => {
    patch(areaStore, { area: 'settings' });
    const { client } = refusingClient(base);
    setTestServices(client);
    seedTools(TOOLS.filter((t) => t !== 'market.estimate_pull'));
    const { container } = render(
      <TestRuntime client={client}>
        <SavedTradesSections dataDir="/data" />
      </TestRuntime>,
    );
    await vi.waitFor(() => expect(container.querySelector('[data-setting="data.pullNew"]')).not.toBeNull());
    expect(container.querySelector('[data-setting="data.pullWeek"]')).toBeNull();
  });

  it('starts the checked markets and lists the pulls it started', async () => {
    const { client, calls } = refusingClient({ ...base, ...estimates({ NQ: estimate('NQ') }) });
    setTestServices(client);
    seedTools(TOOLS);
    render(
      <TestRuntime client={client}>
        <HistoryMarkets />
      </TestRuntime>,
    );
    const download = await screen.findByRole<HTMLButtonElement>('button', { name: 'Download' });
    await vi.waitFor(() => expect(download.disabled).toBe(false));
    fireEvent.click(download);
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.name === 'market.pull_trades').map((c) => c.input)).toEqual([
        estimate('NQ').request,
      ]),
    );
  });

  it('re-reads a checked unknown row every 2 seconds until it is measured, and stops then', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    let measured = false;
    const { client, calls } = refusingClient({
      ...base,
      'market.estimate_pull': () => (measured ? estimate('NQ') : estimate('NQ', UNMEASURED)),
    });
    setTestServices(client);
    seedTools(TOOLS);
    render(
      <TestRuntime client={client}>
        <HistoryMarkets />
      </TestRuntime>,
    );
    const reads = () =>
      calls.filter((c) => c.name === 'market.estimate_pull' && (c.input as { instrument: string }).instrument === 'NQ')
        .length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText('size not known yet')).toBeTruthy();
    const before = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(reads()).toBeGreaterThan(before);
    measured = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByText(/about 410 MB/)).toBeTruthy();
    const settled = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads()).toBe(settled);
  });

  it('keeps a market whose week is downloading unpicked, saying so', async () => {
    const running = pull('NQ', 1);
    const { client } = refusingClient({
      ...base,
      ...estimates({ NQ: { ...estimate('NQ'), id: running.id } }),
      'market.list_pulls': () => ({ pulls: [running] }),
    });
    setTestServices(client);
    seedTools(TOOLS);
    render(
      <TestRuntime client={client}>
        <HistoryMarkets />
      </TestRuntime>,
    );
    const nq = await screen.findByRole<HTMLInputElement>('checkbox', { name: /^NQ Z6/ });
    await vi.waitFor(() => expect(nq.labels?.[0]?.textContent).toBe('NQ Z65 days · downloading'));
    expect(nq.checked).toBe(false);
    expect(nq.disabled).toBe(true);
  });

  it('shows an unchecked row’s size once it is measured', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    let measured = false;
    const { client } = refusingClient({
      ...base,
      'market.estimate_pull': (r: { instrument: string }) =>
        r.instrument === 'ES' && !measured ? estimate('ES', UNMEASURED) : estimate(r.instrument),
    });
    setTestServices(client);
    seedTools(TOOLS);
    render(
      <TestRuntime client={client}>
        <HistoryMarkets />
      </TestRuntime>,
    );
    const es = () => screen.getByRole<HTMLInputElement>('checkbox', { name: /^ES Z6/ });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(es().checked).toBe(false);
    expect(es().labels?.[0]?.textContent).toBe('ES Z65 days · size not known yet');
    measured = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(es().labels?.[0]?.textContent).toBe('ES Z65 days · about 410 MB');
  });
});
