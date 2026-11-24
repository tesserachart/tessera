import type { TimeAsk, ViewportState, ViewportUpdate } from '@tessera/chart';
import { normalizeEpochMs, type Viewport } from '@tessera/protocol';
import type { HistoryEnd } from '../market/bars.ts';
import type { ViewShortfall } from '../shell/deskWords.ts';

export interface HeldBars {
  count: number;
  first: number | null;
  last: number | null;
  lastEnd: number | null;
}

export type AskOutcome = { kind: 'met' } | { kind: 'reading' } | { kind: 'short'; short: ViewShortfall };

const MET: AskOutcome = { kind: 'met' };
const READING: AskOutcome = { kind: 'reading' };

export function askOutcome(ask: TimeAsk, held: HeldBars, end: HistoryEnd | null): AskOutcome {
  if ('fitAll' in ask) return MET;
  if (held.count === 0 || held.first === null || held.last === null || held.lastEnd === null)
    return end ? MET : READING;
  if ('lastBars' in ask) {
    if (held.count >= ask.lastBars) return MET;
    return end ? { kind: 'short', short: { kind: 'bars', asked: ask.lastBars, shown: held.count, end } } : READING;
  }
  const { from } = ask.range;
  if (from >= held.lastEnd) return { kind: 'short', short: { kind: 'after', asked: from, last: held.last } };
  if (held.first <= from) return MET;
  return end ? { kind: 'short', short: { kind: 'from', asked: from, first: held.first, end } } : READING;
}

function askUpdate(ask: TimeAsk): ViewportUpdate {
  if ('fitAll' in ask) return { fitAll: true };
  if ('lastBars' in ask) return { lastBars: ask.lastBars };
  return { range: ask.range };
}

export function viewToKeep(vp: ViewportState, times: ArrayLike<number>): ViewportUpdate | null {
  if (vp.asked) return askUpdate(vp.asked);
  if (!vp.shown) return null;
  if (vp.following) return { lastBars: vp.shown.to - vp.shown.from + 1 };
  return { range: { from: times[vp.shown.from]!, to: times[vp.shown.to]! } };
}

export function reportedView(v: Viewport | null | undefined): ViewportUpdate | null {
  if (!v?.bars) return null;
  if (v.follows) return { lastBars: v.bars };
  return { range: { from: normalizeEpochMs(v.from), to: normalizeEpochMs(v.to) } };
}
