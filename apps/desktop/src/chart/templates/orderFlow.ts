import type { ChartLayer } from '@tessera/protocol';
import { addIndicator, isIndicatorKind } from '../indicators.ts';

export const ORDER_FLOW_TEMPLATE = 'Order flow';

export const ORDER_FLOW_KINDS: readonly string[] = ['footprint', 'volume_profile', 'big_trades', 'delta'];

export function withOrderFlow(layers: readonly ChartLayer[]): ChartLayer[] {
  let next: ChartLayer[] = layers.filter((l) => !isIndicatorKind(l.kind));
  for (const kind of ORDER_FLOW_KINDS) next = addIndicator(next, kind).layers;
  return next;
}

export function isOrderFlow(layers: readonly ChartLayer[]): boolean {
  const kinds = layers.filter((l) => isIndicatorKind(l.kind)).map((l) => l.kind);
  return kinds.length === ORDER_FLOW_KINDS.length && ORDER_FLOW_KINDS.every((k) => kinds.includes(k));
}
