import type { AccountUpdate, Environment, Side } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { limitLockWords } from '../../accounts/limits.ts';
import { breakevenOf, breakevenOffset, type BreakevenView } from '../../chart/breakeven.ts';
import { joinStopOf, restingPrice, type Bracket, type BracketMode } from '../../chart/brackets.ts';
import {
  clickAt,
  entryKindAt,
  hostReference,
  legError,
  legHostOf,
  placeGuide,
  placeHint,
  placementFor,
  placementHost,
  pricedEntry,
  spawnPlan,
  type PlaceBase,
  type PlaceQuote,
  type PlaceTile,
  type Placement,
} from '../../chart/placement.ts';
import { runPlaceStep } from '../../chart/placementRun.ts';
import { reverseBracket, reverseOf, reverseWhat, type TicketSend } from '../../chart/ticket/send.ts';
import { legMoney, planOco, planOk, type ContractMath, type OcoConfig } from '../../shell/oco.ts';
import { toTick, type EntryKind } from '../../shell/ticket.ts';
import {
  attachLeg,
  breakeven,
  cancelAll,
  cancelOrders,
  flatten,
  modifyOrderPrice,
  reverse,
  type ActionResult,
} from '../../shell/tradeActions.ts';
import { placementStore, startPlacement } from '../../state/placement.ts';
import type { Sizing } from '../../state/tickets.ts';
import { ocoMarket } from '../../shell/tradeContext.ts';
import { ocoWords, pnlAt, refusalWords, type AccountGate, type HoverTrade, type LadderTag } from './ladderModel.ts';
import { read } from '../../app/store.ts';

interface DomTicket {
  qty: number;
  sizing: Sizing;
  risk: number;
  entry: EntryKind;
}

export function cellKind(s: DomTradeSetup, side: Side, price: number, q: PlaceQuote): EntryKind {
  return s.ticket.entry === 'market' ? entryKindAt(side, price, q) : s.ticket.entry;
}

export interface DomTradeSetup {
  account: AccountUpdate | null;
  gate: AccountGate;
  instrument: string;
  ids: ReadonlySet<string>;
  symbol: string;
  math: ContractMath | null;
  ticket: DomTicket;
  oco: OcoConfig;
  scope: PlaceTile | null;
  mode?: BracketMode;
}

function environmentOf(s: DomTradeSetup): Environment | null {
  return s.account?.account.environment ?? null;
}

export function placeBaseFor(s: DomTradeSetup): { base: PlaceBase } | { why: string } {
  if (s.gate.kind === 'none' || !s.account) return { why: 'Choose an account' };
  if (s.gate.kind === 'readonly' || s.gate.kind === 'refused') return { why: s.gate.why };
  const acct = s.account;
  const lock = limitLockWords(acct);
  if (lock) return { why: lock };
  if (!s.math) return { why: 'No contract details yet' };
  const env = acct.account.environment;
  const oco = s.oco;
  const qty = s.ticket.sizing === 'qty' ? s.ticket.qty : 1;
  const market = ocoMarket(s.math, qty, acct);
  const plan = market ? planOco(oco, market) : null;
  if (plan && oco.on && !planOk(plan))
    return { why: plan.errors.stop ?? plan.errors.target ?? plan.errors.rules ?? 'The OCO cannot be sent' };
  return {
    base: {
      accountId: acct.account.id,
      environment: env,
      instrument: s.instrument,
      symbol: s.symbol,
      side: 'buy',
      qty: s.ticket.qty,
      kind: s.ticket.entry,
      tick: s.math.tick,
      decimals: s.math.decimals,
      mode: s.ticket.sizing,
      risk: s.ticket.risk,
      tickValue: s.math.tickValue,
      stopTicks: oco.on && oco.stop.on ? (plan?.stopTicks ?? null) : null,
      targetTicks: oco.on && oco.target.on ? (plan?.targetTicks ?? null) : null,
      ...(s.ticket.sizing === 'risk' && oco.on && oco.target.on
        ? { targetMoney: legMoney(oco.target, market?.balance ?? null) }
        : {}),
      ...(s.scope ? { tileId: s.scope.tileId, layoutId: s.scope.layoutId } : {}),
    },
  };
}

export function continuing(
  p: Placement | null,
  accountId: string | null,
  ids: ReadonlySet<string>,
  scope: PlaceTile | null = null,
): Placement | null {
  const mine = placementFor(p, accountId, ids, scope);
  return mine?.stage === 'stop' || mine?.stage === 'target' ? mine : null;
}

