import type { ConnectionInfo } from '@tessera/protocol';
import { useState } from 'react';
import { feedErrorWords } from '../shell/deskWords.ts';
import { writeSetting } from '../state/runtimeSettings.ts';
import { CONTRACT_ANSWERS } from './contracts.ts';

export function dataConnections(infos: readonly ConnectionInfo[]): ConnectionInfo[] {
  return infos.filter((c) => c.market !== null && c.kind === 'market_data');
}

export function shownDataSource(
  stored: string | null | undefined,
  infos: readonly ConnectionInfo[],
  now: string | null | undefined,
): string | null {
  const options = dataConnections(infos);
  if (stored && stored !== 'auto' && options.some((c) => c.id === stored)) return stored;
  return now && options.some((c) => c.id === now) ? now : (options[0]?.id ?? null);
}

export function useDataFrom() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const run = (connectionId: string) => {
    setBusy(true);
    setFailed(null);
    const refresh = ['connections.list', 'settings.get', CONTRACT_ANSWERS];
    writeSetting('market.dataSource', connectionId, { refresh })
      .then(() => undefined)
      .catch((e: unknown) => setFailed(feedErrorWords(e)))
      .finally(() => setBusy(false));
  };
  return { busy, failed, run };
}
