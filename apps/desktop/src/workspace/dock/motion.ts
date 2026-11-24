import { EASE, MOTION } from '@tessera/ui';
import type { DockviewApi } from 'dockview-react';
import { edgeGroup, type EdgePos } from './edges.ts';

export type Via = 'key' | 'pointer';

const SHIFT_IN = 12;
const SHIFT_OUT = 8;

function reducedMotion(doc: Document = document): boolean {
  if (doc.documentElement.dataset.motion === 'reduced') return true;
  return doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
}

function edgeTravel(pos: EdgePos, px: number): string {
  if (pos === 'left') return `translateX(${String(-px)}px)`;
  if (pos === 'right') return `translateX(${String(px)}px)`;
  return `translateY(${String(px)}px)`;
}

function contentOf(api: DockviewApi, pos: EdgePos): HTMLElement | null {
  return edgeGroup(api, pos)?.element.querySelector<HTMLElement>(':scope > .dv-content-container') ?? null;
}

const pending = new WeakMap<HTMLElement, Animation>();

function stop(el: HTMLElement | null): void {
  if (!el) return;
  const anim = pending.get(el);
  if (!anim) return;
  pending.delete(el);
  void anim.finished.catch(() => undefined);
  anim.cancel();
}

export const EDGE_MOTION_END = 'dock-edge-motion-end';

function play(el: HTMLElement, anim: Animation): Animation {
  void anim.finished.then(
    () => el.dispatchEvent(new Event(EDGE_MOTION_END, { bubbles: true })),
    () => undefined,
  );
  pending.set(el, anim);
  return anim;
}

export function expandEdge(api: DockviewApi, pos: EdgePos, via: Via): void {
  const g = api.getEdgeGroup(pos);
  if (!g) return;
  if (!api.isEdgeGroupVisible(pos)) api.setEdgeGroupVisible(pos, true);
  const el = contentOf(api, pos);
  stop(el);
  if (!g.isCollapsed()) return;
  g.expand();
  if (via !== 'pointer' || !el || typeof el.animate !== 'function') return;
  const still = reducedMotion(el.ownerDocument);
  play(
    el,
    el.animate(
      [
        { opacity: 0, transform: still ? 'none' : edgeTravel(pos, SHIFT_IN) },
        { opacity: 1, transform: 'none' },
      ],
      { duration: MOTION.panelInMs, easing: EASE.outStrong },
    ),
  );
}

export function collapseEdge(api: DockviewApi, pos: EdgePos, via: Via, done?: () => void): void {
  const g = api.getEdgeGroup(pos);
  if (!g || g.isCollapsed()) {
    done?.();
    return;
  }
  const el = contentOf(api, pos);
  stop(el);
  if (via !== 'pointer' || !el || typeof el.animate !== 'function') {
    g.collapse();
    done?.();
    return;
  }
  const still = reducedMotion(el.ownerDocument);
  const out = play(
    el,
    el.animate(
      [
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: still ? 'none' : edgeTravel(pos, SHIFT_OUT) },
      ],
      { duration: MOTION.panelOutMs, easing: EASE.outStrong, fill: 'forwards' },
    ),
  );
  out.onfinish = () => {
    g.collapse();
    stop(el);
    done?.();
  };
}
