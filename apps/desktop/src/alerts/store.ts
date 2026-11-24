import type { Alert, AlertFire, AlertsEvent } from '@tessera/protocol';
import { patch, makeStore, useStore } from '../app/store.ts';
import { isEvent } from './form.ts';

const RECENT_MAX = 200;

export interface AlertsState {
  alerts: ReadonlyMap<string, Alert> | null;
  recent: readonly AlertFire[];
  discord: boolean;
  notes: readonly { fire: AlertFire; until: number }[];
}

const NOTE_MS = 8000;

export const alertsStore = makeStore<AlertsState>({ alerts: null, recent: [], discord: false, notes: [] });

export function reduceAlerts(s: AlertsState, ev: AlertsEvent): AlertsState {
  switch (ev.type) {
    case 'snapshot':
      return {
        ...s,
        alerts: new Map(ev.alerts.map((a) => [a.id, a])),
        recent: ev.recent.slice(0, RECENT_MAX),
        discord: ev.discord,
      };
    case 'changed': {
      const next = new Map(s.alerts ?? []);
      next.set(ev.alert.id, ev.alert);
      return { ...s, alerts: next };
    }
    case 'removed': {
      const next = new Map(s.alerts ?? []);
      next.delete(ev.id);
      return { ...s, alerts: next, recent: s.recent.filter((f) => f.alertId !== ev.id) };
    }
    case 'fired':
      return { ...s, recent: [ev.fire, ...s.recent.filter((f) => f.id !== ev.fire.id)].slice(0, RECENT_MAX) };
    case 'delivered':
      return { ...s, recent: s.recent.map((f) => (f.id === ev.fire.id ? ev.fire : f)) };
    case 'discord':
      return { ...s, discord: ev.configured };
  }
}

export function applyAlertsEvent(ev: AlertsEvent, nowMs: number): void {
  patch(alertsStore, (s) => {
    const next = reduceAlerts(s, ev);
    if (ev.type !== 'fired') return next;
    const notes = [...s.notes.filter((n) => n.until > nowMs), { fire: ev.fire, until: nowMs + NOTE_MS }];
    return { ...next, notes };
  });
}

export function resetAlerts(): void {
  patch(alertsStore, { alerts: null, recent: [] });
}

export function useAlerts<T>(pick: (s: AlertsState) => T): T {
  return useStore(alertsStore, pick);
}

function sortedAlerts(alerts: ReadonlyMap<string, Alert> | null): Alert[] {
  return [...(alerts?.values() ?? [])].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

export function listOrder(alerts: ReadonlyMap<string, Alert> | null): { watching: Alert[]; spent: Alert[] } {
  const all = sortedAlerts(alerts);
  return {
    watching: all.filter((a) => a.status === 'active' || a.status === 'paused'),
    spent: all.filter((a) => a.status === 'triggered' || a.status === 'expired'),
  };
}

export function markPrice(a: Alert): number | null {
  const step = a.steps[Math.min(a.live.step, a.steps.length - 1)];
  if (!step || isEvent(step.subject)) return null;
  if (a.live.price !== null && Number.isFinite(a.live.price)) return a.live.price;
  return step.target.kind === 'value' ? step.target.value : null;
}

export function markersOn(alerts: ReadonlyMap<string, Alert> | null, ids: ReadonlySet<string>): Alert[] {
  return sortedAlerts(alerts).filter(
    (a) => (a.status === 'active' || a.status === 'paused') && ids.has(a.instrument) && markPrice(a) !== null,
  );
}

export function draggable(a: Alert): boolean {
  return a.steps.length === 1 && a.steps[0]!.target.kind === 'value';
}
