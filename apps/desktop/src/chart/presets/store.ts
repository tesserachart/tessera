import type { IndicatorPresets } from '@tessera/protocol';
import { patch, makeStore, useStore } from '../../app/store.ts';
import { readPresets } from './model.ts';

export interface PresetsState extends IndicatorPresets {
  loaded: boolean;
}

export const presetsStore = makeStore<PresetsState>({ presets: [], defaults: {}, loaded: false });

export function usePresets<T>(selector: (s: PresetsState) => T): T {
  return useStore(presetsStore, selector);
}

export function putPresets(value: unknown): void {
  patch(presetsStore, { ...readPresets(value), loaded: true });
}
