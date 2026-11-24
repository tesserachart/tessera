import type { Approval, ApprovalEvent } from '@tessera/protocol';

export interface Approvals {
  pending: ReadonlyMap<string, Approval>;
  expired: readonly Approval[];
  dismissed: ReadonlySet<string>;
}

export const NO_APPROVALS: Approvals = { pending: new Map(), expired: [], dismissed: new Set() };

export function reduceApprovals(prev: Approvals, ev: ApprovalEvent): Approvals {
  if (ev.type === 'snapshot') return { ...prev, pending: new Map(ev.pending.map((a) => [a.id, a])) };
  const { id } = ev.approval;
  const was = prev.pending.get(id);
  const pending = new Map(prev.pending);
  if (ev.type === 'requested' && ev.approval.status === 'pending') pending.set(id, ev.approval);
  else pending.delete(id);
  const expired =
    ev.type === 'stale' && was?.kind === 'financial' && !prev.dismissed.has(id)
      ? [...prev.expired, ev.approval]
      : prev.expired;
  return { ...prev, pending, expired };
}

export function dismissApproval(prev: Approvals, id: string): Approvals {
  return { ...prev, expired: prev.expired.filter((a) => a.id !== id), dismissed: new Set([...prev.dismissed, id]) };
}

export function shownPending(book: Approvals): Approval[] {
  return [...book.pending.values()].filter((a) => !book.dismissed.has(a.id)).sort((a, b) => a.createdAt - b.createdAt);
}
