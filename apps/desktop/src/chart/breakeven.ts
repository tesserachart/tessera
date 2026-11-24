import type { BreakevenStopOutput } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import type { OcoConfig } from '../shell/oco.ts';
import type { Bracket, Leg } from './brackets.ts';

export interface BreakevenView {
  why: string | null;
  price: number | null;
  offset: number;
  stops: Leg[];
  newStop: boolean;
}

export function breakevenOffset(oco: OcoConfig | null): number | null {
  return oco?.on && oco.breakeven.on ? Math.max(0, Math.round(oco.breakeven.offset)) : null;
}

const WORKING = new Set(['working', 'partially_filled']);

function positionStops(position: Bracket): Leg[] {
  return position.stops.filter(
    (l) => l.order !== null && !l.held && l.order.status !== 'held' && l.order.triggeredAt === null,
  );
}

function towardProfit(price: number, tick: number, long: boolean): number {
  if (!(tick > 0)) return price;
  const raw = price / tick;
  const n = long ? Math.ceil(raw - 1e-9) : Math.floor(raw + 1e-9);
  return Number((n * tick).toFixed(10));
}

export function breakevenOf(position: Bracket | null, tick: number, asked: number | null): BreakevenView {
  const none = { price: null, offset: 0, stops: [], newStop: false };
  if (position?.kind !== 'position') return { why: 'No position', ...none };
  const stops = positionStops(position);
  if (stops.some((l) => !WORKING.has(l.order!.status))) return { why: 'Stop is on its way to the broker', ...none };
  const rules = stops
    .map((l) => l.order?.stopRules?.breakeven?.offsetTicks)
    .filter((n): n is number => typeof n === 'number');
  const offset = asked ?? (rules.length ? Math.min(...rules) : 0);
  const long = position.side === 'buy';
  const price = towardProfit(position.price + (long ? 1 : -1) * offset * tick, tick, long);
  if (stops.length === 0) return { why: null, price, offset, stops: [], newStop: true };
  const eps = tick > 0 ? tick / 2 : 1e-9;
  const behind = stops.filter((l) => (long ? l.price < price - eps : l.price > price + eps));
  if (behind.length === 0)
    return {
      why: stops.length === 1 ? 'Stop is already at or past breakeven' : 'Stops are already at or past breakeven',
      price,
      offset,
      stops: [],
      newStop: false,
    };
  return { why: null, price, offset, stops: behind, newStop: false };
}

function ticks(n: number): string {
  return `${String(n)} ${n === 1 ? 'tick' : 'ticks'}`;
}

function priceWords(v: BreakevenView, dp: number): string {
  const at = formatPrice(v.price ?? 0, dp);
  return v.offset > 0 ? `${at}, the entry + ${ticks(v.offset)}` : `${at}, the entry`;
}

export function breakevenTip(v: BreakevenView, dp: number): string {
  if (v.why !== null) return v.why;
  if (v.newStop) return `Place a stop at breakeven: ${priceWords(v, dp)}`;
  return v.stops.length === 1
    ? `Move the stop to breakeven: ${priceWords(v, dp)}`
    : `Move the ${String(v.stops.length)} stops to breakeven: ${priceWords(v, dp)} (the position’s average)`;
}

export function breakevenDone(out: BreakevenStopOutput, symbol: string, dp: number): string {
  if (out.placed) return `Stop placed at breakeven ${formatPrice(out.price, dp)} on ${symbol}`;
  const n = out.moved.length;
  const what = n === 1 ? 'Stop' : `${String(n)} stops`;
  const kept = out.kept > 0 ? `; ${String(out.kept)} already past it ${out.kept === 1 ? 'stays' : 'stay'}` : '';
  return `${what} to breakeven ${formatPrice(out.price, dp)} on ${symbol}${kept}`;
}
