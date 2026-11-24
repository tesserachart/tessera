import type { ConnectionInfo, ProviderHealth } from '@tessera/protocol';

export function providerHealth(over: Partial<ProviderHealth> = {}): ProviderHealth {
  const providerId = over.providerId ?? 'rithmic-apex';
  return {
    providerId,
    kind: 'market_data',
    displayName: providerId,
    status: 'ok',
    latencyMs: null,
    lastMessageAt: null,
    message: null,
    checkedAt: 0,
    ...over,
  };
}

export function connectionInfo(
  health: ProviderHealth = providerHealth(),
  over: Partial<ConnectionInfo> = {},
): ConnectionInfo {
  return {
    id: health.providerId,
    kind: health.kind,
    displayName: health.displayName,
    market: null,
    intel: null,
    broker: null,
    accountOrderEntry: null,
    enabled: true,
    credential: null,
    health,
    ...over,
  };
}
