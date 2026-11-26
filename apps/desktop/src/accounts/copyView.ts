import type {
  CopyActivity,
  CopyFollower,
  CopyFollowerSync,
  CopyGroup,
  CopyGroupSync,
  CopyLast,
  CopyReport,
  CopySyncUpdate,
  Environment,
  InvokeSurface,
} from '@tessera/protocol';
import type { DotState } from '@tessera/ui';
import { attempt, type ToolInput } from '../app/tools.ts';
import { displaySymbol } from '../market/instruments.ts';
import { positionWord, sendSurface } from '../shell/ticket.ts';
import { EXIT_SURFACE, sendFailure } from '../shell/tradeActions.ts';

export function holdingWords(qty: number, instrument: string): string {
  return qty === 0 ? 'Flat' : `${positionWord(qty)} ${displaySymbol(instrument)}`;
}

export function holdingsWords(list: readonly { instrument: string; qty: number }[]): string {
  const held = list.filter((h) => h.qty !== 0);
  return held.length === 0 ? 'Flat' : held.map((h) => holdingWords(h.qty, h.instrument)).join(', ');
}

export function syncOf(sync: CopySyncUpdate | null, groupId: string): CopyGroupSync | null {
  return sync?.groups.find((g) => g.groupId === groupId) ?? null;
}

export interface SyncView {
  text: string;
  dot: DotState | null;
  strong: boolean;
  rule: boolean;
}

const QUIET = { dot: null, strong: false, rule: false } as const;

export function syncView(s: Pick<CopyFollowerSync, 'state' | 'why'> | null, paused: boolean): SyncView {
  if (s === null) return { text: '', ...QUIET };
  if (paused && s.state === 'out_of_sync') {
    return { text: `Paused: ${s.why ?? 'out of sync'}`, dot: 'down', strong: true, rule: true };
  }
  if (paused && s.state !== 'unknown') return { text: 'Paused', ...QUIET };
  switch (s.state) {
    case 'in_sync':
      return { text: 'In sync', ...QUIET };
    case 'settling':
      return { text: 'Copying…', ...QUIET };
    case 'out_of_sync':
      return { text: s.why ?? 'Out of sync', dot: 'down', strong: true, rule: true };
    case 'unknown':
      return { text: `Unknown: ${s.why ?? 'positions could not be read'}`, dot: 'degraded', strong: true, rule: false };
  }
}

export interface LastView {
  text: string;
  dot: DotState;
  at: number;
}

export function lastView(last: CopyLast | null): LastView | null {
  if (!last) return null;
  if (last.outcome === 'skipped') return { text: `${last.what}: ${last.text}`, dot: 'down', at: last.at };
  if (last.outcome === 'unknown') return { text: `${last.what}: ${last.text}`, dot: 'degraded', at: last.at };
  return null;
}

export interface FollowerRow {
  accountId: string;
  name: string;
  follower: CopyFollower;
  paused: boolean;
  micro: boolean;
  holds: string;
  shouldHold: string;
  sync: SyncView;
  last: LastView | null;
  resync: boolean;
  flatten: boolean;
}

function readable(s: CopyFollowerSync | null): s is CopyFollowerSync {
  return s !== null && s.state !== 'unknown';
}

export function followerRows(
  followers: readonly CopyFollower[],
  sync: CopyGroupSync | null,
  nameOf: (id: string) => string,
): FollowerRow[] {
  return followers.map((f) => {
    const s = sync?.followers.find((x) => x.accountId === f.accountId) ?? null;
    const paused = f.paused === true;
    const known = readable(s);
    return {
      accountId: f.accountId,
      name: s?.account ?? nameOf(f.accountId),
      follower: f,
      paused,
      micro: f.micro === true,
      holds: known ? holdingsWords(s.holdings) : '',
      shouldHold: known ? holdingsWords(s.holdings.map((h) => ({ instrument: h.instrument, qty: h.targetQty }))) : '',
      sync: syncView(s, paused),
      last: lastView(s?.last ?? null),
      resync: s?.state === 'out_of_sync',
      flatten: !known || s.holdings.some((h) => h.qty !== 0),
    };
  });
}

export function resyncing(group: Pick<CopyGroup, 'followers'>, sync: CopyGroupSync | null): string[] {
  const paused = new Set(group.followers.filter((f) => f.paused).map((f) => f.accountId));
  return (sync?.followers ?? [])
    .filter((s) => !paused.has(s.accountId) && (s.state === 'out_of_sync' || s.state === 'settling'))
    .map((s) => s.accountId);
}

export function needsResync(group: Pick<CopyGroup, 'followers'>, sync: CopyGroupSync | null): boolean {
  const paused = new Set(group.followers.filter((f) => f.paused).map((f) => f.accountId));
  return (sync?.followers ?? []).some((s) => !paused.has(s.accountId) && s.state === 'out_of_sync');
}

export function leaderWords(sync: CopyGroupSync | null): string {
  return sync ? holdingsWords(sync.leaderHoldings) : '';
}

export function groupLine(group: CopyGroup, leaderName: string): string {
  const n = group.followers.length;
  return `${leaderName} → ${String(n)} ${n === 1 ? 'follower' : 'followers'}`;
}

export function outOfSyncWords(sync: CopyGroupSync | null): string | null {
  const n = sync?.outOfSync ?? 0;
  return n > 0 ? `${String(n)} out of sync` : null;
}

export function activityWords(a: CopyActivity): string {
  const reach = a.of === 0 ? a.what : `${a.what}: copied to ${String(a.copied)} of ${String(a.of)}`;
  return a.detail ? `${reach} · ${a.detail}` : reach;
}

export function reportWhy(report: CopyReport): string | null {
  const missed = report.results.filter((r) => r.outcome === 'skipped' || r.outcome === 'unknown');
  return missed.length === 0 ? null : missed.map((r) => `${r.account}: ${r.text}`).join('; ');
}

export function confirmSurface(environments: readonly Environment[]): InvokeSurface {
  return {
    armed: true,
    holdConfirmed: environments.some((e) => sendSurface(e).holdConfirmed),
  };
}

export type CopyActResult =
  { kind: 'done'; report: CopyReport } | { kind: 'drafted' } | { kind: 'failed'; why: string };

type CopyAct = 'copy.resync' | 'copy.flatten';

async function act<N extends CopyAct>(name: N, input: ToolInput<N>, surface: InvokeSurface): Promise<CopyActResult> {
  const r = await attempt(name, input, { surface, queue: false, unanswered: (e) => sendFailure(e).text });
  if (r.ok) return { kind: 'done', report: r.out.report };
  return r.drafted ? { kind: 'drafted' } : { kind: 'failed', why: r.why };
}

export function resync(input: ToolInput<'copy.resync'>, environments: readonly Environment[]): Promise<CopyActResult> {
  return act('copy.resync', input, confirmSurface(environments));
}

export function flattenCopy(input: ToolInput<'copy.flatten'>): Promise<CopyActResult> {
  return act('copy.flatten', input, EXIT_SURFACE);
}
