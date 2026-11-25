import type { BacktestTrade } from '@tessera/protocol';
import { makeStore, patch, useStore } from '../app/store.ts';
import type { ChartTarget } from './viewportRequests.ts';

export interface LinkedTrade {
  label: string;
  instrument: string;
  trade: BacktestTrade;
  target: ChartTarget;
  back: () => void;
}

const linkedStore = makeStore<{ linked: LinkedTrade | null }>({ linked: null });

export function linkTrade(linked: LinkedTrade | null): void {
  patch(linkedStore, { linked });
}

export function useLinkedTrade(): LinkedTrade | null {
  return useStore(linkedStore, (s) => s.linked);
}

const FRAME_BARS = 12;

export function tradeRange(
  t: Pick<BacktestTrade, 'entryTime' | 'exitTime'>,
  stepNs: number,
): { from: number; to: number } {
  const pad = Math.max(FRAME_BARS * stepNs, t.exitTime - t.entryTime);
  return { from: t.entryTime - pad, to: t.exitTime + stepNs + pad };
}
