import type { AccountUpdate, Bracket as OrderBracket, OrderInput, ReverseOutput, Side } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { limitLockWords } from '../../accounts/limits.ts';
import {
  bracketSideErrors,
  entryBracket,
  expectedFill,
  legMoney,
  ocoBracket,
  planOco,
  planOk,
  type ContractMath,
  type OcoConfig,
} from '../../shell/oco.ts';
import { gridKind, marketReference, orderInput, type GridOrder } from '../../shell/ticket.ts';
import { ocoMarket } from '../../shell/tradeContext.ts';
import type { TicketSetup } from '../../state/tickets.ts';
import { joinStopOf, type Bracket, type BracketMode } from '../brackets.ts';
import { ticketPlaceBase, type PlaceBase, type PlaceQuote, type PlaceTile } from '../placement.ts';

export interface TicketSend {
  account: AccountUpdate;
  instrument: string;
  symbol: string;
  math: ContractMath;
  setup: Pick<TicketSetup, 'qty' | 'sizing' | 'risk' | 'stopLimitTicks'>;
  oco: OcoConfig;
  quote: PlaceQuote | undefined;
  brackets: readonly Bracket[];
  mode: BracketMode;
  tile: PlaceTile | null;
}

const SIDE_WORD: Record<Side, string> = { buy: 'Buy', sell: 'Sell' };

export function touchOf(quote: PlaceQuote | undefined, side: Side): number | null {
  return (side === 'buy' ? quote?.bid : quote?.ask) ?? null;
}

function measured(t: Pick<TicketSend, 'setup'>): number {
  return t.setup.sizing === 'risk' ? 1 : t.setup.qty;
}

export function entryBlock(t: TicketSend, side: Side, o: GridOrder): string | null {
  const lock = limitLockWords(t.account);
  if (lock) return lock;
  const market = ocoMarket(t.math, measured(t), t.account);
  const plan = market ? planOco(t.oco, market) : null;
  if (plan && t.oco.on && !planOk(plan)) return 'Fix the bracket first';
  if (o === 'touch') return touchOf(t.quote, side) === null ? noTouch(t, side) : null;
  const priced = (t.quote?.last ?? t.quote?.bid ?? t.quote?.ask ?? null) !== null;
  return priced ? null : `No price for ${t.symbol} yet`;
}

function noTouch(t: Pick<TicketSend, 'symbol'>, side: Side): string {
  return `No ${side === 'buy' ? 'bid' : 'ask'} for ${t.symbol} yet`;
}

export function quickOrder(
  t: TicketSend,
  side: Side,
  o: 'market' | 'touch',
): { input: OrderInput; what: string } | { error: string } {
  const qty = measured(t);
  const dp = t.math.decimals;
  const price = o === 'touch' ? touchOf(t.quote, side) : null;
  if (o === 'touch' && price === null) return { error: `${noTouch(t, side)}. Nothing sent.` };
  const kind = o === 'touch' ? 'limit' : 'market';
  const touch = marketReference(side, t.quote);
  const fill = expectedFill(side, kind, price, touch);
  const market = ocoMarket(t.math, qty, t.account);
  const bracket = market ? entryBracket(side, kind, price, touch, t.oco, market) : null;
  const what =
    o === 'touch'
      ? `${SIDE_WORD[side]} ${String(qty)} ${t.symbol} limit ${formatPrice(price, dp)}`
      : `${SIDE_WORD[side]} ${String(qty)} ${t.symbol} at market`;
  const errs = bracketSideErrors(side, fill, bracket, dp);
  if (errs.length) return { error: `${what}: ${errs[0]!}. Nothing sent.` };
  const input = orderInput({
    accountId: t.account.account.id,
    instrument: t.instrument,
    side,
    kind,
    price,
    qty,
    bracket,
  });
  return { input, what };
}

export function armBase(t: TicketSend, side: Side, o: GridOrder): PlaceBase {
  const risking = t.setup.sizing === 'risk';
  const market = ocoMarket(t.math, measured(t), t.account);
  const plan = market ? planOco(t.oco, market) : null;
  const { oco } = t;
  const base = ticketPlaceBase({
    accountId: t.account.account.id,
    environment: t.account.account.environment,
    contract: { instrument: t.instrument, symbol: t.symbol, math: t.math },
    side,
    kind: gridKind(o),
    ticket: t.setup,
    stopTicks: oco.on && oco.stop.on ? (plan?.stopTicks ?? null) : null,
    targetTicks: oco.on && oco.target.on ? (plan?.targetTicks ?? null) : null,
    targetMoney: risking && oco.on && oco.target.on ? legMoney(oco.target, market?.balance ?? null) : null,
    limitTicks: t.setup.stopLimitTicks,
    joinStop: risking ? joinStopOf(t.brackets, side, t.mode) : null,
    tile: t.tile ?? { layoutId: '', tileId: '' },
  });
  if (t.tile) return base;
  const { tileId: _tile, layoutId: _layout, ...free } = base;
  return free;
}

export function ticketSendOf(
  o: Omit<TicketSend, 'account' | 'instrument' | 'math'> & {
    account: AccountUpdate | null;
    instrument: string | null;
    math: ContractMath | null;
    why: string | null;
  },
): TicketSend | { why: string } {
  const { account, instrument, math, why, ...rest } = o;
  if (!account) return { why: 'Connect an account to trade' };
  if (why) return { why };
  if (!instrument || !math) return { why: 'No contract details yet' };
  return { ...rest, account, instrument, math };
}

export interface ReverseView {
  why: string | null;
  side: Side;
  qty: number;
}

export function reverseOf(position: Bracket | null): ReverseView {
  if (position?.kind !== 'position' || position.qty === 0) return { why: 'No position', side: 'buy', qty: 0 };
  return { why: null, side: position.side === 'buy' ? 'sell' : 'buy', qty: position.qty };
}

function sideWords(side: Side, qty: number): string {
  return `${side === 'buy' ? 'long' : 'short'} ${String(qty)}`;
}

export function reverseBracket(t: Pick<TicketSend, 'account' | 'math' | 'oco'>, v: ReverseView): OrderBracket | null {
  const market = ocoMarket(t.math, v.qty, t.account);
  return market ? ocoBracket(v.side, 'fill', t.oco, market) : null;
}

export function reverseWhat(v: ReverseView, symbol: string): string {
  const was: Side = v.side === 'buy' ? 'sell' : 'buy';
  return `Reverse the ${sideWords(was, v.qty)} ${symbol}`;
}

export function reverseTip(v: ReverseView, symbol: string, bracket: boolean): string {
  if (v.why !== null) return v.why;
  return `${reverseWhat(v, symbol)} to ${sideWords(v.side, v.qty)} at market${bracket ? ', with the bracket' : ''}`;
}

export function reverseDone(out: ReverseOutput, dp: number): string {
  const at = out.entry.avgFillPrice;
  return `${sideWords(out.side, out.qty)}${at !== null ? ` at ${formatPrice(at, dp)}` : ''}`;
}
