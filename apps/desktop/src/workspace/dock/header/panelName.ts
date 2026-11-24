import type { IDockviewPanel } from 'dockview-react';
import { tileDefinition } from '../../tiles/registry.ts';
import { panelKind } from '../open.ts';

export function panelName(panel: IDockviewPanel): string {
  const title = panel.title ?? '';
  return title !== '' ? title : (tileDefinition(panelKind(panel))?.title ?? panelKind(panel));
}
