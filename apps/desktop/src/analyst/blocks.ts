import type { Approval } from '@tessera/protocol';
import type { TranscriptItem } from '../app/agentTranscript.ts';

export type Work = Exclude<TranscriptItem, { kind: 'user' | 'assistant' | 'plan' | 'error' | 'turn' | 'card' }>;
export type Block =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'work'; key: string; items: Work[] }
  | { kind: 'approval'; key: string; approval: Approval };

export function isWork(item: TranscriptItem): item is Work {
  return item.kind === 'tool' || item.kind === 'reasoning' || item.kind === 'approval' || item.kind === 'artifact';
}

export function settle(
  item: TranscriptItem,
  waiting: ReadonlyMap<string, Approval>,
  calls: ReadonlySet<string>,
): TranscriptItem {
  if (item.kind === 'approval' && item.status === 'pending' && !waiting.has(item.approvalId))
    return { ...item, status: 'stale' };
  if (item.kind === 'tool' && item.outcome === 'pending_approval' && !calls.has(item.callId))
    return { ...item, outcome: 'ok', summary: 'expired' };
  return item;
}

export function blocks(
  items: readonly TranscriptItem[],
  waiting: ReadonlyMap<string, Approval> = new Map(),
  settled = false,
): Block[] {
  const out: Block[] = [];
  const calls = new Set([...waiting.values()].map((a) => a.callId));
  for (const raw of items) {
    const item = settled ? settle(raw, waiting, calls) : raw;
    const last = out.at(-1);
    const approval = item.kind === 'approval' ? waiting.get(item.approvalId) : undefined;
    if (approval) {
      out.push({ kind: 'approval', key: item.key, approval });
      continue;
    }
    if (isWork(item)) {
      if (last?.kind === 'work') last.items.push(item);
      else out.push({ kind: 'work', key: item.key, items: [item] });
    } else out.push({ kind: 'item', item });
  }
  return out;
}
