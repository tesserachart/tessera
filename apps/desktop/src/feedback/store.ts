import { makeStore, patch, read, useStore } from '../app/store.ts';
import { layoutsStore } from '../state/layouts.ts';
import { ticketOf, ticketsStore } from '../state/tickets.ts';
import { activeChartTarget } from '../workspace/controller.ts';

export interface FeedbackFocus {
  instrument: string | null;
  timeframe: string | null;
  accountId: string | null;
}

export interface FeedbackState {
  open: boolean;
  focus: FeedbackFocus;
  opened: number;
}

const NO_FOCUS: FeedbackFocus = { instrument: null, timeframe: null, accountId: null };

export const feedbackStore = makeStore<FeedbackState>({ open: false, focus: NO_FOCUS, opened: 0 });

export function useFeedback<T>(pick: (s: FeedbackState) => T): T {
  return useStore(feedbackStore, pick);
}

function focusNow(): FeedbackFocus {
  const target = activeChartTarget();
  if (!target) return NO_FOCUS;
  const chart = read(layoutsStore).layouts[target.layoutId]?.charts[target.tileId];
  if (!chart) return NO_FOCUS;
  return {
    instrument: chart.instrument,
    timeframe: chart.printBars ? null : chart.timeframe,
    accountId: ticketOf(read(ticketsStore).tickets, target.tileId).accountId ?? null,
  };
}

export function openFeedback(): void {
  if (read(feedbackStore).open) return;
  patch(feedbackStore, (s) => ({ open: true, focus: focusNow(), opened: s.opened + 1 }));
}

export function closeFeedback(): void {
  patch(feedbackStore, { open: false });
}
