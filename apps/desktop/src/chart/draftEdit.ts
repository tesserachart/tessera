import type { JsonValue } from '@tessera/protocol';

export type DraftPart = 'entry' | 'stop' | 'target';

const isObject = (v: JsonValue | undefined): v is { [key: string]: JsonValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function draftEditInput(input: JsonValue, part: DraftPart, price: number): JsonValue | null {
  if (!isObject(input) || !Number.isFinite(price)) return null;
  const next = structuredClone(input);
  if (part === 'entry') {
    const type = next.orderType;
    const limit = typeof next.limitPrice === 'number' ? next.limitPrice : null;
    const stop = typeof next.stopPrice === 'number' ? next.stopPrice : null;
    if (type === 'limit' && limit !== null) next.limitPrice = price;
    else if (type === 'stop' && stop !== null) next.stopPrice = price;
    else if (type === 'stop_limit' && stop !== null && limit !== null) {
      next.limitPrice = Number((limit + (price - stop)).toFixed(10));
      next.stopPrice = price;
    } else return null;
    return next;
  }
  const bracket = next.bracket;
  if (!isObject(bracket)) return null;
  const key = part === 'stop' ? 'stopLoss' : 'takeProfit';
  const ticks = part === 'stop' ? 'stopTicks' : 'targetTicks';
  if (typeof bracket[key] !== 'number' && typeof bracket[ticks] !== 'number') return null;
  const { [ticks]: _distance, ...kept } = bracket;
  next.bracket = { ...kept, [key]: price };
  return next;
}

export function draftEditWords(part: DraftPart, price: string): string {
  return `${part === 'entry' ? 'Entry' : part === 'stop' ? 'Stop' : 'Target'} ${price}: draft edited, review it on its card`;
}
