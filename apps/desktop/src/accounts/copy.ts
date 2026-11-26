import type { ConnectionInfo, CopyFollower, CopyGroup, CopySyncUpdate, TradingAccount } from '@tessera/protocol';
import { makeStore, useStore } from '../app/store.ts';
import { orderEntryOf } from '../shell/orderEntry.ts';
import { attempt } from '../app/tools.ts';

export interface CopyState {
  groups: CopyGroup[] | null;
  sync: CopySyncUpdate | null;
}

export const copyStore = makeStore<CopyState>({ groups: null, sync: null });

export function useCopyGroups(): CopyGroup[] | null {
  return useStore(copyStore, (s) => s.groups);
}

export function useCopySync(): CopySyncUpdate | null {
  return useStore(copyStore, (s) => s.sync);
}

export function groupOn(groups: readonly CopyGroup[] | null, account: string | null): CopyGroup | null {
  if (!groups || !account) return null;
  return groups.find((g) => g.enabled && g.leaderId === account) ?? null;
}

export function groupsLedBy(groups: readonly CopyGroup[] | null, account: string): CopyGroup[] {
  return (groups ?? []).filter((g) => g.leaderId === account);
}

export function followed(
  groups: readonly CopyGroup[] | null,
  account: string,
): { group: CopyGroup; follower: CopyFollower } | null {
  for (const g of groups ?? []) {
    if (!g.enabled) continue;
    const follower = g.followers.find((f) => f.accountId === account);
    if (follower) return { group: g, follower };
  }
  return null;
}

export function pickGroup(groups: readonly CopyGroup[] | null, id: string | null): CopyGroup | null {
  if (!groups || groups.length === 0) return null;
  return groups.find((g) => g.id === id) ?? groups[0]!;
}

export interface CopyWord {
  text: string;
  groupId: string;
}

export function copyWord(
  groups: readonly CopyGroup[] | null,
  account: string,
  nameOf: (id: string) => string,
): CopyWord | null {
  const leads = groupOn(groups, account);
  if (leads) return { text: `Leads ${leads.name}`, groupId: leads.id };
  const follows = followed(groups, account);
  if (!follows) return null;
  return { text: `Follows ${nameOf(follows.group.leaderId)}`, groupId: follows.group.id };
}

export function sizingWords(f: CopyFollower): string {
  if (f.fixedQty !== undefined) return `fixed ${String(f.fixedQty)}`;
  return `${String(f.multiplier)}×`;
}

export function copiesTip(g: CopyGroup, nameOf: (id: string) => string): string {
  return g.followers.map((f) => `${nameOf(f.accountId)} · ${sizingWords(f)}`).join('\n');
}

export interface Candidate {
  id: string;
  name: string;
  why: string | null;
}

export type CopyAccount = Pick<TradingAccount, 'id' | 'displayName' | 'connectionId' | 'environment'>;

export function candidates(
  groups: readonly CopyGroup[] | null,
  group: Pick<CopyGroup, 'id' | 'leaderId' | 'followers'>,
  accounts: readonly CopyAccount[],
  connections: readonly ConnectionInfo[] | null | undefined,
): Candidate[] {
  const taken = new Set([group.leaderId, ...group.followers.map((f) => f.accountId)]);
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  return accounts
    .filter((a) => !taken.has(a.id))
    .map((a) => {
      const entry = orderEntryOf(a, connections);
      const leads = groupOn(groups, a.id);
      const follows = followed(groups, a.id);
      const why = !entry.open
        ? entry.why
        : leads
          ? `Leads ${leads.name}`
          : follows && follows.group.id !== group.id
            ? `Follows ${nameOf(follows.group.leaderId)}`
            : null;
      return { id: a.id, name: a.displayName, why };
    });
}

export function leaderCandidates(
  groups: readonly CopyGroup[] | null,
  accounts: readonly CopyAccount[],
  connections: readonly ConnectionInfo[] | null | undefined,
): Candidate[] {
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.displayName ?? id;
  return accounts.map((a) => {
    const entry = orderEntryOf(a, connections);
    const follows = followed(groups, a.id);
    const why = !entry.open ? entry.why : follows ? `Follows ${nameOf(follows.group.leaderId)}` : null;
    return { id: a.id, name: a.displayName, why };
  });
}

export function defaultGroupName(groups: readonly CopyGroup[] | null, leaderId: string, leaderName: string): string {
  const led = groupsLedBy(groups, leaderId).length;
  return led === 0 ? `Copy ${leaderName}` : `Copy ${leaderName} ${String(led + 1)}`;
}
export const MULTIPLIER_MAX = 10;
export const FIXED_MAX = 100;

interface FollowerShape {
  multiplier: number;
  fixedQty?: number | undefined;
  micro?: boolean | undefined;
  paused?: boolean | undefined;
}

function follower(accountId: string, s: FollowerShape): CopyFollower {
  return {
    accountId,
    multiplier: s.multiplier,
    ...(s.fixedQty !== undefined ? { fixedQty: s.fixedQty } : {}),
    ...(s.micro ? { micro: true } : {}),
    ...(s.paused ? { paused: true } : {}),
  };
}

function edit(
  followers: readonly CopyFollower[],
  account: string,
  change: (f: CopyFollower) => FollowerShape,
): CopyFollower[] {
  return followers.map((f) => (f.accountId === account ? follower(f.accountId, change(f)) : f));
}

export function withSizing(
  followers: readonly CopyFollower[],
  account: string,
  sizing: { times: number } | { fixed: number },
): CopyFollower[] {
  return edit(followers, account, (f) =>
    'times' in sizing ? { ...f, multiplier: sizing.times, fixedQty: undefined } : { ...f, fixedQty: sizing.fixed },
  );
}

export function withMicro(followers: readonly CopyFollower[], account: string, micro: boolean): CopyFollower[] {
  return edit(followers, account, (f) => ({ ...f, micro }));
}

export function withCopying(followers: readonly CopyFollower[], account: string, copying: boolean): CopyFollower[] {
  return edit(followers, account, (f) => ({ ...f, paused: !copying }));
}

export function withAdded(followers: readonly CopyFollower[], ids: readonly string[]): CopyFollower[] {
  const have = new Set(followers.map((f) => f.accountId));
  const out = [...followers];
  for (const accountId of ids) {
    if (have.has(accountId)) continue;
    have.add(accountId);
    out.push({ accountId, multiplier: 1 });
  }
  return out;
}

export function without(followers: readonly CopyFollower[], account: string): CopyFollower[] {
  return followers.filter((f) => f.accountId !== account);
}

export async function stopAllCopying(groups: readonly CopyGroup[] | null): Promise<void> {
  const on = (groups ?? []).filter((g) => g.enabled);
  await Promise.all(on.map((g) => attempt('copy.disable', { groupId: g.id })));
}
