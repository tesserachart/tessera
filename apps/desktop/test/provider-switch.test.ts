import { describe, expect, it } from 'vitest';
import { read } from '../src/app/store.ts';
import { enabledIds } from '../src/areas/agents/connect.ts';
import { setProviderEnabled } from '../src/areas/agents/providers.ts';
import { putRuntimeSettings, runtimeSettingsStore } from '../src/state/runtimeSettings.ts';
import { answeringClient, seedTools, setTestServices } from './support/runtime.tsx';

describe('switching one analyst provider', () => {
  it('leaves the others as they are while the change is on its way', async () => {
    putRuntimeSettings({ 'agent.providers': { codex: { enabled: true }, 'claude-code': { enabled: true } } }, true);
    setTestServices(answeringClient({ 'settings.set': () => new Promise<never>(() => undefined) }).client);
    seedTools(['settings.set']);
    void setProviderEnabled('codex', false);
    await Promise.resolve();
    expect(enabledIds(read(runtimeSettingsStore).values['agent.providers'])).toEqual(new Set(['claude-code']));
  });
});
