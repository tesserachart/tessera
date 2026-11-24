import type { Bracket, JsonValue, OrderInput, OrderType, Side } from '@tessera/protocol';
import { OrderInput as OrderInputSchema } from '@tessera/protocol/schemas';
import { formatPrice, formatMoney } from '@tessera/ui';
import { legPrice, type ContractMath } from './oco.ts';
import { parsePrice, toTick } from './ticket.ts';

export type LegRole = 'stop' | 'target';

type LegAt = { kind: 'price'; text: string } | { kind: 'ticks'; ticks: number };

interface LegEdit {
  on: boolean;
  at: LegAt;
}

export interface OrderEdit {
  side: Side;
  orderType: OrderType;
  qty: number;
  limitPrice: string;
  stopPrice: string;
  stop: LegEdit;
  target: LegEdit;
}

export const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop', 'stop_limit'];

export const ORDER_TYPE_WORD: Record<OrderType, string> = {
  market: 'Market',
  limit: 'Limit',
  stop: 'Stop',
  stop_limit: 'Stop limit',
};

export function usesLimit(t: OrderType): boolean {
  return t === 'limit' || t === 'stop_limit';
}

export function usesStop(t: OrderType): boolean {
  return t === 'stop' || t === 'stop_limit';
}

export function draftOrderInput(tool: string, input: JsonValue): OrderInput | null {
  if (tool !== 'orders.submit') return null;
  const parsed = OrderInputSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function priceText(p: number | null | undefined, decimals: number): string {
  return p === null || p === undefined ? '' : formatPrice(p, decimals);
}

function legOf(b: Bracket | undefined, role: LegRole, decimals: number): LegEdit {
  const price = role === 'stop' ? b?.stopLoss : b?.takeProfit;
  const ticks = role === 'stop' ? b?.stopTicks : b?.targetTicks;
  if (price !== null && price !== undefined)
    return { on: true, at: { kind: 'price', text: priceText(price, decimals) } };
  if (ticks !== undefined) return { on: true, at: { kind: 'ticks', ticks } };
  return { on: false, at: { kind: 'price', text: '' } };
}

export function orderEditOf(input: OrderInput, m: ContractMath): OrderEdit {
  return {
    side: input.side,
    orderType: input.orderType,
    qty: input.qty,
    limitPrice: priceText(input.limitPrice, m.decimals),
    stopPrice: priceText(input.stopPrice, m.decimals),
    stop: legOf(input.bracket, 'stop', m.decimals),
    target: legOf(input.bracket, 'target', m.decimals),
  };
}

export function entryPrice(e: OrderEdit, m: ContractMath): number | null {
  if (e.orderType === 'market') return null;
  return parsePrice(usesStop(e.orderType) ? e.stopPrice : e.limitPrice, m.tick);
}

export function stepPriceText(text: string, n: number, m: ContractMath, fallback: number | null): string {
  const from = parsePrice(text, m.tick) ?? fallback;
  return from === null ? text : formatPrice(toTick(from + n * m.tick, m.tick), m.decimals);
}

export function withOrderType(e: OrderEdit, orderType: OrderType, m: ContractMath, last: number | null): OrderEdit {
  const seed = e.limitPrice || e.stopPrice || priceText(last === null ? null : toTick(last, m.tick), m.decimals);
  return {
    ...e,
    orderType,
    limitPrice: usesLimit(orderType) && !e.limitPrice ? seed : e.limitPrice,
    stopPrice: usesStop(orderType) && !e.stopPrice ? seed : e.stopPrice,
  };
}

function hasPlace(at: LegAt): boolean {
  return at.kind === 'ticks' || at.text.trim() !== '';
}

export function withLegOn(e: OrderEdit, role: LegRole, on: boolean, m: ContractMath, ticks: number): OrderEdit {
  const leg = e[role];
  if (!on || hasPlace(leg.at)) return { ...e, [role]: { ...leg, on } };
  const entry = entryPrice(e, m);
  const at: LegAt =
    entry === null
      ? { kind: 'ticks', ticks }
      : { kind: 'price', text: formatPrice(legPrice(e.side, role, entry, ticks, m.tick), m.decimals) };
  return { ...e, [role]: { on: true, at } };
}

function legDistance(e: OrderEdit, role: LegRole, m: ContractMath): number | null {
  const at = e[role].at;
  if (at.kind === 'ticks') return at.ticks;
  const entry = entryPrice(e, m);
  const price = parsePrice(at.text, m.tick);
  return entry === null || price === null ? null : Math.round(Math.abs(price - entry) / m.tick);
}

export function legHint(e: OrderEdit, role: LegRole, m: ContractMath): string | null {
  const leg = e[role];
  if (!leg.on) return null;
  const ticks = legDistance(e, role, m);
  if (ticks === null) return null;
  const money = formatMoney(ticks * m.tickValue * e.qty);
  const away = `${String(ticks)}t · ${role === 'stop' ? `−${money}` : money}`;
  return leg.at.kind === 'ticks' ? `${away} from the fill` : away;
}

export class OrderEditError extends Error {}

function needPrice(text: string, what: string, m: ContractMath): number {
  const p = parsePrice(text, m.tick);
  if (p === null) throw new OrderEditError(`Enter ${what}`);
  return p;
}

type LegValue = { price: number } | { ticks: number } | null;

function legValue(leg: LegEdit, role: LegRole, m: ContractMath): LegValue {
  if (!leg.on) return null;
  if (leg.at.kind === 'ticks') {
    if (!(leg.at.ticks >= 1)) throw new OrderEditError(`Enter the ${role}’s distance`);
    return { ticks: Math.round(leg.at.ticks) };
  }
  return { price: needPrice(leg.at.text, `the ${role}’s price`, m) };
}

function bracketOf(was: Bracket | undefined, e: OrderEdit, m: ContractMath): Bracket | null {
  const stop = legValue(e.stop, 'stop', m);
  const target = legValue(e.target, 'target', m);
  if (!stop && !target) return null;
  const b: Bracket = {
    stopLoss: stop && 'price' in stop ? stop.price : null,
    takeProfit: target && 'price' in target ? target.price : null,
  };
  if (stop && 'ticks' in stop) b.stopTicks = stop.ticks;
  if (target && 'ticks' in target) b.targetTicks = target.ticks;
  if (stop && was?.breakeven) b.breakeven = was.breakeven;
  if (stop && was?.trail) b.trail = was.trail;
  return b;
}

export function editedOrderInput(was: OrderInput, e: OrderEdit, m: ContractMath): OrderInput {
  if (!(e.qty > 0)) throw new OrderEditError('Enter how many contracts');
  const next: OrderInput = { ...was, side: e.side, orderType: e.orderType, qty: e.qty };
  delete next.limitPrice;
  delete next.stopPrice;
  delete next.bracket;
  if (usesLimit(e.orderType)) next.limitPrice = needPrice(e.limitPrice, 'a limit price', m);
  if (usesStop(e.orderType)) next.stopPrice = needPrice(e.stopPrice, 'a stop price', m);
  const bracket = was.reduceOnly ? null : bracketOf(was.bracket, e, m);
  if (bracket) next.bracket = bracket;
  return next;
}
