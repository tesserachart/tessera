import type { DockviewApi } from 'dockview-react';
import { edgeOf } from './edges.ts';
import { expandEdge } from './motion.ts';

export function installMoveOpensEdge(api: DockviewApi, loadingLayout: () => boolean): () => void {
  const sub = api.onDidMovePanel(({ panel, from }) => {
    if (loadingLayout() || panel.group.id === from.id) return;
    const pos = edgeOf(panel.group);
    if (!pos || !api.getEdgeGroup(pos)?.isCollapsed()) return;
    queueMicrotask(() => {
      if (api.getEdgeGroup(pos)?.isCollapsed()) expandEdge(api, pos, 'pointer');
    });
  });
  return () => sub.dispose();
}
