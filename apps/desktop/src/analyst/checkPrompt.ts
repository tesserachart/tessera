import { formatPrice, formatMoney } from '@tessera/ui';
import { placementLimit, type Placement } from '../chart/placement.ts';
import { KIND_WORD } from '../shell/ticket.ts';

export function placementCheck(p: Placement): string {
  const side = p.side === 'buy' ? 'Buy' : 'Sell';
  const dir = p.side === 'buy' ? 1 : -1;
  const px = (v: number) => formatPrice(v, p.decimals);
  const size = p.mode === 'risk' ? '' : `${String(p.qty)} `;
  const limit = placementLimit(p);
  const priced =
    p.entry !== null && p.kind !== 'market' ? ` ${px(p.entry)}${limit !== null ? ` limit ${px(limit)}` : ''}` : '';
  const head = `${side} ${size}${p.symbol} ${KIND_WORD[p.kind]}${priced}`;
  const parts = [head];
  const ref = limit ?? p.entry;
  const stop =
    p.stop ?? (ref !== null && p.stopTicks !== null && p.mode !== 'risk' ? ref - dir * p.stopTicks * p.tick : null);
  if (stop !== null) parts.push(`stop ${px(stop)}`);
  else if (p.stopTicks !== null && p.mode !== 'risk') parts.push(`stop ${String(p.stopTicks)} t`);
  if (p.targetTicks !== null) {
    parts.push(ref !== null ? `target ${px(ref + dir * p.targetTicks * p.tick)}` : `target ${String(p.targetTicks)} t`);
  }
  if (p.mode === 'risk') parts.push(`risk ${formatMoney(p.risk)}`);
  else if (ref !== null && stop !== null && p.tick > 0) {
    parts.push(`risk ${formatMoney((Math.abs(ref - stop) / p.tick) * p.tickValue * p.qty)}`);
  } else if (p.stopTicks !== null) parts.push(`risk ${formatMoney(p.stopTicks * p.tickValue * p.qty)}`);
  return `Check: ${parts.join(', ')}`;
}

export function ticketCheck(t: {
  qty: number;
  symbol: string;
  entry?: string;
  sizing: 'qty' | 'risk';
  risk: number;
}): string {
  const size = t.sizing === 'risk' ? `risk ${formatMoney(t.risk)} on` : String(t.qty);
  return `Check: ${size} ${t.symbol}${t.entry ? ` ${t.entry}` : ''}`;
}
