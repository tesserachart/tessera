import type { AccountSummary, AccountUpdate, Position, PositionUpdate, TradingAccount } from '@tessera/protocol';
import { derived, perFrame, useStore, type Readable } from './store.ts';
import { topicFold } from './topics.ts';

export function reduceAccounts(
  prev: ReadonlyMap<string, AccountSummary>,
  ev: AccountUpdate,
): Map<string, AccountSummary> {
  const next = new Map(prev);
  next.set(ev.summary.accountId, ev.summary);
  return next;
}

export function reducePositions(prev: ReadonlyMap<string, Position>, ev: PositionUpdate): Map<string, Position> {
  const next = new Map(prev);
  const key = `${ev.position.accountId}|${ev.position.instrument}`;
  if (ev.position.qty === 0) next.delete(key);
  else next.set(key, ev.position);
  return next;
}

function reduceAccountUpdates(prev: ReadonlyMap<string, AccountUpdate>, ev: AccountUpdate): Map<string, AccountUpdate> {
  const next = new Map(prev);
  next.set(ev.summary.accountId, ev);
  return next;
}

export const accountUpdatesStore: Readable<AccountUpdate[] | null> = derived(
  perFrame(topicFold('accounts', {}, { empty: () => new Map<string, AccountUpdate>(), reduce: reduceAccountUpdates })),
  (map) => (map ? [...map.values()] : null),
);

export function useAccountUpdates(): AccountUpdate[] | null {
  return useStore(accountUpdatesStore);
}

function sameList<U>(a: readonly U[], b: readonly U[], same: (x: U, y: U) => boolean): boolean {
  return a.length === b.length && a.every((x, i) => same(x, b[i]!));
}

function steady<T, U>(pick: (item: T) => U, same: (a: U, b: U) => boolean): (items: readonly T[] | null) => U[] | null {
  let last: U[] | null = null;
  return (items) => {
    const next = items?.map(pick) ?? null;
    if (next === null || last === null || !sameList(next, last, same)) last = next;
    return last;
  };
}

const sameAccount = (a: TradingAccount, b: TradingAccount) => JSON.stringify(a) === JSON.stringify(b);

export const accountListStore: Readable<TradingAccount[] | null> = derived(
  accountUpdatesStore,
  steady((u: AccountUpdate) => u.account, sameAccount),
);

export function useAccountList(): TradingAccount[] | null {
  return useStore(accountListStore);
}

export const positionsStore: Readable<Position[] | null> = derived(
  perFrame(topicFold('positions', {}, { empty: () => new Map<string, Position>(), reduce: reducePositions })),
  (map) =>
    map
      ? [...map.values()].sort(
          (a, b) => a.accountId.localeCompare(b.accountId) || a.instrument.localeCompare(b.instrument),
        )
      : null,
);

export function usePositions(): Position[] | null {
  return useStore(positionsStore);
}

export type Holding = Pick<Position, 'accountId' | 'instrument' | 'qty' | 'avgPrice'>;

const sameHolding = (a: Holding, b: Holding) =>
  a.accountId === b.accountId && a.instrument === b.instrument && a.qty === b.qty && a.avgPrice === b.avgPrice;

const holdingsStore: Readable<Holding[] | null> = derived(
  positionsStore,
  steady(
    ({ accountId, instrument, qty, avgPrice }: Position): Holding => ({ accountId, instrument, qty, avgPrice }),
    sameHolding,
  ),
);

export function useHoldings(): Holding[] | null {
  return useStore(holdingsStore);
}
