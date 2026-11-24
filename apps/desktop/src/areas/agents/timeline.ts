import type { Approval, Attachment, Card, ContentBlock, PlanStep, Suggestion, TurnEnd } from '@tessera/protocol';
import { formatDuration } from '@tessera/ui';
import type { Transcript, TranscriptItem } from '../../app/agentTranscript.ts';
import { isWork, settle, type Work } from '../../analyst/blocks.ts';
import { isLive } from '../../analyst/analystStore.ts';

export type Row =
  | { kind: 'user'; key: string; text: string; attachments: readonly Attachment[] }
  | {
      kind: 'assistant';
      key: string;
      text: string;
      blocks: readonly ContentBlock[];
      streaming: boolean;
      answer: boolean;
    }
  | { kind: 'entry'; key: string; entry: Work; depth: number; open: boolean }
  | { kind: 'group'; key: string; entries: readonly Work[]; depth: number; open: boolean }
  | { kind: 'fold'; key: string; end: TurnEnd; durationMs: number; toolCalls: number; open: boolean }
  | { kind: 'approval'; key: string; approval: Approval }
  | { kind: 'card'; key: string; card: Card }
  | { kind: 'plan'; key: string; steps: readonly PlanStep[] }
  | { kind: 'error'; key: string; message: string; retryable: boolean }
  | { kind: 'end'; key: string; end: TurnEnd; durationMs: number; toolCalls: number }
  | { kind: 'live'; key: 'live' }
  | { kind: 'follow'; key: 'follow'; items: readonly Suggestion[] }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'tail'; key: 'tail' };

export interface TimelineInput {
  transcript: Transcript | null;
  waiting: readonly Approval[];
  expired?: readonly Approval[];
  settled: boolean;
  working: boolean;
  open: ReadonlySet<string>;
  notices?: readonly { key: string; text: string }[];
  shownApart?: (a: Approval) => boolean;
}

const foldKey = (turnKey: string) => `fold:${turnKey}`;
const groupKey = (firstKey: string) => `group:${firstKey}`;

function emit(
  out: Row[],
  items: readonly TranscriptItem[],
  depth: number,
  cards: ReadonlyMap<string, Approval>,
  open: ReadonlySet<string>,
): void {
  let run: Work[] = [];
  const flush = () => {
    if (run.length === 1) {
      const entry = run[0]!;
      out.push({ kind: 'entry', key: entry.key, entry, depth, open: open.has(entry.key) });
    } else if (run.length > 1) {
      const key = groupKey(run[0]!.key);
      const isOpen = open.has(key);
      out.push({ kind: 'group', key, entries: run, depth, open: isOpen });
      if (isOpen)
        for (const entry of run)
          out.push({ kind: 'entry', key: entry.key, entry, depth: depth + 1, open: open.has(entry.key) });
    }
    run = [];
  };
  for (const item of items) {
    const approval = item.kind === 'approval' ? cards.get(item.approvalId) : undefined;
    if (approval) {
      flush();
      out.push({ kind: 'approval', key: `ap:${approval.id}`, approval });
    } else if (isWork(item)) run.push(item);
    else {
      flush();
      const row = itemRow(item, false);
      if (row) out.push(row);
    }
  }
  flush();
}

function itemRow(item: TranscriptItem, answer: boolean): Row | null {
  switch (item.kind) {
    case 'user':
      return { kind: 'user', key: item.key, text: item.text, attachments: item.attachments };
    case 'assistant':
      return {
        kind: 'assistant',
        key: item.key,
        text: item.text,
        blocks: item.blocks,
        streaming: item.streaming,
        answer,
      };
    case 'plan':
      return item.steps.length > 0 ? { kind: 'plan', key: item.key, steps: item.steps } : null;
    case 'error':
      return { kind: 'error', key: item.key, message: item.message, retryable: item.retryable };
    case 'card':
      return { kind: 'card', key: item.key, card: item.card };
    default:
      return null;
  }
}

