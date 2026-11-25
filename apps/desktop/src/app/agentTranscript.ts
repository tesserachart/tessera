import { normalizeEpochMs } from '@tessera/protocol';
import type {
  AgentEventEnvelope,
  AgentState,
  Attachment,
  ApprovalKind,
  ApprovalStatus,
  Card,
  ContentBlock,
  PlanStep,
  RiskTier,
  Suggestion,
  ToolOutcome,
  TurnEnd,
} from '@tessera/protocol';

export type TranscriptItem =
  | {
      kind: 'user';
      key: string;
      text: string;
      attachments: readonly Attachment[];
      turnId: string | null;
      steer: boolean;
    }
  | { kind: 'assistant'; key: string; messageId: string; text: string; blocks: ContentBlock[]; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; durationMs: number | null }
  | { kind: 'plan'; key: string; steps: PlanStep[] }
  | {
      kind: 'tool';
      key: string;
      callId: string;
      tool: string;
      risk: RiskTier;
      title: string | null;
      outcome: ToolOutcome | 'running';
      summary: string | null;
      durationMs: number | null;
      error: string | null;
      args: unknown;
      result: string | null;
    }
  | {
      kind: 'approval';
      key: string;
      approvalId: string;
      tool: string;
      approvalKind: ApprovalKind | null;
      status: ApprovalStatus | 'pending';
    }
  | { kind: 'artifact'; key: string; artifactId: string; artifactKind: string; title: string }
  | { kind: 'card'; key: string; card: Card }
  | { kind: 'error'; key: string; message: string; retryable: boolean }
  | { kind: 'turn'; key: string; end: TurnEnd; durationMs: number; toolCalls: number };

interface TranscriptStatus {
  state: AgentState;
  text: string | null;
  step: number | null;
  totalSteps: number | null;
  since: number;
}

export interface Transcript {
  items: TranscriptItem[];
  status: TranscriptStatus | null;
  suggestions: Suggestion[];
  lastSeq: number;
  times: Readonly<Record<string, number>>;
  turnStartedAt: number | null;
}

export const EMPTY_TRANSCRIPT: Transcript = {
  items: [],
  status: null,
  suggestions: [],
  lastSeq: -1,
  times: {},
  turnStartedAt: null,
};