export function hoverTrade(
  s: DomTradeSetup,
  side: Side,
  price: number,
  q: PlaceQuote,
  position: { side: Side; qty: number; average: number } | null,
): HoverTrade {
  const kind = cellKind(s, side, price, q);
  const decimals = s.math?.decimals ?? 2;
  const at = pricedEntry(side, kind, price, q, decimals);
  const refusal = refusalWords(kind, at.error);
  const byRisk = s.ticket.sizing === 'risk';
  const oco = s.oco;
  const qty = byRisk ? 1 : s.ticket.qty;
  const market = s.math ? ocoMarket(s.math, qty, s.account) : null;
  const plan = market && oco.on ? planOco(oco, market) : null;
  const multiplier = s.math ? s.math.tickValue / s.math.tick : null;
  return {
    side,
    price: at.price,
    kind,
    qty: byRisk ? null : s.ticket.qty,
    risk: byRisk ? s.ticket.risk : null,
    refusal,
    pnl: pnlAt(position, price, multiplier),
    oco:
      plan && s.math
        ? ocoWords(oco.stop.on ? plan.stopTicks : null, oco.target.on ? plan.targetTicks : null, s.math.tickValue, qty)
        : null,
    ocoShort:
      plan && s.math
        ? ocoWords(
            oco.stop.on ? plan.stopTicks : null,
            oco.target.on ? plan.targetTicks : null,
            s.math.tickValue,
            qty,
            true,
          )
        : null,
  };
}

export function placingLine(
  p: Placement,
  price: number | null,
  q: PlaceQuote,
  brackets: readonly Bracket[],
): { hint: string; error: string | null } {
  const filled = placementHost(p, brackets)?.filled ?? false;
  const guide = price === null ? null : placeGuide(p, price, q, filled);
  return { hint: placeHint(p), error: guide?.error ?? p.error };
}

export interface MenuTrade {
  side: Side;
  price: number;
  word: string;
}

export function menuTrades(
  row: { buy: number; sell: number },
  s: DomTradeSetup,
  q: PlaceQuote,
  open: boolean,
): MenuTrade[] {
  if (s.gate.kind !== 'open' || !open) return [];
  const decimals = s.math?.decimals ?? 2;
  const px = (v: number) => formatPrice(v, decimals);
  const qty = s.ticket.sizing === 'qty' ? ` ${String(s.ticket.qty)}` : '';
  return (['buy', 'sell'] as const).flatMap((side) => {
    const price = side === 'buy' ? row.buy : row.sell;
    const kind = cellKind(s, side, price, q);
    const at = pricedEntry(side, kind, price, q, decimals);
    if (at.error) return [];
    const word = `${side === 'buy' ? 'Buy' : 'Sell'} ${kind}${qty} at ${px(at.price)}`;
    return [{ side, price, word }];
  });
}

export async function tradeClick(
  s: DomTradeSetup,
  side: Side,
  price: number,
  q: PlaceQuote,
  brackets: readonly Bracket[],
  report: (r: ActionResult) => void,
  expect?: 'entry',
): Promise<string | null> {
  const accountId = s.account?.account.id ?? null;
  const under = continuing(read(placementStore).placing, accountId, s.ids, s.scope);
  if (expect === 'entry' && under) return 'The placement changed; nothing sent';
  let start: (PlaceBase & { side: Side }) | null = null;
  if (!under) {
    const b = placeBaseFor(s);
    if ('why' in b) return b.why;
    const joinStop = b.base.mode === 'risk' ? joinStopOf(brackets, side, s.mode ?? 'per_entry') : null;
    start = { ...b.base, side, kind: cellKind(s, side, price, q), ...(joinStop !== null ? { joinStop } : {}) };
  }
  const filled = under ? (placementHost(under, brackets)?.filled ?? false) : false;
  const click = clickAt(under, start, price, q, filled);
  if (!click) return null;
  if (click.step.kind === 'error' && click.fresh) return click.step.next.error ?? 'Nothing sent';
  if (click.fresh) startPlacement(click.placement);
  await runPlaceStep(click.placement, click.step, brackets, report);
  return click.step.kind === 'error' ? (click.step.next.error ?? null) : null;
}

export async function closeTag(s: DomTradeSetup, tag: LadderTag): Promise<ActionResult | null> {
  if (s.gate.kind !== 'open' || !s.account) return null;
  if (tag.role === 'position') return flatten(s.account.account.id, s.instrument, s.symbol);
  if (tag.orders.length === 0) return null;
  const r = await cancelOrders(tag.orders);
  return r.tone === 'err' ? r : null;
}

