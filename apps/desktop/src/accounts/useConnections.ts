import type { ConnectionInfo, ToolCallEvent } from '@tessera/protocol';
import { useMemo } from 'react';
import { refreshTools, useHasTool, useToolValue } from '../app/tools.ts';
import { useTopicEffect } from '../app/useTopic.ts';
import { useShellData } from '../shell/shellData.ts';
import { useLevelSources } from '../chart/useLevelSources.ts';
import { CONNECTION_READS } from './connectionCall.ts';
import { connectionRows, listedConnections, type ConnectionRow, type Listed } from './connections.ts';

export const useHasUserConnectionTools = (): boolean => useHasTool('connections.list');

export function useConnections(): { rows: ConnectionRow[]; infos: ConnectionInfo[]; dataSource: string | null } {
  const { providers, accounts } = useShellData();
  const has = useHasTool('connections.list');
  const list = useToolValue('connections.list', has ? {} : null, { keepFor: 5_000 });
  const infos = list?.connections;
  const dataSource = list?.dataSource ?? null;
  return useMemo(
    () => ({ rows: connectionRows(providers, infos ?? [], accounts), infos: infos ?? [], dataSource }),
    [providers, infos, accounts, dataSource],
  );
}

function changesConnections({ phase, call }: ToolCallEvent): boolean {
  return phase === 'finished' && call.risk !== 'read' && /^(connections|intel)\./.test(call.tool);
}

export function useListedConnections(): Listed[] {
  const { rows } = useConnections();
  const hasCalls = useHasTool('connections.list');
  useTopicEffect(
    'tool.calls',
    hasCalls ? {} : null,
    (event) => {
      if (changesConnections(event)) void refreshTools(...CONNECTION_READS);
    },
    { replay: false },
  );
  const { providers } = useShellData();
  const { infos } = useLevelSources();
  const hasDrafts = useHasTool('intel.list_source_drafts');
  const drafts = useToolValue('intel.list_source_drafts', hasDrafts ? {} : null, { keepFor: 10_000 })?.drafts;
  return useMemo(() => listedConnections(rows, infos, providers, drafts ?? []), [rows, infos, providers, drafts]);
}
