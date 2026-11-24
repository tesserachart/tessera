import type { ViewportUpdate } from '@tessera/chart';
import type { ViewportRequest } from '../workspace/tileRequests.ts';

export interface ChartTarget {
  layoutId: string;
  tileId: string;
}

const pending = new Map<string, ViewportRequest>();

const kept = new Map<string, ViewportUpdate>();

const keyOf = (t: ChartTarget) => `${t.layoutId}/${t.tileId}`;

const CHART_VIEWPORT = 'tessera:chart-viewport';

export function requestViewport(target: ChartTarget, view: ViewportRequest): void {
  const key = keyOf(target);
  pending.set(key, view);
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<string>(CHART_VIEWPORT, { detail: key }));
}

export function pendingViewport(target: ChartTarget): ViewportRequest | null {
  return pending.get(keyOf(target)) ?? null;
}

export function viewportTaken(target: ChartTarget): void {
  pending.delete(keyOf(target));
}

export function keepView(target: ChartTarget, view: ViewportUpdate | null): void {
  if (view) kept.set(keyOf(target), view);
  else kept.delete(keyOf(target));
}

export function keptView(target: ChartTarget): ViewportUpdate | null {
  return kept.get(keyOf(target)) ?? null;
}

export function onViewportRequest(target: ChartTarget, cb: () => void): () => void {
  const key = keyOf(target);
  const h = (e: Event) => {
    if ((e as CustomEvent<string>).detail === key) cb();
  };
  window.addEventListener(CHART_VIEWPORT, h);
  return () => window.removeEventListener(CHART_VIEWPORT, h);
}

export function viewportUpdate(v: ViewportRequest): ViewportUpdate {
  const out: ViewportUpdate = {};
  if (v.from !== undefined) out.range = { from: v.from / 1e6, to: (v.to ?? Number.MAX_SAFE_INTEGER * 1e6) / 1e6 };
  else if (v.lastBars !== undefined) out.lastBars = v.lastBars;
  else if (v.fitAll) out.fitAll = true;
  if (v.priceMin !== undefined && v.priceMax !== undefined && v.priceMin < v.priceMax)
    out.price = { min: v.priceMin, max: v.priceMax };
  else if (v.autoScale) out.price = 'auto';
  return out;
}