export async function flattenHere(s: DomTradeSetup): Promise<ActionResult | null> {
  if (s.gate.kind !== 'open' || !s.account) return null;
  return flatten(s.account.account.id, s.instrument, s.symbol);
}

export function breakevenView(s: DomTradeSetup, position: Bracket | null): BreakevenView {
  return breakevenOf(position, s.math?.tick ?? 0, breakevenOffset(s.oco));
}

export async function breakevenHere(s: DomTradeSetup, position: Bracket | null): Promise<ActionResult | null> {
  if (s.gate.kind !== 'open' || !s.account || !position) return null;
  const view = breakevenView(s, position);
  if (view.why !== null) return { tone: 'info', text: view.why };
  const dp = s.math?.decimals ?? 2;
  return breakeven(s.account.account.id, position.instrument, s.symbol, breakevenOffset(s.oco), dp);
}

export async function reverseHere(s: DomTradeSetup, position: Bracket | null): Promise<ActionResult | null> {
  if (s.gate.kind !== 'open' || !s.account || !position || !s.math) return null;
  const view = reverseOf(position);
  if (view.why !== null) return { tone: 'info', text: view.why };
  const what = reverseWhat(view, s.symbol);
  const lock = limitLockWords(s.account);
  if (lock) return { tone: 'err', text: `${what}: ${lock.replace(/\.$/, '')}. Nothing sent.` };
  const bracket = reverseBracket({ account: s.account, math: s.math, oco: s.oco }, view);
  const env = s.account.account.environment;
  return reverse(env, s.account.account.id, position.instrument, bracket, what, s.math.decimals);
}

export function domTicketSend(
  s: DomTradeSetup,
  quote: PlaceQuote | undefined,
  brackets: readonly Bracket[],
  stopLimitTicks: number,
): TicketSend | { why: string } {
  if (s.gate.kind === 'none' || !s.account) return { why: 'Choose an account' };
  if (s.gate.kind !== 'open') return { why: s.gate.why };
  if (!s.math || !s.instrument) return { why: 'No contract details yet' };
  return {
    account: s.account,
    instrument: s.instrument,
    symbol: s.symbol,
    math: s.math,
    setup: { qty: s.ticket.qty, sizing: s.ticket.sizing, risk: s.ticket.risk, stopLimitTicks },
    oco: s.oco,
    quote,
    brackets,
    mode: s.mode ?? 'per_entry',
    tile: s.scope,
  };
}

export async function cancelAllHere(s: DomTradeSetup): Promise<ActionResult | null> {
  if (s.gate.kind !== 'open' || !s.account) return null;
  return cancelAll(s.account.account.id, s.instrument, s.symbol);
}

export async function moveTag(
  s: DomTradeSetup,
  tag: LadderTag,
  fromPrice: number,
  toPrice: number,
): Promise<ActionResult | null> {
  const env = environmentOf(s);
  if (s.gate.kind !== 'open' || !env || !s.math || tag.orders.length === 0) return null;
  const delta = toPrice - fromPrice;
  if (delta === 0) return null;
  for (const o of tag.orders) {
    const from = restingPrice(o.request);
    if (from === null) continue;
    const r = await modifyOrderPrice(env, o, toTick(from + delta, s.math.tick));
    if (r.tone !== 'ok') return r;
  }
  return null;
}

export async function spawnFromPosition(
  s: DomTradeSetup,
  position: Bracket,
  toPrice: number,
  last: number | null,
): Promise<ActionResult | null> {
  const env = environmentOf(s);
  if (s.gate.kind !== 'open' || !s.account || !env || !s.math) return null;
  const plan = spawnPlan(position, position.price, toPrice);
  if (!plan) return null;
  const decimals = s.math.decimals;
  if (plan.move) {
    const delta = toPrice - plan.move.from;
    for (const o of plan.move.orders) {
      const from = restingPrice(o.request);
      if (from === null) continue;
      const r = await modifyOrderPrice(env, o, toTick(from + delta, s.math.tick));
      if (r.tone !== 'ok') return r;
    }
    return null;
  }
  const host = legHostOf(position, s.account.account.id);
  if (!host) return null;
  const err = legError(host.side, plan.role, toPrice, hostReference(host, position.price, last), decimals);
  if (err) return { tone: 'err', text: `${err}. Nothing sent.` };
  const what = `${plan.role === 'stop' ? 'Stop' : 'Target'} ${formatPrice(toPrice, decimals)} on ${s.symbol}`;
  const r = await attachLeg(env, host, plan.role, toPrice, what, decimals);
  return r.tone === 'ok' ? null : r;
}
