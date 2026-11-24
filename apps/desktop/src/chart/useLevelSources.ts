import type { LevelSourceInfo } from '@tessera/protocol';
import { useMemo } from 'react';
import { useHasTool, useToolValue } from '../app/tools.ts';
import { defsOf, sourceDefs, type LevelDefs, type SourceDef } from './levelSettings.ts';

export function useLevelSources(): {
  sources: SourceDef[];
  defs: LevelDefs;
  infos: LevelSourceInfo[];
} {
  const has = useHasTool('intel.list_sources');
  const data = useToolValue('intel.list_sources', has ? {} : null);
  return useMemo(() => {
    const sources = sourceDefs(data?.sources ?? []);
    return { sources, defs: defsOf(sources), infos: data?.sources ?? [] };
  }, [data]);
}
