import type { ProviderView } from '../areas/agents/models.ts';

type NewChatFix = { kind: 'turn-on'; provider: ProviderView } | { kind: 'settings' };

export type NewChatPlan = { kind: 'start' } | { kind: 'blocked'; reason: string; fix: NewChatFix | null };

function blockedBy(provider: ProviderView): NewChatPlan {
  if (provider.status === 'unknown') return { kind: 'blocked', reason: `Checking ${provider.name}…`, fix: null };
  if (provider.status === 'disconnected')
    return { kind: 'blocked', reason: `${provider.name} is not signed in.`, fix: { kind: 'settings' } };
  const why = provider.message?.trim() ?? '';
  if (provider.status === 'down' && /not installed/i.test(why))
    return { kind: 'blocked', reason: `${provider.name} is not installed.`, fix: { kind: 'settings' } };
  return {
    kind: 'blocked',
    reason: why ? `${provider.name}: ${why}` : `${provider.name} is not ready.`,
    fix: { kind: 'settings' },
  };
}

export function newChatPlan(
  providers: readonly ProviderView[],
  hasStartSession: boolean,
  lastProvider: string | null,
): NewChatPlan {
  if (!hasStartSession) return { kind: 'blocked', reason: 'This build can’t start an analyst session.', fix: null };
  if (providers.some((p) => p.ready)) return { kind: 'start' };
  const preferred = providers.find((p) => p.id === lastProvider);
  const on = (preferred?.enabled ? preferred : undefined) ?? providers.find((p) => p.enabled);
  if (on) return blockedBy(on);
  const off = (preferred && !preferred.enabled ? preferred : undefined) ?? providers.find((p) => !p.enabled);
  if (off) return { kind: 'blocked', reason: `${off.name} is off.`, fix: { kind: 'turn-on', provider: off } };
  return { kind: 'blocked', reason: 'No model is on.', fix: { kind: 'settings' } };
}
