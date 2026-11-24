import type { AggTape } from './aggregate.ts';
import type { TradeTape } from './tradeTape.ts';

export const FOLLOW_NS = 60_000_000_000;
export const MIN_REACH_TICKS = 2;

export type OutcomeKind = 'absorbed' | 'pushed' | 'neither';

export interface OutcomeAt {
  kind: OutcomeKind;
  decidedNs: number;
}

export interface OutcomeWatch {
  readonly buy: boolean;
  readonly throughTick: number;
  readonly backTick: number;
  readonly lastNs: number;
  readonly reachTicks: number;
  next: number;
}

export function watchOutcome(agg: AggTape, i: number, reachTicks: number): OutcomeWatch | null {
  const s = i & (agg.capacity - 1);
  const side = agg.side[s]!;
  if (side === 0) return null;
  const tape = agg.tape;
  const first = Math.max(agg.firstPrint[s]!, tape.start);
  const last = agg.firstPrint[s]! + agg.prints[s]! - 1;
  if (last < tape.start) return null;
  let low = Infinity;
  let high = -Infinity;
  for (let k = first; k <= last; k++) {
    low = Math.min(low, tape.tickAt(k));
    high = Math.max(high, tape.tickAt(k));
  }
  const buy = side > 0;
  const avg = agg.tick[s]!;
  return {
    buy,
    throughTick: buy ? high + reachTicks : low - reachTicks,
    backTick: buy ? avg - reachTicks : avg + reachTicks,
    lastNs: tape.nsAt(last),
    reachTicks,
    next: last + 1,
  };
}

export function decideOutcome(tape: TradeTape, w: OutcomeWatch): OutcomeAt | null {
  const ends = w.lastNs + FOLLOW_NS;
  for (let i = Math.max(w.next, tape.start); i < tape.end; i++) {
    const t = tape.nsAt(i);
    if (t <= w.lastNs) continue;
    if (t > ends) return { kind: 'neither', decidedNs: ends };
    const k = tape.tickAt(i);
    if (w.buy ? k >= w.throughTick : k <= w.throughTick) return { kind: 'pushed', decidedNs: t };
    if (w.buy ? k <= w.backTick : k >= w.backTick) return { kind: 'absorbed', decidedNs: t };
  }
  w.next = tape.end;
  return null;
}
