import type { DockviewApi, IDockviewPanel, Position } from 'dockview-react';
import { markRailDropped, railDragKind } from '../../areas/railDrag.ts';
import { singletonPanelId, tileDefinition } from '../tiles/registry.ts';
import { edgeGroup, edgeOf, placeOf, syncEdgeChrome } from './edges.ts';
import { expandEdge } from './motion.ts';
import { panelKind, reservedPanelIds } from './open.ts';
import { offerUndo, snapshotForUndo } from './undo.ts';
import { dockBack, poppedPanel } from './popouts.ts';
import { contextOf } from '../controller.ts';
import { dropOnDesk, splitsAt, type RailTarget } from '../deskPlace.ts';

export type { RailTarget } from '../deskPlace.ts';

function existingTile(api: DockviewApi, kind: string): IDockviewPanel | null {
  const id = singletonPanelId(kind);
  if (id) return api.getPanel(id) ?? null;
  return api.panels.find((p) => panelKind(p) === kind) ?? null;
}

function freshId(api: DockviewApi, kind: string): string {
  const ctx = contextOf(api);
  const taken = ctx ? reservedPanelIds(ctx.layoutId) : new Set<string>();
  let n = 1;
  while (api.getPanel(`${kind}-${String(n)}`) || taken.has(`${kind}-${String(n)}`)) n++;
  return `${kind}-${String(n)}`;
}

function moveTo(api: DockviewApi, existing: IDockviewPanel, target: RailTarget): IDockviewPanel | null {
  if ('edge' in target) {
    const group = edgeGroup(api, target.edge);
    if (!group) return null;
    if (!api.isEdgeGroupVisible(target.edge)) api.setEdgeGroupVisible(target.edge, true);
    if (placeOf(existing.group) !== target.edge) existing.api.moveTo({ group, position: 'center' });
    expandEdge(api, target.edge, 'pointer');
    return api.getPanel(existing.id) ?? null;
  }
  if (target.group) {
    const group = target.group;
    const position: Position = splitsAt(group) ? target.position : 'center';
    const same = existing.group.id === group.id;
    if (
      !same ||
      position !== 'center' ||
      (target.index !== undefined && target.index !== group.panels.indexOf(existing))
    )
      existing.api.moveTo({ group, position, ...(target.index !== undefined ? { index: target.index } : {}) });
    const edge = edgeOf(group);
    if (edge) expandEdge(api, edge, 'pointer');
    return api.getPanel(existing.id) ?? null;
  }
  existing.api.moveTo({ position: target.position === 'center' ? 'right' : target.position });
  return api.getPanel(existing.id) ?? null;
}

export function placeTile(api: DockviewApi, kind: string, target: RailTarget): IDockviewPanel | null {
  const def = tileDefinition(kind);
  if (!def) return null;
  const ctx = contextOf(api);
  const away = ctx && def.singleton ? poppedPanel(ctx.layoutId, def.kind) : null;
  if (ctx && away) {
    dockBack(ctx.layoutId, away.panelId, target);
    return api.getPanel(away.panelId) ?? null;
  }
  const before = snapshotForUndo();
  const existing = existingTile(api, kind);
  const title = def.title;
  const panel = existing
    ? moveTo(api, existing, target)
    : dropOnDesk(api, target, {
        id: def.singleton ? (singletonPanelId(kind) ?? kind) : freshId(api, kind),
        component: def.kind,
        title,
      });
  if (!panel) return null;
  panel.api.setActive();
  syncEdgeChrome(api);
  offerUndo(existing ? `Moved ${title}` : `Opened ${title}`, before);
  return panel;
}

export function installRailDrop(api: DockviewApi): () => void {
  const over = api.onUnhandledDragOver((ev) => {
    if (railDragKind()) ev.accept();
  });
  const drop = api.onDidDrop((ev) => {
    const kind = railDragKind();
    if (!kind) return;
    markRailDropped();
    const group = ev.group ?? null;
    const at = group && ev.panel ? group.panels.indexOf(ev.panel) : -1;
    placeTile(
      api,
      kind,
      group
        ? { group, position: ev.position, ...(at >= 0 ? { index: at } : {}) }
        : { group: null, position: ev.position },
    );
  });
  return () => {
    over.dispose();
    drop.dispose();
  };
}
