import {
  getPanelData,
  LocalSelectionTransfer,
  PanelTransfer,
  type DockviewApi,
  type DockviewGroupPanel,
} from 'dockview-react';
import { markRailDropped, railDragKind } from '../../../areas/railDrag.ts';
import { contextOf } from '../../controller.ts';
import { dockBack, PANEL_DRAG_TYPE, readPanelDrag } from '../popouts.ts';
import { placeTile } from '../railDrop.ts';

export type TabDrop = 'panel' | 'window' | 'rail';

const transfer = () => LocalSelectionTransfer.getInstance<PanelTransfer>();

export function startTabDrag(
  data: DataTransfer | null,
  api: DockviewApi,
  from: { groupId: string; panelId: string; title: string },
): void {
  transfer().setData([new PanelTransfer(api.id, from.groupId, from.panelId)], PanelTransfer.prototype);
  if (!data) return;
  data.effectAllowed = 'move';
  data.setData('text/plain', from.title);
}

export function startWindowDrag(data: DataTransfer | null, from: { layoutId: string; panelId: string; title: string }) {
  if (!data) return;
  data.effectAllowed = 'move';
  data.setData(PANEL_DRAG_TYPE, JSON.stringify({ layoutId: from.layoutId, panelId: from.panelId }));
  data.setData('text/plain', from.title);
}

export function endTabDrag(): void {
  transfer().clearData(PanelTransfer.prototype);
}

export function tabDropOf(api: DockviewApi, data: DataTransfer | null): TabDrop | null {
  if (getPanelData()?.viewId === api.id) return 'panel';
  if (data?.types.includes(PANEL_DRAG_TYPE) && !contextOf(api)?.popout) return 'window';
  if (railDragKind()) return 'rail';
  return null;
}

export function insertionIndex(slot: number, after: boolean): number {
  return slot + (after ? 1 : 0);
}

export function dropOnTabs(
  api: DockviewApi,
  group: DockviewGroupPanel,
  index: number,
  data: DataTransfer | null,
): boolean {
  const kind = tabDropOf(api, data);
  if (kind === 'panel') {
    const from = getPanelData();
    endTabDrag();
    if (!from) return false;
    if (from.panelId === null) {
      const source = api.getGroup(from.groupId);
      if (!source || source.id === group.id) return false;
      source.api.moveTo({ group, position: 'center' });
      return true;
    }
    const panel = api.getPanel(from.panelId);
    if (!panel) return false;
    const was = panel.group.id === group.id ? group.panels.indexOf(panel) : -1;
    const at = was >= 0 && was < index ? index - 1 : index;
    if (was === at) return true;
    panel.api.moveTo({ group, position: 'center', index: at });
    return true;
  }
  if (kind === 'window') {
    const dragged = data ? readPanelDrag(data) : null;
    const ctx = contextOf(api);
    if (!ctx || dragged?.layoutId !== ctx.layoutId) return false;
    return dockBack(ctx.layoutId, dragged.panelId, { group, position: 'center', index });
  }
  if (kind === 'rail') {
    const tile = railDragKind();
    if (!tile) return false;
    markRailDropped();
    return placeTile(api, tile, { group, position: 'center', index }) !== null;
  }
  return false;
}
