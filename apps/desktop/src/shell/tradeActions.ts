import {
  ClientClosed,
  ConnectionLost,
  LATE_ORDER,
  NotConnected,
  ORDER_FRESH_MS,
  RequestTimeout,
  createStore,
  orderDeadlineNs,
  type ApprovalsResolveParams,
  type ApprovalsResolveResult,
  type Bracket,
  type Environment,
  type InvokeSurface,
  type Order,
  type OrderInput,
  type OrderStatus,
  type RequestError,
  type ToolName,
  type ToolResult,
} from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { breakevenDone } from '../chart/breakeven.ts';
import { reverseDone } from '../chart/ticket/send.ts';
import { restingPrice, type LegRole } from '../chart/brackets.ts';
import { entryWithLegs, exitInput, replaceInput, type LegHost } from '../chart/placement.ts';
import { hasLegs, legWords } from './oco.ts';
import { sendSurface, toTick } from './ticket.ts';
import { clearRefusal, noteRefusal } from '../state/refusals.ts';
import { approve, ranUnread, runToolResult, type ToolInput } from '../app/tools.ts';

export interface ActionResult {
  tone: 'ok' | 'err' | 'info';
  text: string;
  order?: Order;
  what?: string;
  approval?: boolean;
  head?: string;
  key?: string;
}

const STATUS_WORD: Record<OrderStatus, string> = {
  pending_submit: 'sent',
  held: 'held',
  working: 'working',
  partially_filled: 'partly filled',
  pending_cancel: 'cancelling',
  filled: 'filled',
  cancelled: 'cancelled',
  rejected: 'rejected',
  expired: 'expired',
};

export function firstFailure(results: readonly ActionResult[]): ActionResult | null {
  return results.find((r) => r.tone === 'err') ?? null;
}

export const EXIT_SURFACE: InvokeSurface = { armed: true, holdConfirmed: false };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runtimeFailureWords(err: unknown): string | null {
  if (err instanceof NotConnected) return 'The runtime is not connected. Nothing sent.';
  if (err instanceof RequestTimeout || err instanceof ConnectionLost || err instanceof ClientClosed)
    return 'No answer from the runtime; check Orders before sending it again';
  return null;
}

export class AlreadySending extends Error {
  constructor() {
    super('Already sending this order. Nothing sent.');
    this.name = 'AlreadySending';
  }
}

function alreadySending(): Promise<never> {
  return Promise.reject(new AlreadySending());
}

function afterInflight(running: Promise<unknown>): Promise<never> {
  return running.then(alreadySending, alreadySending);
}

export function sendFailure(err: unknown, what?: string, key?: string): ActionResult {
  if (err instanceof AlreadySending) {
    return { tone: 'err', text: err.message, ...(what === undefined ? {} : { what }) };
  }
  const named = {
    ...(what === undefined ? {} : { what }),
    ...(key === undefined ? {} : { key }),
  };
  if (ranUnread(err)) {
    return {
      tone: 'info',
      text: `${what ?? 'Sent'}: sent, but its answer could not be read. Orders shows it.`,
      ...named,
    };
  }
  return { tone: 'err', text: runtimeFailureWords(err) ?? message(err), ...named };
}

export interface LateOrder {
  key: string;
  result: ActionResult;
}

let freshMs = ORDER_FRESH_MS;
const held = createStore<ReadonlySet<string>>(new Set());
const lateListeners = new Set<(update: LateOrder) => void>();

interface Hold {
  done: Promise<unknown>;
  lapse: ReturnType<typeof setTimeout> | null;
}

const holds = new Map<string, Hold>();

function publishHolds(): void {
  held.set(new Set(holds.keys()));
}

export function orderFreshMs(): number {
  return freshMs;
}

export function orderHoldBoundMs(): number {
  return freshMs * 2;
}

export function useOrderFreshMs(ms: number): () => void {
  const prev = freshMs;
  freshMs = ms;
  return () => {
    freshMs = prev;
  };
}

export function heldOrderIntents() {
  return held;
}

export function isOrderHeld(key: string): boolean {
  return held.getSnapshot().has(key);
}

export function watchOrderLate(fn: (update: LateOrder) => void): () => void {
  lateListeners.add(fn);
  return () => {
    lateListeners.delete(fn);
  };
}

export function resetOrderIntents(): void {
  for (const hold of holds.values()) if (hold.lapse) clearTimeout(hold.lapse);
  holds.clear();
  publishHolds();
}

