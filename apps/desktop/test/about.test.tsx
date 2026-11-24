import type { TelemetryStatusOutput } from '@tessera/protocol';
import { TooltipProvider } from '@tessera/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/areas/settings/categories/App.tsx';
import { read } from '../src/app/store.ts';
import { closeFeedback, feedbackStore } from '../src/feedback/store.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { answeringClient, seedTools, setTestServices, TestRuntime } from './support/runtime.tsx';

afterEach(cleanup);

const PROJECT: TelemetryStatusOutput = { available: true };

function mount(status: TelemetryStatusOutput, consent: { crashes: boolean; usage: boolean | null }) {
  putRuntimeSettings({ 'telemetry.consent': consent }, true);
  const opened: string[] = [];
  const { client, calls } = answeringClient({
    'telemetry.status': () => status,
    'settings.set': ({ key, value }) => ({ key, value, previous: null }),
  });
  const bridge = {
    openExternal: (url: string) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
  setTestServices(client, bridge);
  seedTools(['telemetry.status', 'settings.set']);
  render(
    <TestRuntime client={client} bridge={bridge}>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </TestRuntime>,
  );
  const sets = () => calls.filter((c) => c.name === 'settings.set').map((c) => c.input);
  const names = () => calls.map((c) => c.name);
  return { opened, sets, names };
}

const report = () => screen.getByRole('region', { name: 'Report a problem' });

describe('Settings › About', () => {
  it('Privacy has a switch for crash reports and one for usage analytics, each changing only its own part', async () => {
    const w = mount(PROJECT, { crashes: true, usage: null });
    const crashes = await screen.findByRole('switch', { name: 'Send crash reports' });
    const usage = screen.getByRole('switch', { name: 'Share usage analytics' });
    expect(crashes.getAttribute('aria-checked')).toBe('true');
    expect(usage.getAttribute('aria-checked')).toBe('false');
    expect(within(screen.getByRole('region', { name: 'Privacy' })).getByText(/Anonymous/)).toBeTruthy();
    fireEvent.click(crashes);
    await vi.waitFor(() =>
      expect(w.sets()).toEqual([{ key: 'telemetry.consent', value: { crashes: false, usage: null } }]),
    );
    act(() => putRuntimeSettings({ 'telemetry.consent': { crashes: false, usage: null } }, false));
    expect(crashes.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(usage);
    await vi.waitFor(() =>
      expect(w.sets().at(-1)).toEqual({ key: 'telemetry.consent', value: { crashes: false, usage: true } }),
    );
  });

  it('shows no switch in a build without a project', async () => {
    mount({ available: false }, { crashes: true, usage: null });
    expect(await screen.findByRole('region', { name: 'Privacy' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Send crash reports' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Share usage analytics' })).toBeNull();
    expect(await within(report()).findByRole('button', { name: /^Send feedback…/ })).toBeTruthy();
  });

  it('Report a problem opens the feedback sheet, with sharing on or off, and sends nothing to PostHog', async () => {
    for (const on of [true, false]) {
      closeFeedback();
      const w = mount(PROJECT, { crashes: on, usage: on });
      await screen.findByRole('switch', { name: 'Share usage analytics' });
      expect(within(report()).queryByRole('textbox')).toBeNull();
      fireEvent.click(within(report()).getByRole('button', { name: /^Send feedback…/ }));
      expect(read(feedbackStore).open).toBe(true);
      expect(w.names().filter((n) => n === 'telemetry.send_feedback' || n === 'telemetry.capture')).toEqual([]);
      cleanup();
    }
  });
});
