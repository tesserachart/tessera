import type { OrderLineSpec } from '@tessera/chart';
import type { DraftInfo, Order, OrderRequest, Position } from '@tessera/protocol';
import { formatMoney, formatPrice } from '@tessera/ui';
import { orderPreviewOf } from '../app/orders.ts';
import { draftLeg } from '../shell/oco.ts';

const SIDE = { buy: 'Buy', sell: 'Sell' } as const;
const STATUS: Partial<Record<Order['status'], string>> = {
  pending_submit: 'sending',
  held: 'on fill',
  working: 'working',
  partially_filled: 'partly filled',
  pending_cancel: 'cancelling',
};

function restingPrice(r: OrderRequest): number | null {
  if (r.orderType === 'stop' || r.orderType === 'stop_limit') return r.stopPrice;
  if (r.orderType === 'limit') return r.limitPrice;
  return null;
}

function typeWord(r: OrderRequest): string {
  return r.orderType === 'stop_limit' ? 'stop limit' : r.orderType;
}

export function orderLines(
  orders: readonly Order[],
  drafts: readonly DraftInfo[],
  ids: ReadonlySet<string>,
  precision: number,
  multiplier: number | null = null,
  positions: readonly Position[] = [],
): OrderLineSpec[] {
  const px = (p: number) => formatPrice(p, precision);
  const lines: OrderLineSpec[] = [];
  const position = positions.find((p) => ids.has(p.instrument) && p.qty !== 0) ?? null;
  if (position) {
    const pnl = position.unrealizedPnl;
    lines.push({
      id: `position:${position.accountId}|${position.instrument}`,
      price: position.avgPrice,
      side: position.qty > 0 ? 'buy' : 'sell',
      qty: Math.abs(position.qty),
      role: 'position',
      label: `${position.qty > 0 ? 'Long' : 'Short'} ${px(position.avgPrice)}`,
      note: pnl ? formatMoney(pnl, { signed: true }) : null,
      draft: false,
    });
  }
  for (const o of orders) {
    const r = o.request;
    const price = restingPrice(r);
    if (!ids.has(r.instrument) || price === null) continue;
    const qty = o.status === 'partially_filled' ? r.qty - o.filledQty : r.qty;
    const exit = o.role === 'stop_loss' ? 'stop' : o.role === 'take_profit' ? 'target' : null;
    const worth =
      exit && position && multiplier !== null
        ? formatMoney((price - position.avgPrice) * position.qty * multiplier, { signed: true })
        : null;
    lines.push({
      id: `order:${o.id}`,
      price,
      side: r.side,
      qty,
      ...(exit ? { role: exit } : {}),
      ...(o.status === 'held' ? { pending: true } : {}),
      label: exit
        ? `${exit === 'stop' ? 'Stop' : 'Target'} ${px(price)}`
        : `${SIDE[r.side]} ${typeWord(r)} ${px(price)}`,
      note: o.status === 'working' && worth ? worth : (STATUS[o.status] ?? null),
      draft: false,
    });
  }
  for (const d of drafts) {
    const preview = orderPreviewOf(d);
    if (!preview) continue;
    const r = preview.request;
    if (!ids.has(r.instrument)) continue;
    const resting = restingPrice(r);
    const price = resting ?? preview.estPrice ?? preview.referencePrice;
    if (price !== null) {
      lines.push({
        id: `draft:${d.draftId}`,
        price,
        side: r.side,
        qty: r.qty,
        role: 'entry',
        label: resting === null ? `${SIDE[r.side]} market` : `${SIDE[r.side]} ${typeWord(r)} ${px(price)}`,
        note: 'draft',
        draft: true,
      });
    }
    const exit = r.side === 'buy' ? 'sell' : 'buy';
    const dir = r.side === 'buy' ? 1 : -1;
    const amount = (leg: number): number | null =>
      price !== null && multiplier !== null ? (leg - price) * dir * r.qty * multiplier : null;
    const signed = (v: number | null) => (v === null ? 'on fill' : formatMoney(v, { signed: true }));
    const stopLoss = price !== null ? draftLeg(r, 'stop', price) : null;
    const takeProfit = price !== null ? draftLeg(r, 'target', price) : null;
    if (stopLoss !== null) {
      const risk = preview.riskToStop ? -Math.abs(preview.riskToStop.amount) : amount(stopLoss);
      lines.push({
        id: `draft:${d.draftId}:stop`,
        price: stopLoss,
        side: exit,
        qty: r.qty,
        role: 'stop',
        label: `Stop ${px(stopLoss)}`,
        note: signed(risk),
        draft: true,
      });
    }
    if (takeProfit !== null) {
      lines.push({
        id: `draft:${d.draftId}:target`,
        price: takeProfit,
        side: exit,
        qty: r.qty,
        role: 'target',
        label: `Target ${px(takeProfit)}`,
        note: signed(amount(takeProfit)),
        draft: true,
      });
    }
  }
  return lines;
}