export function reduceTranscript(prev: Transcript, env: AgentEventEnvelope): Transcript {
  if (env.seq <= prev.lastSeq) return prev;
  const ev = env.event;
  const key = String(env.seq);
  let items = prev.items;
  let status = prev.status;
  let suggestions = prev.suggestions;
  let turnStartedAt = prev.turnStartedAt;
  const at = normalizeEpochMs(env.ts);
  const replace = (i: number, item: TranscriptItem) => {
    items = items.slice();
    items[i] = item;
  };
  switch (ev.type) {
    case 'user_message': {
      const asked = items.findLast((it) => it.kind === 'user' || it.kind === 'turn');
      const steer = env.turnId !== null && asked?.kind === 'user' && asked.turnId === env.turnId;
      items = [...items, { kind: 'user', key, text: ev.text, attachments: ev.attachments, turnId: env.turnId, steer }];
      suggestions = [];
      break;
    }
    case 'assistant_delta': {
      const i = items.findLastIndex((it) => it.kind === 'assistant' && it.messageId === ev.messageId);
      const cur = items[i];
      if (cur?.kind === 'assistant') replace(i, { ...cur, text: cur.text + ev.text });
      else
        items = [
          ...items,
          { kind: 'assistant', key, messageId: ev.messageId, text: ev.text, blocks: [], streaming: true },
        ];
      break;
    }
    case 'assistant_message': {
      const i = items.findLastIndex((it) => it.kind === 'assistant' && it.messageId === ev.messageId);
      const cur = items[i];
      const item = {
        kind: 'assistant' as const,
        key: cur?.key ?? key,
        messageId: ev.messageId,
        text: ev.text,
        blocks: ev.blocks,
        streaming: false,
      };
      if (cur) replace(i, item);
      else items = [...items, item];
      break;
    }
    case 'reasoning_summary':
      items = [...items, { kind: 'reasoning', key, text: ev.text, durationMs: ev.durationMs }];
      break;
    case 'plan': {
      const i = items.findLastIndex((it) => it.kind === 'plan');
      const after = i >= 0 && !items.slice(i).some((it) => it.kind === 'user' || it.kind === 'turn');
      if (after) replace(i, { kind: 'plan', key: items[i]!.key, steps: ev.steps });
      else items = [...items, { kind: 'plan', key, steps: ev.steps }];
      break;
    }
    case 'tool_call_started':
      items = [
        ...items,
        {
          kind: 'tool',
          key,
          callId: ev.callId,
          tool: ev.tool,
          risk: ev.risk,
          title: ev.title,
          outcome: 'running',
          summary: null,
          durationMs: null,
          error: null,
          args: ev.args,
          result: null,
        },
      ];
      break;
    case 'tool_call_finished': {
      const i = items.findLastIndex((it) => it.kind === 'tool' && it.callId === ev.callId);
      const cur = items[i];
      const item: TranscriptItem = {
        kind: 'tool',
        key: cur?.key ?? key,
        callId: ev.callId,
        tool: ev.tool,
        risk: ev.risk,
        title: cur?.kind === 'tool' ? cur.title : null,
        outcome: ev.outcome,
        summary: ev.resultSummary,
        durationMs: ev.durationMs,
        error: ev.error?.message ?? null,
        args: cur?.kind === 'tool' ? cur.args : null,
        result: ev.result ?? null,
      };
      if (cur) replace(i, item);
      else items = [...items, item];
      break;
    }
    case 'approval_requested':
      items = [
        ...items,
        { kind: 'approval', key, approvalId: ev.approvalId, tool: ev.tool, approvalKind: ev.kind, status: 'pending' },
      ];
      break;
    case 'approval_resolved': {
      const i = items.findIndex((it) => it.kind === 'approval' && it.approvalId === ev.approvalId);
      const cur = items[i];
      if (cur?.kind === 'approval') replace(i, { ...cur, status: ev.status });
      else
        items = [
          ...items,
          { kind: 'approval', key, approvalId: ev.approvalId, tool: '', approvalKind: null, status: ev.status },
        ];
      break;
    }
    case 'artifact':
      items = [...items, { kind: 'artifact', key, artifactId: ev.artifactId, artifactKind: ev.kind, title: ev.title }];
      break;
    case 'card': {
      const i = items.findIndex((it) => it.kind === 'card' && it.card.id === ev.card.id);
      if (i >= 0) items = items.filter((_, at) => at !== i);
      items = [...items, { kind: 'card', key, card: ev.card }];
      break;
    }
    case 'status':
      if (ev.state === 'idle') turnStartedAt = null;
      else turnStartedAt ??= at;
      status = { state: ev.state, text: ev.text, step: ev.step, totalSteps: ev.totalSteps, since: turnStartedAt ?? at };
      break;
    case 'error':
      items = [...items, { kind: 'error', key, message: ev.message, retryable: ev.retryable }];
      break;
    case 'turn_started':
      turnStartedAt = at;
      if (status) status = { ...status, since: at };
      break;
    case 'turn_finished':
      items = items.map((it) => (it.kind === 'assistant' && it.streaming ? { ...it, streaming: false } : it));
      items = [...items, { kind: 'turn', key, end: ev.end, durationMs: ev.durationMs, toolCalls: ev.toolCalls }];
      status = null;
      turnStartedAt = null;
      break;
    case 'suggestions':
      suggestions = ev.items.slice(0, 4);
      break;
  }
  let times = prev.times;
  const added = items.length > prev.items.length ? items.at(-1) : undefined;
  if (added && !(added.key in times)) times = { ...times, [added.key]: at };
  return { items, status, suggestions, lastSeq: env.seq, times, turnStartedAt };
}
