import type { ChartState } from '@tessera/protocol';
import { useContext, useState } from 'react';
import { instrumentRoot } from '../shell/oco.ts';
import { workspaceContext } from '../workspace/controller.ts';
import { LayoutKnownContext } from '../workspace/dock/layoutKnown.ts';
import { normalizeLink } from '../workspace/dock/links.ts';
import { useLayouts } from '../state/layouts.ts';
import { useWorkspace } from '../state/workspace.ts';

export interface FollowedChart {
  layoutId: string;
  tileId: string;
  instrument: string;
}

export function followedChart(
  charts: Readonly<Record<string, ChartState>>,
  active: { layoutId: string; tileId: string } | null,
  link: string | null,
): FollowedChart | null {
  if (!active) return null;
  const own = charts[active.tileId] ?? null;
  const want = normalizeLink(link);
  const inGroup = (c: ChartState | null) => c !== null && normalizeLink(c.linkGroup) === want;
  const pick = want === null || inGroup(own) ? own : (Object.values(charts).find(inGroup) ?? own);
  return pick ? { layoutId: active.layoutId, tileId: pick.tileId, instrument: pick.instrument } : null;
}

export function sizingChart(
  charts: Readonly<Record<string, ChartState>>,
  followed: FollowedChart | null,
  pinned: string | null,
): FollowedChart | null {
  if (!followed || pinned === null || followed.instrument === pinned) return followed;
  const all = Object.values(charts);
  const at = (c: ChartState): FollowedChart => ({
    layoutId: followed.layoutId,
    tileId: c.tileId,
    instrument: c.instrument,
  });
  const exact = all.find((c) => c.instrument === pinned);
  if (exact) return at(exact);
  const root = instrumentRoot(pinned);
  if (instrumentRoot(followed.instrument) === root) return followed;
  const sameRoot = all.find((c) => instrumentRoot(c.instrument) === root);
  return sameRoot ? at(sameRoot) : null;
}

function useFollowedChart(link: string | null): FollowedChart | null {
  const active = useWorkspace((s) => s.activeChart);
  const layoutId = active?.layoutId ?? null;
  const tileId = active?.tileId ?? null;
  const key = useLayouts((s) => {
    if (!layoutId || !tileId) return '';
    const f = followedChart(s.layouts[layoutId]?.charts ?? {}, { layoutId, tileId }, link);
    return f ? `${f.tileId}\u0000${f.instrument}` : '';
  });
  if (!layoutId || !key) return null;
  const [followed, instrument] = key.split('\u0000') as [string, string];
  return { layoutId, tileId: followed, instrument };
}

export function useSizingChart(link: string | null, pinned: string | null): FollowedChart | null {
  const active = useWorkspace((s) => s.activeChart);
  const layoutId = active?.layoutId ?? null;
  const tileId = active?.tileId ?? null;
  const key = useLayouts((s) => {
    if (!layoutId || !tileId) return '';
    const charts = s.layouts[layoutId]?.charts ?? {};
    const f = sizingChart(charts, followedChart(charts, { layoutId, tileId }, link), pinned);
    return f ? `${f.tileId}\u0000${f.instrument}` : '';
  });
  if (!layoutId || !key) return null;
  const [sizer, instrument] = key.split('\u0000') as [string, string];
  return { layoutId, tileId: sizer, instrument };
}

function useLastInstrument(now: string | null): string | null {
  const [last, setLast] = useState(now);
  if (now !== null && now !== last) setLast(now);
  return now ?? last;
}

export function useFollowedInstrument(p: { link: string | null; instrument: string | null }): string | null {
  const followed = useLastInstrument(useFollowedChart(p.link)?.instrument ?? null);
  return p.instrument ?? followed;
}

export function useNoChartOpen(instrument: string | null): boolean {
  const known = useContext(LayoutKnownContext);
  const layoutId = workspaceContext()?.layoutId ?? null;
  const empty = useLayouts((s) => {
    const layout = layoutId ? s.layouts[layoutId] : undefined;
    return layout !== undefined && Object.keys(layout.charts).length === 0;
  });
  return instrument === null && known && empty;
}
