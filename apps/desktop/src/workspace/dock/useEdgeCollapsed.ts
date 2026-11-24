import type { DockviewApi, IDockviewGroupPanel } from 'dockview-react';
import { useCallback, useSyncExternalStore } from 'react';
import { edgeOf, type EdgePos } from './edges.ts';

export function useEdgeCollapsed(
  group: IDockviewGroupPanel,
  containerApi: DockviewApi,
): { edge: EdgePos | null; collapsed: boolean } {
  const edge = edgeOf(group);
  const edgeApi = (edge ? containerApi.getEdgeGroup(edge) : undefined) ?? group.api;
  const subscribe = useCallback(
    (changed: () => void) => {
      const sub = edgeApi.onDidCollapsedChange(changed);
      return () => sub.dispose();
    },
    [edgeApi],
  );
  return { edge, collapsed: useSyncExternalStore(subscribe, () => edgeApi.isCollapsed()) };
}
