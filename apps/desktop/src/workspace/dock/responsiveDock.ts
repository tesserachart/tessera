import type { DockviewApi } from 'dockview-react';
import { clearMomentary, markMomentary, type EdgePos } from './edges.ts';
import { collapseForNow, isFocusMode, onUserEdgeChange, restoreForNow } from './open.ts';
import { planHandExpand, planResponsive, responsiveInputOf, type AutoEdge } from './responsive.ts';

const SETTLE_MS = 400;

export function installResponsive(
  api: DockviewApi,
  host: HTMLElement,
  roomOf: (kind: string) => number = () => 0,
): () => void {
  const auto = new Set<AutoEdge>();
  const held = new Set<AutoEdge>();
  const remembered = new Map<EdgePos, number>();
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = true;

  const evaluate = () => {
    frame = 0;
    if (isFocusMode()) return;
    for (const pos of [...auto]) {
      if (!api.getEdgeGroup(pos)?.isCollapsed()) {
        auto.delete(pos);
        markMomentary(pos, false);
      }
    }
    const plan = planResponsive(responsiveInputOf(api, host, auto, held, remembered, roomOf), { settled });
    for (const pos of plan.release) held.delete(pos);
    for (const pos of plan.collapse) {
      collapseForNow(api, pos);
      auto.add(pos);
    }
    for (const pos of plan.restore) {
      auto.delete(pos);
      restoreForNow(api, pos);
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(evaluate);
  };
  const resized = () => {
    settled = false;
    schedule();
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settled = true;
      schedule();
    }, SETTLE_MS);
  };

  const ro = new ResizeObserver(resized);
  ro.observe(host);
  const load = api.onDidLayoutFromJSON(() => {
    auto.clear();
    held.clear();
    clearMomentary();
    schedule();
  });
  const added = api.onDidAddGroup(schedule);
  const user = onUserEdgeChange((pos, collapsed) => {
    if (pos === 'right') {
      if (!collapsed) makeRoom(pos);
      return;
    }
    auto.delete(pos);
    if (collapsed) held.delete(pos);
    else {
      held.add(pos);
      makeRoom(pos);
    }
  });
  const makeRoom = (opened: EdgePos) => {
    requestAnimationFrame(() => {
      const other = planHandExpand(responsiveInputOf(api, host, auto, held, remembered, roomOf), opened);
      if (!other) return;
      held.delete(other);
      collapseForNow(api, other);
      auto.add(other);
    });
  };
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (settleTimer) clearTimeout(settleTimer);
    ro.disconnect();
    load.dispose();
    added.dispose();
    user();
  };
}
