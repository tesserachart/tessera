import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertsStore } from '../src/alerts/store.ts';
import { TestRuntime, type FakeClient } from './support/runtime.tsx';
import { Alerts } from '../src/areas/settings/categories/Alerts.tsx';
import { landingOf, modelEntries, searchSettings } from '../src/areas/settings/model.ts';
import { putRuntimeSettings } from '../src/state/runtimeSettings.ts';
import { patch, read } from '../src/app/store.ts';

type Call = { name: string; input: unknown };
type Answer = { ok: boolean; output?: unknown; error?: { message: string } };

function fakeClient(answer: (c: Call) => Answer) {
  const calls: Call[] = [];
  const client = {
    request: vi.fn((_method: string, params: { name: string; input: unknown }) => {
      const c = { name: params.name, input: params.input };
      calls.push(c);
      return Promise.resolve(answer(c));
    }),
    subscribe: () => () => undefined,
  } as unknown as FakeClient;
  return { client, calls };
}

function show(answer: (c: Call) => Answer = () => ({ ok: true, output: {} })) {
  const { client, calls } = fakeClient(answer);
  render(
    <TestRuntime client={client}>
      <Alerts />
    </TestRuntime>,
  );
  return calls;
}

afterEach(() => {
  cleanup();
  putRuntimeSettings({}, true);
  patch(alertsStore, { alerts: null, recent: [], discord: false });
});

describe('Settings › Alerts & sounds in the search', () => {
  it('is found by the words a trader uses', () => {
    const entries = modelEntries();
    expect(searchSettings(entries, 'mute')[0]?.id).toBe('alerts.mute');
    expect(searchSettings(entries, 'volume')[0]?.id).toBe('alerts.volume');
    expect(searchSettings(entries, 'fill sound')[0]?.id).toBe('alerts.sound.fill');
    expect(searchSettings(entries, 'voice')[0]?.id).toBe('alerts.voice');
    expect(searchSettings(entries, 'order filled')[0]?.id).toBe('alerts.voice');
    expect(searchSettings(entries, 'desktop notification')[0]?.id).toBe('alerts.delivery.desktop');
    expect(searchSettings(entries, 'webhook')[0]?.category).toBe('alerts');
    expect(searchSettings(entries, 'phone push')[0]?.category).toBe('alerts');
    expect(searchSettings(entries, 'beep')[0]?.category).toBe('alerts');
    expect(landingOf('sounds')).toBe('alerts');
    expect(landingOf('alerts.discord')).toBe('alerts');
  });
});

describe('Settings › Alerts & sounds', () => {
  it('writes the whole sounds value on any change', async () => {
    putRuntimeSettings({ sounds: { muted: false, volume: 0.6 } }, true);
    const calls = show();
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Volume' }).value).toBe('60');
    expect(screen.getByRole('combobox', { name: 'Voice' }).textContent).toContain('Daniel');
    expect(screen.getByText(/Voices by ElevenLabs/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Play the / })).toHaveLength(7);
    expect(screen.getByRole('switch', { name: 'Order cancelled' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Stop hit' }));
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({
      name: 'settings.set',
      input: {
        key: 'sounds',
        value: {
          muted: false,
          volume: 0.6,
          events: {
            fill: true,
            stop: false,
            target: true,
            rejected: true,
            cancelled: true,
            connection: true,
            alert: true,
          },
        },
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'More volume' }));
      await Promise.resolve();
    });
    expect(calls.at(-1)?.input).toMatchObject({ key: 'sounds', value: { volume: 0.7 } });
  });

  it('picks a voice, or Off for the tones alone, which hides what only a voice says', async () => {
    putRuntimeSettings({ sounds: { voice: 'off' } }, true);
    const calls = show();
    expect(screen.getByRole('combobox', { name: 'Voice' }).textContent).toContain('Off');
    expect(screen.getAllByRole('button', { name: /^Play the / })).toHaveLength(5);
    expect(screen.queryByRole('switch', { name: 'Order cancelled' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Connection lost' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Voice' }), { key: 'Enter' });
    await act(async () => {
      fireEvent.click(await screen.findByRole('option', { name: /Sarah/ }));
      await Promise.resolve();
    });
    expect(calls.at(-1)?.input).toMatchObject({ key: 'sounds', value: { voice: 'sarah' } });
  });

  it('writes all three deliveries of a new alert', async () => {
    const calls = show();
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'Discord' }));
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({
      name: 'settings.set',
      input: { key: 'alerts.defaultDelivery', value: { sound: true, desktop: true, discord: true } },
    });
  });

  it('saves a webhook, says a refusal, tests it and removes it, never showing it', async () => {
    let refuse = true;
    const calls = show((c) => {
      if (c.name === 'alerts.set_discord') {
        if (refuse) return { ok: false, error: { message: 'not a Discord webhook URL' } };
        return { ok: true, output: { configured: (c.input as { url?: string }).url !== undefined, sent: false } };
      }
      if (c.name === 'alerts.test_discord') return { ok: true, output: { configured: true, sent: true } };
      return { ok: true, output: {} };
    });
    const field = screen.getByLabelText<HTMLInputElement>('Discord webhook URL');
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'https://example.com/hook' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('Not a Discord webhook URL.');
    refuse = false;
    const url = 'https://discord.com/api/webhooks/1/abc';
    fireEvent.change(field, { target: { value: url } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({ name: 'alerts.set_discord', input: { url } });
    expect(read(alertsStore).discord).toBe(true);
    expect(document.body.textContent).not.toContain(url);
    expect(screen.getByText('Set · kept with your passwords and keys, never shown')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
      await Promise.resolve();
    });
    expect(screen.getByText('Sent')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await Promise.resolve();
    });
    expect(calls.at(-1)).toEqual({ name: 'alerts.set_discord', input: {} });
    expect(read(alertsStore).discord).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Discord webhook URL').value).toBe('');
  });
});
