import type { DockviewPanelApi } from 'dockview-react';
import { useSyncExternalStore } from 'react';

type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function notify(): void {
  version++;
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTileSettingsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

interface PanelLookup {
  id?: string;
  group?: { panels?: readonly { id: string; params?: unknown }[] } | null;
}

/** dockview's panel api only knows the last params handed to `updateParameters`, and nothing before the first. */
export function tileParams<P extends object>(api: Pick<DockviewPanelApi, 'getParameters'>): Partial<P> {
  const look = api as PanelLookup;
  const own = look.id ? look.group?.panels?.find((p) => p.id === look.id)?.params : undefined;
  const p: unknown = own ?? api.getParameters();
  return p && typeof p === 'object' ? p : {};
}

export function setTileParams<P extends object>(
  api: Pick<DockviewPanelApi, 'getParameters' | 'updateParameters'>,
  patch: Partial<P>,
): void {
  // dockview merges an update into the panel's params and drops the keys set to undefined
  const merged: Record<string, unknown> = { ...tileParams<P>(api), ...patch };
  api.updateParameters(merged);
  notify();
}

export function useTileSettings<P extends object>(
  api: Pick<DockviewPanelApi, 'getParameters' | 'updateParameters'>,
  defaults: P,
): [P, (patch: Partial<P>) => void] {
  useTileSettingsVersion();
  const value: P = { ...defaults, ...tileParams<P>(api) };
  return [value, (patch) => setTileParams<P>(api, patch)];
}