function intentPart(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function orderIntentKey(name: string, input: object): string {
  const i = input as Record<string, unknown>;
  return [
    name,
    intentPart(i.accountId ?? i.account),
    intentPart(i.instrument ?? i.symbol),
    intentPart(i.side),
    intentPart(i.orderType),
    intentPart(i.qty),
    intentPart(i.orderId),
    intentPart(i.limitPrice),
    intentPart(i.stopPrice),
  ].join('\0');
}

export function approvalIntent(approvalId: string, decision: string): string {
  return `approvals.resolve|${approvalId}|${decision}`;
}

function release(intent: string, hold: Hold): void {
  if (holds.get(intent) !== hold) return;
  if (hold.lapse) clearTimeout(hold.lapse);
  holds.delete(intent);
  publishHolds();
}

function publishLate(key: string, result: ActionResult): void {
  for (const fn of [...lateListeners]) fn({ key, result });
}

function lateAction(value: unknown, error: RequestError | null): ActionResult {
  if (error) return sendFailure(error);
  const res = value as ToolResult | null;
  if (!res || typeof res !== 'object') return { tone: 'err', text: LATE_ORDER };
  if (res.status === 'pending_approval')
    return { tone: 'info', text: 'Drafted, approve it on the card', approval: true };
  if (!res.ok) return { tone: 'err', text: res.error?.message ?? LATE_ORDER };
  return { tone: 'ok', text: 'Sent' };
}

type OnLate = (value: unknown, error: RequestError | null) => void;

function sendOnce<A>(intent: string, send: (onLate: OnLate) => Promise<A>): Promise<A> {
  const running = holds.get(intent);
  if (running) return afterInflight(running.done);
  const hold: Hold = { done: Promise.resolve(), lapse: null };
  const done = send((value, error) => {
    release(intent, hold);
    publishLate(intent, { ...lateAction(value, error), key: intent });
  }).then(
    (res) => {
      release(intent, hold);
      return res;
    },
    (err: unknown) => {
      if (err instanceof RequestTimeout && holds.get(intent) === hold) {
        hold.lapse = setTimeout(() => {
          release(intent, hold);
        }, freshMs);
      } else release(intent, hold);
      throw err;
    },
  );
  hold.done = done;
  holds.set(intent, hold);
  publishHolds();
  return done;
}

function sendNow<N extends ToolName>(name: N, input: ToolInput<N>, surface: InvokeSurface) {
  return sendOnce(orderIntentKey(name, input), (onLate) =>
    runToolResult(name, input, {
      surface,
      queue: false,
      idempotencyKey: crypto.randomUUID(),
      timeoutMs: freshMs,
      deadline: orderDeadlineNs(Date.now(), freshMs),
      onLate,
    }),
  );
}

export function resolveNow(params: ApprovalsResolveParams): Promise<ApprovalsResolveResult> {
  return sendOnce(approvalIntent(params.approvalId, params.decision), (onLate) =>
    approve(
      {
        ...params,
        deadline: params.deadline ?? orderDeadlineNs(Date.now(), freshMs),
        idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
      },
      { timeoutMs: freshMs, onLate },
    ),
  );
}

interface Submitted {
  order: Order;
  bracket: readonly Order[];
}

interface LegWords {
  stop: string | null;
  target: string | null;
}

type SaidWords = (what: string, input: OrderInput, out: Submitted, decimals: number) => string;

function bracketLegs(b: Bracket | null | undefined, decimals: number): LegWords {
  return { stop: legWords(b, 'stop', decimals), target: legWords(b, 'target', decimals) };
}

function placedLegs(input: OrderInput, out: Submitted, decimals: number): LegWords {
  const asked = bracketLegs(out.order.request.bracket ?? input.bracket, decimals);
  if (out.bracket.length === 0) return asked;
  const at = (role: Order['role'], fallback: string | null) => {
    const leg = out.bracket.find((o) => o.role === role);
    if (!leg) return null;
    const price = restingPrice(leg.request);
    return price === null ? fallback : formatPrice(price, decimals);
  };
  return { stop: at('stop_loss', asked.stop), target: at('take_profit', asked.target) };
}

function withLegs(what: string, legs: LegWords): string | null {
  const named = [legs.stop !== null ? `SL ${legs.stop}` : null, legs.target !== null ? `TP ${legs.target}` : null];
  const said = named.filter((w) => w !== null);
  return said.length > 0 ? [what, ...said].join(' · ') : null;
}

export const submittedWords: SaidWords = (what, input, out, decimals) => {
  if (!hasLegs(input.bracket)) return what;
  if (out.bracket.length === 0 && !out.order.request.bracket) return `${what}, joining the position's bracket`;
  return withLegs(what, placedLegs(input, out, decimals)) ?? what;
};

const asSent: SaidWords = (what) => what;

function draftedWords(what: string, input: OrderInput, decimals: number): string {
  return withLegs(what, bracketLegs(input.bracket, decimals)) ?? what;
}

export async function submitOrder(
  env: Environment,
  input: OrderInput,
  what: string,
  decimals: number,
  saidAs: SaidWords = submittedWords,
): Promise<ActionResult> {
  const key = orderIntentKey('orders.submit', input);
  try {
    const res = await sendNow('orders.submit', input, sendSurface(env, input.accountId));
    if (res.status === 'pending_approval') {
      const drafted = draftedWords(what, input, decimals);
      return { tone: 'info', text: `${drafted}: drafted, approve it on the card`, what: drafted, approval: true, key };
    }
    if (!res.ok || !res.output) {
      const text = res.error?.message ?? `${what}: ${res.status}`;
      noteRefusal({ accountId: input.accountId, instrument: input.instrument, text, what });
      return { tone: 'err', text, what, key };
    }
    clearRefusal(input.accountId, input.instrument);
    const o = res.output.order;
    const filled =
      o.status === 'filled' && o.avgFillPrice !== null ? ` at ${formatPrice(o.avgFillPrice, decimals)}` : '';
    const said = saidAs(what, input, res.output, decimals);
    return { tone: 'ok', text: `${said}: ${STATUS_WORD[o.status]}${filled}`, order: o, what: said, key };
  } catch (err) {
    return sendFailure(err, what, key);
  }
}

export async function modifyOrderPrice(env: Environment, order: Order, price: number): Promise<ActionResult> {
  const t = order.request.orderType;
  const changes = t === 'stop' || t === 'stop_limit' ? { stopPrice: price } : { limitPrice: price };
  const input = { accountId: order.request.accountId, orderId: order.id, ...changes };
  const key = orderIntentKey('orders.modify', input);
  try {
    const res = await sendNow('orders.modify', input, sendSurface(env, order.request.accountId));
    if (res.status === 'pending_approval')
      return { tone: 'info', text: 'Move drafted, approve it on the card', approval: true, key };
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? `Move: ${res.status}`, key };
    return { tone: 'ok', text: 'Moved', order: res.output.order, key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

/** Rithmic's native bracket cannot drop a leg of a working entry. */
export async function cancelOrder(order: Order): Promise<ActionResult> {
  const input = { accountId: order.request.accountId, orderId: order.id };
  const key = orderIntentKey('orders.cancel', input);
  try {
    const res = await sendNow('orders.cancel', input, EXIT_SURFACE);
    if (!res.ok && res.error?.code === 'unsupported' && order.status === 'held' && order.parentId !== null)
      return await dropHeldLeg(order);
    if (!res.ok) return { tone: 'err', text: res.error?.message ?? 'Cancel failed', key };
    return { tone: 'ok', text: 'Cancelled', key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

async function dropHeldLeg(leg: Order): Promise<ActionResult> {
  const res = await runToolResult('portfolio.get_orders', {
    accountId: leg.request.accountId,
    openOnly: true,
  });
  const open = res.ok && res.output ? res.output.orders : [];
  const entry = open.find((o) => o.id === leg.parentId);
  if (!entry) return { tone: 'err', text: 'Its entry is no longer working' };
  const legOf = (role: Order['role']) =>
    role === leg.role ? null : (open.find((o) => o.parentId === entry.id && o.role === role) ?? null);
  const stop = legOf('stop_loss')?.request.stopPrice ?? null;
  const target = legOf('take_profit')?.request.limitPrice ?? null;
  const what = `${leg.role === 'stop_loss' ? 'Stop' : 'Target'} removed`;
  const c = await cancelOrder(entry);
  if (c.tone === 'err') return { tone: 'err', text: `${what}: the entry could not be replaced (${c.text})`, what };
  const r = await submitOrder(entry.environment, entryWithLegs(entry, stop, target), what, 2);
  return r.tone === 'err' ? entryLost(r) : { tone: 'ok', text: what };
}

export interface PriceMove {
  readonly order: Order;
  readonly price: number;
}

export function shiftedBy(orders: readonly Order[], delta: number, tick: number): PriceMove[] {
  return orders.flatMap((order) => {
    const from = restingPrice(order.request);
    return from === null ? [] : [{ order, price: toTick(from + delta, tick) }];
  });
}

export async function moveOrders(env: Environment, moves: readonly PriceMove[]): Promise<ActionResult> {
  for (const m of moves) {
    const r = await modifyOrderPrice(env, m.order, m.price);
    if (r.tone !== 'ok') return r;
  }
  return { tone: 'ok', text: 'Moved' };
}

/** Rithmic's native bracket cannot gain a leg once sent. */
export async function attachLeg(
  env: Environment,
  host: LegHost,
  role: LegRole,
  price: number,
  what: string,
  decimals: number,
  qty?: number,
): Promise<ActionResult> {
  if (host.kind === 'position') return submitOrder(env, exitInput(host, role, price, qty), what, decimals);
  const c = await cancelOrder(host.order);
  if (c.tone === 'err') return { tone: 'err', text: `${what}: the entry could not be replaced (${c.text})`, what };
  const r = await submitOrder(env, replaceInput(host, role, price), what, decimals, asSent);
  return r.tone === 'err' ? entryLost(r) : r;
}

function entryLost(r: ActionResult): ActionResult {
  return { ...r, head: 'The entry was cancelled: send it again' };
}

export async function cancelOrders(orders: readonly Order[]): Promise<ActionResult> {
  const sorted = [...orders].sort((a, b) => Number(a.parentId !== null) - Number(b.parentId !== null));
  for (const o of sorted) {
    const r = await cancelOrder(o);
    if (r.tone === 'err' && !/already/i.test(r.text)) return r;
  }
  return { tone: 'ok', text: `Cancelled ${String(orders.length)}` };
}

export async function flatten(accountId: string, instrument: string, symbol: string): Promise<ActionResult> {
  const input = { accountId, instrument };
  const key = orderIntentKey('orders.flatten', input);
  try {
    const res = await sendNow('orders.flatten', input, EXIT_SURFACE);
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? 'Flatten failed', key };
    return { tone: 'ok', text: res.output.flat ? `Flat ${symbol}` : `Flattening ${symbol}`, key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

export async function mergeBrackets(accountId: string, instrument: string, symbol: string): Promise<ActionResult> {
  const input = { accountId, instrument };
  const key = orderIntentKey('orders.merge_brackets', input);
  try {
    const res = await sendNow('orders.merge_brackets', input, EXIT_SURFACE);
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? 'The merge did not go through', key };
    return { tone: 'ok', text: `${res.output.summary} on ${symbol}`, key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

export async function breakeven(
  accountId: string,
  instrument: string,
  symbol: string,
  offsetTicks: number | null,
  dp: number,
): Promise<ActionResult> {
  const input = offsetTicks === null ? { accountId, instrument } : { accountId, instrument, offsetTicks };
  const key = orderIntentKey('orders.breakeven', input);
  try {
    const res = await sendNow('orders.breakeven', input, EXIT_SURFACE);
    if (res.status === 'pending_approval')
      return { tone: 'info', text: 'Breakeven drafted, approve it on the card', approval: true, key };
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? 'Breakeven did not go through', key };
    return { tone: 'ok', text: breakevenDone(res.output, symbol, dp), key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

export async function reverse(
  env: Environment,
  accountId: string,
  instrument: string,
  bracket: Bracket | null,
  what: string,
  dp: number,
): Promise<ActionResult> {
  const input = bracket ? { accountId, instrument, bracket } : { accountId, instrument };
  const key = orderIntentKey('orders.reverse', input);
  try {
    const res = await sendNow('orders.reverse', input, sendSurface(env, accountId));
    if (res.status === 'pending_approval')
      return { tone: 'info', text: `${what}: drafted, approve it on the card`, what, approval: true, key };
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? `${what}: ${res.status}`, what, key };
    return { tone: 'ok', text: `${what}: ${reverseDone(res.output, dp)}`, what, key };
  } catch (err) {
    return sendFailure(err, what, key);
  }
}

export async function cancelWorking(
  accountId: string,
  instrument: string,
  symbol: string,
  selection: { orders: readonly Order[]; kept: number },
): Promise<ActionResult> {
  if (selection.kept === 0) return cancelAll(accountId, instrument, symbol);
  const r = await cancelOrders(selection.orders);
  return r.tone === 'err' ? r : { tone: 'ok', text: `${r.text} ${symbol}; the position’s stop and target stay` };
}

export async function cancelAll(accountId: string, instrument: string, symbol: string): Promise<ActionResult> {
  const input = { accountId, instrument };
  const key = orderIntentKey('orders.cancel_all', input);
  try {
    const res = await sendNow('orders.cancel_all', input, EXIT_SURFACE);
    if (!res.ok || !res.output) return { tone: 'err', text: res.error?.message ?? 'Cancel all failed', key };
    return { tone: 'ok', text: `Cancelled ${String(res.output.cancelled.length)} ${symbol}`, key };
  } catch (err) {
    return sendFailure(err, undefined, key);
  }
}

export function openHome(section: string): void {
  window.dispatchEvent(new CustomEvent('tessera:open-home', { detail: { section } }));
}

export function askAnalyst(text: string): void {
  window.dispatchEvent(new CustomEvent('tessera:ask-analyst', { detail: { text } }));
}
