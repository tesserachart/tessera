import { useMemo, useSyncExternalStore } from 'react';
import type { TicketChart } from '../../chart/ticket/Ticket.tsx';
import { useLayouts } from '../../state/layouts.ts';
import { useWorkspace, workspaceStore } from '../../state/workspace.ts';
import { activateChart, workspaceContext } from '../controller.ts';
import { putOnDesk } from '../deskPlace.ts';
import { dockRevision, subscribeDock } from '../dock/edges.ts';
import { closeTile, isTileVisible, revealTile, type Via } from '../dock/open.ts';
import { chartPanelIds } from '../layouts.ts';
import { singletonPanelId } from './registry.ts';
import { tradeChartOf } from './tradeTarget.ts';
import { read } from '../../app/store.ts';

function tradePanelId(): string {
  return singletonPanelId('trade') ?? 'trade';
}

export function useTradeChart(): TicketChart | null {
  useSyncExternalStore(subscribeDock, dockRevision);
  const ctx = workspaceContext();
  const layoutId = ctx?.layoutId ?? '';
  const active = useWorkspace((s) => s.activeChart);
  const layout = useLayouts((s) => s.layouts[layoutId]);
  const inDock = ctx && layout ? chartPanelIds(ctx.api).filter((id) => layout.charts[id]) : [];
  const docked = ctx?.popout && inDock.length === 0 && layout ? Object.keys(layout.charts) : inDock;
  const tileId = layout ? tradeChartOf({ layoutId, active, layoutActive: layout.activeChartId ?? null, docked }) : null;
  const instrument = tileId ? (layout?.charts[tileId]?.instrument ?? null) : null;
  return useMemo(
    () => (tileId && instrument ? { layoutId, tileId, instrument } : null),
    [layoutId, tileId, instrument],
  );
}

function focusInTrade(): boolean {
  return !!document.activeElement?.closest('.trade-tile');
}

function openInWindow(): string | null {
  const ctx = workspaceContext();
  if (!ctx?.popout) return null;
  const id = tradePanelId();
  if (!ctx.api.getPanel(id)) {
    const chart = ctx.api.panels.find((p) => p.view.contentComponent === 'chart');
    putOnDesk(
      ctx.api,
      { id, component: 'trade', title: 'Trade', initialWidth: 280 },
      { at: 'beside', panel: chart?.id ?? null, side: 'right' },
    );
  }
  return id;
}

function showTrade(via: Via): void {
  if (workspaceContext()?.popout) {
    const id = openInWindow();
    if (id) focusTile(id);
    return;
  }
  revealTile('trade', { via, focus: true });
}

function hideTrade(): void {
  const ctx = workspaceContext();
  const id = tradePanelId();
  if (ctx?.popout) ctx.api.getPanel(id)?.api.close();
  else closeTile(id);
}

function focusTile(id: string): void {
  requestAnimationFrame(() => {
    const el = workspaceContext()?.api.getPanel(id)?.view.content.element.querySelector<HTMLElement>('.tile');
    el?.focus({ preventScroll: true });
  });
}

export function isTradeShown(): boolean {
  const ctx = workspaceContext();
  if (ctx?.popout) return !!ctx.api.getPanel(tradePanelId());
  return isTileVisible(tradePanelId());
}

export function isTradeShownFor(chart: { layoutId: string; tileId: string }): boolean {
  const active = read(workspaceStore).activeChart;
  return isTradeShown() && active?.layoutId === chart.layoutId && active.tileId === chart.tileId;
}

let before: Element | null = null;

export function tradeKey(): void {
  if (isTradeShown() && focusInTrade()) {
    hideTrade();
    const back = before;
    before = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    else (document.activeElement as HTMLElement | null)?.blur();
    return;
  }
  before = document.activeElement;
  showTrade('key');
}

let press: { tileId: string; layoutId: string; shown: boolean } | null = null;

export function notePress(chart: { layoutId: string; tileId: string }, shown: boolean): void {
  press = { ...chart, shown };
}

export function tradeChart(
  chart: { layoutId: string; tileId: string },
  via: Via = 'pointer',
  shown = isTradeShownFor(chart),
): void {
  const pressed = press?.tileId === chart.tileId && press.layoutId === chart.layoutId ? press.shown : null;
  press = null;
  if (pressed ?? shown) {
    hideTrade();
    return;
  }
  activateChart(chart.layoutId, chart.tileId);
  showTrade(via);
}
