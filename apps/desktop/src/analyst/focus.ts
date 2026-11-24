import { read } from '../app/store.ts';
import { areaStore, useArea, type AreaId } from '../areas/store.ts';
import { isTileVisible, useTileVisible } from '../workspace/dock/open.ts';
import { singletonPanelId } from '../workspace/tiles/registry.ts';

function shownIn(area: AreaId, panelShown: boolean): boolean {
  return area === 'agents' || (area === 'desk' && panelShown);
}

export function analystInView(): boolean {
  return shownIn(read(areaStore).area, isTileVisible(singletonPanelId('analyst') ?? 'analyst'));
}

export function useAnalystInView(): boolean {
  return shownIn(
    useArea((s) => s.area),
    useTileVisible('analyst'),
  );
}

const scrollers = new Set<(approvalId: string) => void>();

export function registerApprovalScroller(fn: (approvalId: string) => void): () => void {
  scrollers.add(fn);
  return () => {
    scrollers.delete(fn);
  };
}

export function focusApprovalCard(root: ParentNode, id: string): boolean {
  const slot = root.querySelector<HTMLElement>(`[data-approval="${CSS.escape(id)}"]`);
  if (!slot) {
    for (const scroll of scrollers) scroll(id);
    return false;
  }
  slot.scrollIntoView({ block: 'nearest' });
  const card = slot.querySelector<HTMLElement>('.t-draft, [data-approval-card]') ?? slot;
  card.focus({ preventScroll: true });
  return true;
}
