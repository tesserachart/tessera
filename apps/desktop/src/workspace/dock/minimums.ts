import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';

export const GROUP_MIN_WIDTH = 100;

function groupMinWidth(group: DockviewGroupPanel, minWidthOf: (kind: string) => number): number {
  const kind = group.activePanel?.api.component;
  return Math.max(GROUP_MIN_WIDTH, kind ? minWidthOf(kind) : 0);
}

function fitMinimums(api: DockviewApi, minWidthOf: (kind: string) => number): void {
  for (const g of api.groups) {
    if (g.api.location.type !== 'grid') continue;
    const need = groupMinWidth(g, minWidthOf);
    if (g.minimumWidth !== need) g.api.setConstraints({ minimumWidth: need });
  }
}

export function installMinimums(api: DockviewApi, minWidthOf: (kind: string) => number): () => void {
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      fitMinimums(api, minWidthOf);
    });
  };
  sync();
  const subs = [
    api.onDidAddPanel(sync),
    api.onDidRemovePanel(sync),
    api.onDidMovePanel(sync),
    api.onDidActivePanelChange(sync),
    api.onDidLayoutFromJSON(sync),
  ];
  return () => {
    for (const s of subs) s.dispose();
  };
}
