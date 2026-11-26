import type { AgentProviderInfo, AgentSignInPage } from '@tessera/protocol';
import { useLoadPending } from '@tessera/ui';
import { useEffect, useMemo, useRef } from 'react';
import { useAnalyst } from '../../analyst/analystStore.ts';
import { openExternal } from '../../app/host.ts';
import { attempt, refreshTools, runTool, useHasTool, useToolValue } from '../../app/tools.ts';
import { readSetting, saveSetting, useRuntimeSettingsLoaded, useSetting } from '../../state/runtimeSettings.ts';
import { defineSetting, stored } from '../../state/setting.ts';
import { sayFailed } from '../../workspace/dock/deskToasts.ts';
import { enabledIds, providerChange, withProviderChange } from './connect.ts';
import { providerViews, type ProviderView } from './models.ts';

export const PROVIDERS = defineSetting('agent.providers', stored);

export function useProviders(): { list: readonly AgentProviderInfo[] | undefined; views: ProviderView[] } {
  const health = useAnalyst((s) => s.providers);
  const healthKnown = useAnalyst((s) => s.healthKnown);
  const settingsKnown = useRuntimeSettingsLoaded();
  useLoadPending(!healthKnown);
  useLoadPending(!settingsKnown);
  const canList = useHasTool('agent.list_providers');
  const read = useToolValue('agent.list_providers', canList ? {} : null, { keepFor: 60_000 });
  const setting = useSetting(PROVIDERS);
  const on = useMemo(() => (setting === undefined ? undefined : enabledIds(setting)), [setting]);
  const changes = [
    ...health.filter((h) => h.kind === 'agent').map((h) => `${h.providerId}:${h.status}`),
    ...[...(on ?? [])].map((id) => `on:${id}`),
  ].join(',');
  const list = read?.providers;
  const known = healthKnown && settingsKnown && list !== undefined;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!canList || !known) return;
    const before = seen.current;
    seen.current = changes;
    if (before !== null && before !== changes) void refreshTools('agent.list_providers');
  }, [changes, canList, known]);
  const views = useMemo(() => providerViews(list, health, on), [list, health, on]);
  return { list, views };
}

function changeProvider(patch: ReturnType<typeof providerChange>): Promise<string | null> {
  return saveSetting(PROVIDERS, patch, withProviderChange(readSetting(PROVIDERS), patch));
}

export function setProviderEnabled(id: string, enabled: boolean): Promise<string | null> {
  return changeProvider(providerChange(id, { enabled }));
}

export function setProviderLaunch(
  id: string,
  change: Partial<{ binaryPath: string; configDir: string; args: readonly string[] }>,
): Promise<string | null> {
  return changeProvider(providerChange(id, change));
}

export function recheckProviders(): Promise<void> {
  return runTool('agent.list_providers', { recheck: true }, { refresh: ['agent.list_providers'] }).then(
    () => undefined,
    (err: unknown) => sayFailed('The models could not be checked', err),
  );
}

export async function installProvider(id: string): Promise<string | null> {
  const r = await attempt(
    'agent.install',
    { provider: id },
    { refresh: ['agent.list_providers'], timeoutMs: 11 * 60_000 },
  );
  return r.ok ? null : r.why;
}

export async function startSignIn(id: string): Promise<AgentSignInPage | null> {
  const { page } = await runTool('agent.sign_in', { provider: id });
  if (page && !page.opened) await openExternal(page.url);
  return page;
}

export async function sendSignInCode(id: string, code: string): Promise<void> {
  await runTool('agent.sign_in', { provider: id, code: code.trim() });
}
