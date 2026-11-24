import { patch, read, makeStore, useStore } from '../../app/store.ts';
import { workspaceContext } from '../controller.ts';

export interface TileFacts {
  note?: string | null;
  autoSize?: number | null;
}

export interface TileSettingsUi {
  open: string | null;
  facts: Readonly<Record<string, TileFacts>>;
}

export const tileSettingsUiStore = makeStore<TileSettingsUi>({ open: null, facts: {} });

export function openTileSettings(panelId: string): void {
  workspaceContext()?.api.getPanel(panelId)?.api.setActive();
  requestAnimationFrame(() => patch(tileSettingsUiStore, { open: panelId }));
}

export function setTileFacts(panelId: string, change: TileFacts | null): void {
  const all = read(tileSettingsUiStore).facts;
  const before = all[panelId];
  const next: TileFacts = change === null ? {} : { ...before, ...change };
  const same =
    change === null
      ? before === undefined
      : Object.entries(change).every(([k, v]) => before?.[k as keyof TileFacts] === v);
  if (same) return;
  const facts =
    change === null
      ? Object.fromEntries(Object.entries(all).filter(([id]) => id !== panelId))
      : { ...all, [panelId]: next };
  patch(tileSettingsUiStore, { facts });
}

const NO_FACTS: TileFacts = {};

export function useTileFacts(panelId: string): TileFacts {
  return useStore(tileSettingsUiStore, (s) => s.facts[panelId] ?? NO_FACTS);
}

export function useTileSettingsUi<T>(selector: (s: TileSettingsUi) => T): T {
  return useStore(tileSettingsUiStore, selector);
}
