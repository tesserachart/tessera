import type { Order } from '@tessera/protocol';
import { formatPrice } from '@tessera/ui';
import { joinsBracket, legsMoney, type Bracket, type BracketMode, type ChartMath, type Leg } from '../brackets.ts';

export interface TradeRow {
  key: string;
  instrument: string;
  kind: 'position' | 'order' | 'leg';
  of: 'position' | 'order' | null;
  words: string;
  money: number | null;
  role: 'stop' | 'target' | null;
  held: boolean;
  cancels: Order[];
  joins?: boolean;
}

const SIDE: Record<'buy' | 'sell', string> = { buy: 'Buy', sell: 'Sell' };

function legRows(b: Bracket, m: ChartMath): TradeRow[] {
  const legs: [Leg, 'stop' | 'target'][] = [
    ...b.stops.map((l) => [l, 'stop'] as [Leg, 'stop']),
    ...b.targets.map((l) => [l, 'target'] as [Leg, 'target']),
  ];
  return legs.map(([l, role], i) => {
    const word = role === 'stop' ? 'Stop' : 'Target';
    const px = formatPrice(l.price, m.decimals);
    return {
      key: `${b.id}:${role}:${l.order?.id ?? String(i)}`,
      instrument: b.instrument,
      kind: 'leg',
      of: b.kind === 'position' ? 'position' : 'order',
      words: l.qty === b.qty ? `${word} ${px}` : `${word} ${String(l.qty)} @ ${px}`,
      money: legsMoney(b, [l], m),
      role,
      held: l.held,
      cancels: l.order && !l.held ? [l.order] : [],
    };
  });
}

export function tradeRows(
  brackets: readonly Bracket[],
  m: ChartMath,
  opts: { position?: boolean; mode?: BracketMode } = {},
): TradeRow[] {
  const out: TradeRow[] = [];
  for (const b of brackets) {
    if (b.kind === 'draft') continue;
    if (b.kind === 'position') {
      if (opts.position === false) {
        out.push(...legRows(b, m));
        continue;
      }
      out.push({
        key: b.id,
        instrument: b.instrument,
        kind: 'position',
        of: null,
        words: `${b.side === 'buy' ? 'Long' : 'Short'} ${String(b.qty)} @ ${formatPrice(b.price, Math.max(m.decimals, 2))}`,
        money: b.pnl,
        role: null,
        held: false,
        cancels: [],
      });
    } else {
      const type = b.type ? ` ${b.type}` : '';
      out.push({
        key: b.id,
        instrument: b.instrument,
        kind: 'order',
        of: null,
        words: `${SIDE[b.side]}${type} ${String(b.qty)} @ ${formatPrice(b.price, m.decimals)}`,
        money: null,
        role: null,
        held: false,
        cancels: b.entry ? [b.entry] : [],
        ...(joinsBracket(b, brackets, opts.mode ?? 'per_entry') ? { joins: true } : {}),
      });
    }
    out.push(...legRows(b, m));
  }
  return out;
}

export function workingCount(rows: readonly TradeRow[]): number {
  return rows.reduce((n, r) => n + (r.cancels.length > 0 ? 1 : 0), 0);
}

export interface PositionReadout {
  words: string;
  qty: number;
  pnl: number | null;
  instrument: string | null;
}

export function positionReadout(brackets: readonly Bracket[], m: ChartMath): PositionReadout {
  const b = brackets.find((x) => x.kind === 'position');
  if (!b || b.qty === 0) return { words: 'Flat', qty: 0, pnl: null, instrument: null };
  const qty = b.side === 'buy' ? b.qty : -b.qty;
  const sign = qty > 0 ? '+' : '−';
  return {
    words: `${sign}${String(Math.abs(qty))} @ ${formatPrice(b.price, Math.max(m.decimals, 2))}`,
    qty,
    pnl: b.pnl,
    instrument: b.instrument,
  };
}

export interface CancelSelection {
  orders: Order[];
  kept: number;
}

export function cancelSelection(rows: readonly TradeRow[]): CancelSelection {
  const orders: Order[] = [];
  let kept = 0;
  for (const r of rows) {
    if (r.cancels.length === 0) continue;
    if (r.of === 'position') kept += 1;
    else orders.push(...r.cancels);
  }
  return { orders, kept };
}
