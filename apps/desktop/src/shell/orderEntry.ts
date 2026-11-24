import type { ConnectionInfo, OrderType, TradingAccount } from '@tessera/protocol';
import { connectionStore } from '../app/connection.ts';
import { useStore } from '../app/store.ts';
import { useHasTool, useToolValue } from '../app/tools.ts';

export type OrderEntry = { open: true } | { open: false; why: string; canTurnOn?: boolean };

export type EntryAccount = Pick<TradingAccount, 'id' | 'connectionId' | 'environment'>;

const OPEN: OrderEntry = { open: true };

function systemOf(c: ConnectionInfo): string {
  const first = c.displayName.split(' · ')[0]?.trim();
  return first === undefined || first === '' ? c.displayName : first;
}

export function orderEntryOf(
  account: EntryAccount | null,
  connections: readonly ConnectionInfo[] | null | undefined,
): OrderEntry {
  const broker = account ? connections?.find((c) => c.id === account.connectionId) : undefined;
  const caps = broker?.broker;
  if (!account || !broker || !caps) return OPEN;
  const perAccount = broker.accountOrderEntry;
  if (perAccount) {
    if (perAccount.includes(account.id)) return OPEN;
    return {
      open: false,
      why: `Order entry is off for this ${systemOf(broker)} account; turn it on to send it orders.`,
      canTurnOn: true,
    };
  }
  if (!caps.readOnly && caps.orderTypes.length > 0) return OPEN;
  const paper = caps.environments.length > 0 && caps.environments.every((e) => e === 'paper' || e === 'sim');
  return {
    open: false,
    why: paper
      ? `Order routing is off for ${broker.displayName}; Tessera reads this account and sends it no orders.`
      : `Tessera reads this ${systemOf(broker)} account; this connection sends no orders.`,
  };
}

export interface OrderEntrySwitch {
  connectionId: string;
  system: string;
  on: boolean;
}

export function orderEntrySwitchOf(
  account: EntryAccount | null,
  connections: readonly ConnectionInfo[] | null | undefined,
): OrderEntrySwitch | null {
  if (!account) return null;
  const c = connections?.find((x) => x.id === account.connectionId);
  if (!c?.accountOrderEntry) return null;
  return { connectionId: c.id, system: systemOf(c), on: c.accountOrderEntry.includes(account.id) };
}

export function takesOrderType(
  account: EntryAccount | null,
  connections: readonly ConnectionInfo[] | null | undefined,
  type: OrderType,
): boolean {
  const caps = account ? connections?.find((c) => c.id === account.connectionId)?.broker : undefined;
  if (!caps || caps.orderTypes.length === 0) return true;
  return caps.orderTypes.includes(type);
}

export function useConnectionList(enabled = true): readonly ConnectionInfo[] | undefined {
  const has = useHasTool('connections.list');
  return useToolValue('connections.list', has && enabled ? {} : null, { keepFor: 5_000 })?.connections;
}

export function useOrderEntry(account: EntryAccount | null): OrderEntry {
  return orderEntryOf(account, useConnectionList(account !== null));
}

const RUNTIME_DOWN: OrderEntry = { open: false, why: 'Orders are off until the runtime reconnects' };

export function useRuntimeEntry(): OrderEntry {
  return useStore(connectionStore, (c) => (c.status === 'open' ? OPEN : RUNTIME_DOWN));
}
