import type { AccountUpdate, OrderInput, Side } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { limitLockWords } from '../accounts/limits.ts';
import { orderInput } from '../shell/ticket.ts';
import type { ChartMath } from './brackets.ts';
import { pricedEntry, type PlaceQuote } from './placement.ts';

export interface MenuTrade {
  word: string;
  reason: string | null;
  hint: string | null;
  input: OrderInput | null;
}

export function menuTrade(o: {
  side: Side;
  kind: 'limit' | 'stop';
  price: number;
  quote: PlaceQuote;
  account: AccountUpdate | null;
  ticket: { sizing: 'qty' | 'risk'; qty: number };
  math: ChartMath;
  instrument: string;
}): MenuTrade | null {
  const { side, kind, account, math, quote } = o;
  const at = pricedEntry(side, kind, o.price, quote, math.decimals);
  if (at.error) return null;
  const price = at.price;
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  const where = at.note
    ? `@ ${side === 'buy' ? 'ask' : 'bid'} ${formatPrice(price, math.decimals)}`
    : `@ ${formatPrice(price, math.decimals)}`;
  const qty = account && o.ticket.sizing === 'qty' ? o.ticket.qty : null;
  const word = qty !== null ? `${verb} ${kind} ${String(qty)} ${where}` : `${verb} ${kind} ${where}`;
  const no = (reason: string): MenuTrade => ({ word, reason, hint: null, input: null });
  if (!account) return no('No trading account');
  const lock = limitLockWords(account);
  if (lock) return no(lock);
  if (quote.last === null && quote.bid === null && quote.ask === null) return no('No price yet');
  if (qty === null) return no('Sizing by risk needs a stop; the menu places a plain order');
  return {
    word,
    reason: null,
    hint: 'no bracket',
    input: orderInput({
      accountId: account.account.id,
      instrument: o.instrument,
      side,
      kind,
      price,
      qty,
      bracket: null,
    }),
  };
}
