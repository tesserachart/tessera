import type {
  AccountUpdate,
  LimitsStatus,
  Order,
  OrderStatus,
  OrderType,
  Position,
  ToolCallEvent,
  ToolCallRecord,
  ToolErrorCode,
  ToolErrorInfo,
  ToolName,
} from '@tessera/protocol';
import { lockCause } from '../accounts/limits.ts';
import type { SoundName } from './tones.ts';
import { VOICE_LINES, type VoiceLineId } from './voice/lines.ts';

export interface SeenOrder {
  status: OrderStatus;
  filledQty: number;
}

const DONE: ReadonlySet<OrderStatus> = new Set(['filled', 'cancelled', 'rejected', 'expired']);

const KEEP = 2000;

const FILLED: Readonly<Record<OrderType, VoiceLineId>> = {
  market: 'market_filled',
  limit: 'limit_filled',
  stop: 'stop_filled',
  stop_limit: 'stop_limit_filled',
};

const SHOWN_AS_LEG = "Shown as its bracket's ";

export function orderLine(prev: SeenOrder | undefined, order: Order): VoiceLineId | null {
  const filled = order.filledQty > (prev?.filledQty ?? 0) || (order.status === 'filled' && prev?.status !== 'filled');
  if (filled) {
    if (order.role === 'stop_loss') return 'stop_hit';
    if (order.role === 'take_profit') return 'target_hit';
    const done = order.status === 'filled' || order.filledQty >= order.request.qty;
    return done ? FILLED[order.request.orderType] : 'partially_filled';
  }
  if (order.status === 'rejected' && prev?.status !== 'rejected') return 'order_rejected';
  if (order.status === 'cancelled' && prev?.status !== 'cancelled') {
    if (order.role === 'stop_loss' || order.role === 'take_profit') return null;
    if (order.reason?.startsWith(SHOWN_AS_LEG)) return null;
    return 'order_cancelled';
  }
  return null;
}

export function tradeSound(prev: SeenOrder | undefined, order: Order): SoundName | null {
  const line = orderLine(prev, order);
  return line ? VOICE_LINES[line].tone : null;
}

function merged(prev: SeenOrder | undefined, order: Order): SeenOrder {
  if (!prev) return { status: order.status, filledQty: order.filledQty };
  return {
    status: DONE.has(prev.status) ? prev.status : order.status,
    filledQty: Math.max(prev.filledQty, order.filledQty),
  };
}

function remember<V>(m: Map<string, V>, key: string, value: V): void {
  m.delete(key);
  m.set(key, value);
  if (m.size > KEEP) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

abstract class Tracker<T, S> {
  protected readonly seen = new Map<string, S>();
  private active = false;

  activate(): void {
    this.active = true;
  }

  reset(): void {
    this.seen.clear();
  }

  restart(): void {
    this.seen.clear();
    this.active = false;
  }

  see(value: T, seq: number): VoiceLineId | null {
    const key = this.keyOf(value);
    const prev = this.seen.get(key);
    remember(this.seen, key, this.next(prev, value));
    return this.active && seq > 0 ? this.lineOf(prev, value) : null;
  }

  protected abstract keyOf(value: T): string;
  protected abstract next(prev: S | undefined, value: T): S;
  protected abstract lineOf(prev: S | undefined, value: T): VoiceLineId | null;
}

export class TradeSoundTracker extends Tracker<Order, SeenOrder> {
  protected keyOf(o: Order): string {
    return o.id;
  }
  protected next(prev: SeenOrder | undefined, o: Order): SeenOrder {
    return merged(prev, o);
  }
  protected lineOf(prev: SeenOrder | undefined, o: Order): VoiceLineId | null {
    return orderLine(prev, o);
  }
}

export function positionLine(prevQty: number, qty: number): VoiceLineId | null {
  if (prevQty !== 0 && qty === 0) return 'position_closed';
  if (prevQty * qty < 0) return 'position_reversed';
  return null;
}

export class PositionSoundTracker extends Tracker<Position, number> {
  protected keyOf(p: Position): string {
    return `${p.accountId}\u0000${p.instrument}`;
  }
  protected next(_prev: number | undefined, p: Position): number {
    return p.qty;
  }
  protected lineOf(prev: number | undefined, p: Position): VoiceLineId | null {
    return positionLine(prev ?? 0, p.qty);
  }
}

function lockLine(limits: LimitsStatus | null | undefined): VoiceLineId | null {
  const cause = lockCause(limits);
  if (!cause) return null;
  return cause.kind === 'daily_loss' ? 'loss_limit' : 'account_locked';
}

export class LimitSoundTracker extends Tracker<AccountUpdate, VoiceLineId | null> {
  protected keyOf(u: AccountUpdate): string {
    return u.account.id;
  }
  protected next(_prev: VoiceLineId | null | undefined, u: AccountUpdate): VoiceLineId | null {
    return lockLine(u.limits);
  }
  protected lineOf(prev: VoiceLineId | null | undefined, u: AccountUpdate): VoiceLineId | null {
    const line = lockLine(u.limits);
    return prev !== undefined && line !== prev ? line : null;
  }
}

const PLACES_ORDERS: ReadonlySet<string> = new Set<ToolName>(['orders.submit', 'orders.reverse']);

const CODES_NEVER_SENT: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  'permission_denied',
  'invalid_input',
  'loop_guard',
  'rate_limited',
]);

function refusedBeforeBroker(e: ToolErrorInfo): boolean {
  const details = e.details;
  const sent = details && typeof details === 'object' && !Array.isArray(details) ? details.sent : undefined;
  if (typeof sent === 'boolean') return !sent;
  return CODES_NEVER_SENT.has(e.code);
}

const awaitsDecision = (call: ToolCallRecord) => call.approvalId !== null && call.approvedBy === null;

export function refusalLine(call: ToolCallRecord): VoiceLineId | null {
  if (!PLACES_ORDERS.has(call.tool) || call.deduped || awaitsDecision(call)) return null;
  return call.error && refusedBeforeBroker(call.error) ? 'order_rejected' : null;
}

const finishedRefusal = (ev: ToolCallEvent) => (ev.phase === 'finished' ? refusalLine(ev.call) : null);

export class RefusalSoundTracker extends Tracker<ToolCallEvent, boolean> {
  protected keyOf(ev: ToolCallEvent): string {
    return ev.call.callId;
  }
  protected next(said: boolean | undefined, ev: ToolCallEvent): boolean {
    return said === true || finishedRefusal(ev) !== null;
  }
  protected lineOf(said: boolean | undefined, ev: ToolCallEvent): VoiceLineId | null {
    return said === true ? null : finishedRefusal(ev);
  }
}
