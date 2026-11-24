import type { ContractSpec } from '@tessera/protocol';
import { formatMoney, formatPrice } from '@tessera/ui';
import { zonedFormat } from '../state/timeZone.ts';

const INSTANT = zonedFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function tickWords(spec: Pick<ContractSpec, 'tickSize' | 'tickValue' | 'priceDecimals'>): string {
  return `${formatPrice(spec.tickSize, spec.priceDecimals)} = ${formatMoney(spec.tickValue.amount, {
    currency: spec.tickValue.currency,
  })}`;
}

export function pointWords(spec: Pick<ContractSpec, 'multiplier' | 'currency'>): string {
  return `${formatMoney(spec.multiplier, { currency: spec.currency })} a point`;
}

export function instantWords(ns: number | null | undefined): string | null {
  if (ns === null || ns === undefined) return null;
  return INSTANT().format(new Date(ns / 1e6));
}

export function dayWords(day: string | null | undefined): string | null {
  if (!day) return null;
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}
