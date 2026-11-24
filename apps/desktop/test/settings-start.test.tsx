import type { JsonValue, SettingsEvent } from '@tessera/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showArea } from '../src/areas/store.ts';
import { currentView } from '../src/state/areaView.ts';
import { currentDrawingTools, currentPreferences, useSettingsSync } from '../src/state/settingsSync.ts';
import { answeringClient, TestRuntime } from './support/runtime.tsx';

function Sync() {
  useSettingsSync();
  return null;
}

function startWith(values: Record<string, JsonValue>) {
  const { client, calls } = answeringClient({
    'settings.set': ({ key, value }) => ({ key, value, previous: null }),
  });
  let push: ((ev: SettingsEvent) => void) | null = null;
  client.subscribe = (topic, _params, handler) => {
    if (topic === 'settings') push = (ev) => handler(ev, { topic, seq: 1, subscriptionId: null });
    return () => undefined;
  };
  render(
    <TestRuntime client={client}>
      <Sync />
    </TestRuntime>,
  );
  act(() => push?.({ type: 'snapshot', values }));
  return () => calls.filter((c) => c.name === 'settings.set').map((c) => c.input);
}

afterEach(cleanup);

describe('a window at its start', () => {
  it('writes what it shows over a value never stored, another window’s view, or a window default', async () => {
    showArea('markets');
    const written = startWith({
      'ui.preferences': {},
      'chart.drawingTools': {},
      'agent.defaultModel': { provider: 'codex' },
      'ui.view': { settings: 'elsewhere' },
      'ui.area': 'desk',
      'ui.workspace': 'ws-2',
      'appearance.density': 28,
    });
    await vi.waitFor(() => expect(written()).toHaveLength(4));
    expect(written()).toEqual([
      { key: 'ui.preferences', value: currentPreferences() },
      { key: 'chart.drawingTools', value: currentDrawingTools() },
      { key: 'ui.view', value: currentView() },
      { key: 'ui.area', value: 'markets' },
    ]);
  });

  it('keeps the runtime’s view and area when they are what it shows', async () => {
    showArea('desk');
    const written = startWith({ 'ui.preferences': {}, 'ui.view': currentView() as JsonValue, 'ui.area': 'desk' });
    await vi.waitFor(() => expect(written()).toHaveLength(1));
    expect(written()).toEqual([{ key: 'ui.preferences', value: currentPreferences() }]);
  });
});
