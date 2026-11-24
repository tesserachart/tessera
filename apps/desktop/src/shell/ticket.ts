import type { Bracket, Environment, InvokeSurface, OrderInput, Quote, Side } from '@tessera/protocol';
import { groupOn, copyStore } from '../accounts/copy.ts';
import { read } from '../app/store.ts';

export type EntryKind = 'market' | 'limit' | 'stop' | 'stop_limit';

export const KIND_WORD: Record<EntryKind, string> = {
  market: 'market',
  limit: 'limit',
  stop: 'stop',
  stop_limit: 'stop limit',
};

export const STOP_LIMIT_TICKS = 2;

export function toTick(price: number, tick: number): number {
  if (!(tick > 0)) return price;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)) + 2);
  return Number((Math.round(price / tick) * tick).toFixed(decimals));
}

export function marketReference(side: Side, q: Pick<Quote, 'bid' | 'ask' | 'last'> | undefined): number | null {
  const touch = side === 'buy' ? q?.ask : q?.bid;
  return touch ?? q?.last ?? null;
}

export function stopLimitPrice(side: Side, stop: number, ticks: number, tick: number): number {
  const away = Math.max(0, Math.round(ticks)) * tick;
  return toTick(side === 'buy' ? stop + away : stop - away, tick);
}

export function orderInput(o: {
  accountId: string;
  instrument: string;
  side: Side;
  kind: EntryKind;
  price: number | null;
  limit?: number | null;
  qty: number;
  bracket: Bracket | null;
  reduceOnly?: boolean;
}): OrderInput {
  const bracket = o.reduceOnly ? null : o.bracket;
  const limit = o.kind === 'limit' ? o.price : o.kind === 'stop_limit' ? (o.limit ?? null) : null;
  const stop = o.kind === 'stop' || o.kind === 'stop_limit' ? o.price : null;
  return {
    accountId: o.accountId,
    instrument: o.instrument,
    side: o.side,
    qty: o.qty,
    orderType: o.kind,
    ...(limit !== null ? { limitPrice: limit } : {}),
    ...(stop !== null ? { stopPrice: stop } : {}),
    tif: 'day',
    ...(bracket ? { bracket } : {}),
    ...(o.reduceOnly ? { reduceOnly: true } : {}),
  };
}

export function sendSurface(env: Environment, accountId?: string): InvokeSurface {
  const leads = accountId !== undefined && groupOn(read(copyStore).groups, accountId) !== null;
  return { armed: true, holdConfirmed: env !== 'paper' || leads };
}

export function positionWord(qty: number): string {
  if (qty === 0) return 'Flat';
  return `${qty > 0 ? 'Long' : 'Short'} ${String(Math.abs(qty))}`;
}

export function parsePrice(text: string, tick: number): number | null {
  const v = Number(text.replace(/,/g, '').trim());
  if (!text.trim() || !Number.isFinite(v) || v <= 0) return null;
  return toTick(v, tick);
}

export type GridOrder = 'market' | 'touch' | 'limit' | 'stop' | 'stop_limit';

export const GRID_ORDERS: readonly GridOrder[] = ['market', 'touch', 'limit', 'stop', 'stop_limit'];

export function gridKind(o: GridOrder): EntryKind {
  return o === 'touch' ? 'limit' : o;
}

export const MARKET_WAITS = 'Market orders wait for live prices; Flat, closes and Reverse still go';

export function opensContracts(side: Side, qty: number, held: number): boolean {
  return qty > (side === 'buy' ? Math.max(0, -held) : Math.max(0, held));
}

export function gridPress(o: GridOrder, risking: boolean): 'send' | 'arm' {
  return (o === 'market' || o === 'touch') && !risking ? 'send' : 'arm';
}

export function gridWord(side: Side, o: GridOrder): string {
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  if (o === 'touch') return `${verb} ${side === 'buy' ? 'bid' : 'ask'}`;
  return `${verb} ${KIND_WORD[o]}`;
}

export interface GridTipContext {
  size: { qty: number } | { risk: string };
  touch: string | null;
  limitTicks: number;
  bracket: boolean;
  why: string | null;
}

export function gridTip(side: Side, o: GridOrder, c: GridTipContext): string {
  if (c.why) return c.why;
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  const touchWord = side === 'buy' ? 'bid' : 'ask';
  const through = side === 'buy' ? 'ask' : 'bid';
  const risk = 'risk' in c.size ? c.size.risk : null;
  const qty = 'qty' in c.size ? ` ${String(c.size.qty)}` : '';
  const withBracket = c.bracket ? ', with its bracket' : '';
  const sized = risk !== null ? `; then click its stop: ${risk} at risk sizes it` : '';
  switch (o) {
    case 'market':
      return risk !== null
        ? `${verb} at market: click its stop on the chart; ${risk} at risk sizes it and sends it`
        : `${verb}${qty} at market now${withBracket}`;
    case 'touch':
      if (c.touch === null) return `${verb} at the ${touchWord}: no price yet`;
      return risk !== null
        ? `${verb} at the ${touchWord}, a limit at ${c.touch}: click its stop on the chart; ${risk} at risk sizes it`
        : `${verb}${qty} at the ${touchWord}, a limit at ${c.touch} sent now${withBracket}`;
    case 'limit':
      return `${verb} limit${qty}: click its price on the chart; through the ${through} it goes in at the ${through}${sized}`;
    case 'stop':
      return `${verb} stop${qty}: click its price on the chart, ${side === 'buy' ? 'above the ask' : 'below the bid'}${sized}`;
    case 'stop_limit': {
      const n = Math.max(0, Math.round(c.limitTicks));
      const limit =
        n === 0
          ? 'its limit at the stop'
          : `its limit ${String(n)} ${n === 1 ? 'tick' : 'ticks'} ${side === 'buy' ? 'above' : 'below'} it`;
      return `${verb} stop limit${qty}: click its stop on the chart, ${side === 'buy' ? 'above the ask' : 'below the bid'}; ${limit}${sized}`;
    }
  }
}