export function timelineRows(input: TimelineInput): Row[] {
  const { transcript, settled, working, open } = input;
  const shown = [...input.waiting, ...(input.expired ?? [])];
  const waiting = new Map(input.waiting.map((a) => [a.id, a]));
  const cards = new Map(shown.map((a) => [a.id, a]));
  const calls = new Set(input.waiting.map((a) => a.callId));
  const raw = transcript?.items ?? [];
  const items = settled ? raw.map((it) => settle(it, waiting, calls)) : raw;

  const turns: TranscriptItem[][] = [];
  for (const it of items) {
    if ((it.kind === 'user' && !it.steer) || turns.length === 0) turns.push([it]);
    else turns[turns.length - 1]!.push(it);
  }

  const out: Row[] = [];
  const inline = new Set<string>();
  turns.forEach((turn, i) => {
    const user = turn[0]?.kind === 'user' ? turn[0] : null;
    if (user) out.push({ kind: 'user', key: user.key, text: user.text, attachments: user.attachments });
    const endAt = turn.findIndex((it) => it.kind === 'turn');
    const end = endAt >= 0 ? (turn[endAt] as Extract<TranscriptItem, { kind: 'turn' }>) : undefined;
    const afterEnd = endAt >= 0 ? turn.slice(endAt + 1) : [];
    const body = turn.filter((it, j) => it !== user && it.kind !== 'turn' && (endAt < 0 || j < endAt));
    for (const it of body) if (it.kind === 'approval' && cards.has(it.approvalId)) inline.add(it.approvalId);
    const running = i === turns.length - 1 && working;
    if (!end || running) {
      emit(out, [...body, ...afterEnd], 0, cards, open);
      return;
    }
    const answerAt = body.findLastIndex((it) => it.kind === 'assistant');
    const outside = (it: TranscriptItem) =>
      it.kind === 'error' ||
      it.kind === 'user' ||
      it.kind === 'card' ||
      (it.kind === 'approval' && cards.has(it.approvalId));
    const folded = body.filter((it, j) => j !== answerAt && !outside(it));
    if (folded.length > 0) {
      const key = foldKey(end.key);
      const isOpen = open.has(key);
      out.push({ kind: 'fold', key, end: end.end, durationMs: end.durationMs, toolCalls: end.toolCalls, open: isOpen });
      if (isOpen) emit(out, folded, 1, cards, open);
    }
    emit(out, body.filter(outside), 0, cards, open);
    const answer = answerAt >= 0 ? itemRow(body[answerAt]!, true) : null;
    if (answer) out.push(answer);
    if (end.end !== 'completed')
      out.push({ kind: 'end', key: end.key, end: end.end, durationMs: end.durationMs, toolCalls: end.toolCalls });
    emit(out, afterEnd, 0, cards, open);
  });

  for (const a of shown) if (!inline.has(a.id)) out.push({ kind: 'approval', key: `ap:${a.id}`, approval: a });
  if (working) out.push({ kind: 'live', key: 'live' });
  else if (transcript && transcript.suggestions.length > 0)
    out.push({ kind: 'follow', key: 'follow', items: transcript.suggestions });
  for (const n of input.notices ?? []) out.push({ kind: 'notice', key: n.key, text: n.text });
  const apart = input.shownApart;
  return apart ? out.filter((r) => r.kind !== 'approval' || !apart(r.approval)) : out;
}

function sameArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
}

function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of Object.keys(ra)) {
    const x = ra[k];
    const y = rb[k];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && sameArray(x, y)) continue;
    return false;
  }
  return Object.keys(rb).length === Object.keys(ra).length;
}

export function noteArrivals(
  seen: Map<string, boolean>,
  rows: readonly Row[],
  times: Readonly<Record<string, number>>,
  now: number,
): void {
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    const at = times[row.key];
    seen.set(row.key, at !== undefined && isLive(at, now));
  }
}

export function stableRows(prev: ReadonlyMap<string, Row>, next: Row[]): Row[] {
  return next.map((row) => {
    const old = prev.get(row.key);
    return old && sameRow(old, row) ? old : row;
  });
}

export function foldWords(row: Extract<Row, { kind: 'fold' | 'end' }>): string {
  const d = formatDuration(row.durationMs);
  if (row.end === 'interrupted') return `Stopped after ${d}`;
  if (row.end === 'failed') return `Failed after ${d}`;
  if (row.end === 'loop_guard') return `Stopped by the loop guard after ${d}`;
  return `Worked for ${d}`;
}

function needsYou(w: Work): boolean {
  return (w.kind === 'tool' && w.outcome === 'pending_approval') || (w.kind === 'approval' && w.status === 'pending');
}

export function groupWords(entries: readonly Work[]): {
  text: string;
  need: boolean;
  failed: boolean;
  running: boolean;
} {
  const tools = entries.filter((e) => e.kind === 'tool').length;
  const thought = entries.filter((e): e is Extract<Work, { kind: 'reasoning' }> => e.kind === 'reasoning');
  const parts: string[] = [];
  if (thought.length > 0) {
    const ms = thought.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
    parts.push(ms > 0 ? `Thought for ${formatDuration(ms)}` : 'Thought');
  }
  if (tools > 0) parts.push(`Used ${String(tools)} tool${tools === 1 ? '' : 's'}`);
  const other = entries.length - tools - thought.length;
  if (other > 0 && parts.length === 0) parts.push(`${String(other)} step${other === 1 ? '' : 's'}`);
  return {
    text: parts.join(' · ') || 'Worked',
    need: entries.some(needsYou),
    failed: entries.some((e) => e.kind === 'tool' && e.outcome === 'error'),
    running: entries.some((e) => e.kind === 'tool' && e.outcome === 'running'),
  };
}

export function thoughtLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) =>
      l
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .find((l) => l.length > 0);
  return line ?? 'Thought';
}

export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function hasArgs(args: unknown): boolean {
  if (args === null || args === undefined) return false;
  if (typeof args === 'object') return Object.keys(args).length > 0;
  return typeof args !== 'string' || args.length > 0;
}
