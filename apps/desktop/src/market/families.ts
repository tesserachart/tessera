import type { ContractSpec } from '@tessera/protocol';

export interface ContractFamily {
  full: string;
  micro: string;
}

export const FAMILIES: readonly ContractFamily[] = [
  { full: 'NQ', micro: 'MNQ' },
  { full: 'ES', micro: 'MES' },
  { full: 'YM', micro: 'MYM' },
  { full: 'RTY', micro: 'M2K' },
  { full: 'CL', micro: 'MCL' },
  { full: 'GC', micro: 'MGC' },
];

export type ExecuteAs = 'chart' | 'full' | 'micro';

export function readExecuteAs(v: unknown): ExecuteAs {
  return v === 'full' || v === 'micro' ? v : 'chart';
}

export type FamilyOf = ContractFamily & { root: string };

export function familyOf(spec: Pick<ContractSpec, 'root' | 'microOf'> | null | undefined): FamilyOf | null {
  const root = spec?.root ?? null;
  if (!root) return null;
  const f = FAMILIES.find((x) => x.full === root || x.micro === root);
  if (!f) return null;
  const of = spec?.microOf ?? null;
  if (of !== null && !(f.micro === root && f.full === of)) return null;
  return { ...f, root };
}

export function siblingOf(f: FamilyOf): { as: 'full' | 'micro'; root: string } {
  return f.root === f.full ? { as: 'micro', root: f.micro } : { as: 'full', root: f.full };
}

export function rootFor(as: ExecuteAs, f: FamilyOf | null): string | null {
  if (as === 'chart' || !f) return null;
  const root = as === 'full' ? f.full : f.micro;
  return root === f.root ? null : root;
}

export function mirrors(
  a: Pick<ContractSpec, 'tickSize' | 'priceDecimals' | 'expiry'>,
  b: Pick<ContractSpec, 'tickSize' | 'priceDecimals' | 'expiry'>,
): boolean {
  if (Math.abs(a.tickSize - b.tickSize) > 1e-12 || a.priceDecimals !== b.priceDecimals) return false;
  return a.expiry === null || b.expiry === null || a.expiry === b.expiry;
}
