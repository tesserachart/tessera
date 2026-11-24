import type { Approval, ApprovalStatus, ContentBlock, Epistemic, Suggestion } from '@tessera/protocol';
import { Button, cx, formatDuration, formatElapsed } from '@tessera/ui';
import { Fragment, type ReactNode } from 'react';
import { EMPTY_TRANSCRIPT, type Transcript, type TranscriptItem } from '../app/agentTranscript.ts';
import { useNow } from '../app/runtimeContext.ts';
import { analystActivity, isWorking, type Activity } from '../analyst/activity.ts';
import { blocks, type Work } from '../analyst/blocks.ts';
import { LiveCard } from '../analyst/cards/LiveCard.tsx';
import { toolTitle } from './approval.ts';

const EPISTEMIC: Record<Epistemic, string> = {
  measured: 'Measured',
  observed: 'Observed',
  hypothesis: 'Hypothesis',
  interpretation: 'Interpretation',
};

const APPROVAL_TEXT: Record<ApprovalStatus | 'pending', string> = {
  pending: 'waiting',
  approved: 'approved',
  rejected: 'rejected',
  stale: 'expired',
  superseded: 'edited',
  cancelled: 'cancelled',
};

const CHANGE_TEXT: Partial<Record<ApprovalStatus | 'pending', string>> = { approved: 'allowed', rejected: 'denied' };

export interface LogNotice {
  key: string;
  at: number;
  text: string;
}

function richText(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 === 1 ? <b key={i}>{p}</b> : <Fragment key={i}>{p}</Fragment>));
}

function figures(value: string): boolean {
  return /^[\d\s.,:%$+−-]+$/.test(value) && /\d/.test(value);
}

export function Result({ block }: { block: ContentBlock }) {
  const measured = block.kind === 'measured' || block.kind === 'observed';
  const source = `${EPISTEMIC[block.kind]}${block.title ? ` · ${block.title}` : ''}`;
  return (
    <figure className="res" data-kind={block.kind}>
      {measured ? null : <figcaption className="mk">{EPISTEMIC[block.kind]}</figcaption>}
      {block.text ? <p className="tx">{richText(block.text)}</p> : null}
      {block.rows.length > 0 ? (
        <dl className="kv">
          {block.rows.map(([l, v], i) => (
            <Fragment key={i}>
              <dt>{l}</dt>
              <dd className={measured && figures(v) ? 'f' : undefined}>{v}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      {measured ? (
        <figcaption className="src">{source}</figcaption>
      ) : block.title ? (
        <p className="src">{block.title}</p>
      ) : null}
    </figure>
  );
}

function workText(item: TranscriptItem): string {
  switch (item.kind) {
    case 'tool': {
      const name = item.title ?? item.tool;
      const parts = [name];
      if (item.outcome === 'running') return `${name}…`;
      if (item.summary) parts.push(item.summary);
      if (item.outcome === 'denied') parts.push('denied');
      if (item.outcome === 'pending_approval') parts.push('waiting for your approval');
      if (item.outcome === 'error') parts.push(item.error ? `failed: ${item.error}` : 'failed');
      if (item.durationMs !== null) parts.push(formatDuration(item.durationMs));
      return parts.join(' · ');
    }
    case 'reasoning':
      return `Thought${item.durationMs !== null ? ` for ${formatDuration(item.durationMs)}` : ''} · ${item.text}`;
    case 'approval': {
      if (item.approvalKind === 'financial') return `Draft ${APPROVAL_TEXT[item.status]}`;
      const what = item.tool ? toolTitle(item.tool) : 'Change';
      return `${what} ${CHANGE_TEXT[item.status] ?? APPROVAL_TEXT[item.status]}`;
    }
    case 'artifact':
      return `Made ${item.title}`;
    case 'turn': {
      const d = formatDuration(item.durationMs);
      const calls = `${String(item.toolCalls)} tool call${item.toolCalls === 1 ? '' : 's'}`;
      if (item.end === 'completed') return `Worked ${d} · ${calls}`;
      if (item.end === 'interrupted') return `Stopped after ${d} · ${calls}`;
      if (item.end === 'loop_guard') return `Stopped by the loop guard after ${d} · ${calls}`;
      return `Failed after ${d} · ${calls}`;
    }
    default:
      return '';
  }
}

function needsYou(w: Work): boolean {
  return (w.kind === 'tool' && w.outcome === 'pending_approval') || (w.kind === 'approval' && w.status === 'pending');
}

function workSummary(items: readonly Work[]): { text: string; need: boolean; failed: boolean } {
  const tools = items.filter((i) => i.kind === 'tool').length;
  const thought = items.some((i) => i.kind === 'reasoning');
  const parts: string[] = [];
  if (thought) parts.push('Thought');
  if (tools) parts.push(`Used ${String(tools)} tool${tools === 1 ? '' : 's'}`);
  const need = items.some(needsYou);
  if (need) parts.push('waiting for your approval');
  const failed = items.some((i) => i.kind === 'tool' && i.outcome === 'error');
  return { text: parts.join(' · ') || 'Worked', need, failed };
}

function WorkFold({ items }: { items: readonly Work[] }) {
  const { text, need, failed } = workSummary(items);
  return (
    <details className="cx-work" data-need={need ? '' : undefined} data-failed={failed ? '' : undefined}>
      <summary>
        <span>{text}</span>
      </summary>
      <ul>
        {items.map((w) => (
          <li key={w.key} data-need={needsYou(w) ? '' : undefined} title={workText(w)}>
            {workText(w)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Item({ item, onRetry }: { item: TranscriptItem; onRetry?: (() => void) | undefined }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="cx-you">
          <p>{item.text}</p>
        </div>
      );
    case 'assistant':
      return (
        <div className="cx-say" data-streaming={item.streaming ? '' : undefined}>
          {item.text ? item.text.split(/\n{2,}/).map((para, i) => <p key={i}>{richText(para)}</p>) : null}
          {item.blocks.map((b, i) => (
            <Result key={i} block={b} />
          ))}
        </div>
      );
    case 'plan':
      return item.steps.length >= 3 ? (
        <ol className="cx-plan" aria-label="Plan">
          {item.steps.map((s, i) => (
            <li key={i} data-status={s.status}>
              {s.text}
            </li>
          ))}
        </ol>
      ) : null;
    case 'error':
      return (
        <div className={cx('cx-err', onRetry && item.retryable && 'flex items-center gap-3')} role="alert">
          <p>{item.message}</p>
          {onRetry && item.retryable ? (
            <Button size="s" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      );
    case 'turn':
      return item.end === 'completed' ? null : <p className="cx-end">{workText(item)}</p>;
    case 'card':
      return <LiveCard card={item.card} />;
    default:
      return null;
  }
}

function LiveStatus({ words, since }: { words: string; since: number | null }) {
  return (
    <div className="cx-live">
      <span className="tx" title={words} role="status">
        {words}
      </span>
      {since !== null ? <Elapsed since={since} /> : null}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return (
    <>
      <span className="flex-none text-t3 tabular-nums" aria-hidden="true">
        ·
      </span>
      <time aria-hidden="true">{formatElapsed(now - since)}</time>
    </>
  );
}

export function TranscriptView({
  transcript,
  notices,
  onFollowUp,
  waiting = [],
  settled = false,
  renderApproval,
  activity,
  onRetry,
  children,
}: {
  transcript: Transcript | null;
  notices: readonly LogNotice[];
  onFollowUp: (s: Suggestion) => void;
  waiting?: readonly Approval[];
  settled?: boolean;
  renderApproval?: (a: Approval) => ReactNode;
  activity?: Activity;
  onRetry?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const t = transcript ?? EMPTY_TRANSCRIPT;
  const { items, suggestions } = t;
  const now = activity ?? analystActivity(transcript, null);
  const byId = new Map(renderApproval ? waiting.map((a) => [a.id, a]) : []);
  const list = blocks(items, byId, settled);
  const inline = new Set(list.flatMap((b) => (b.kind === 'approval' ? [b.approval.id] : [])));
  const rest = renderApproval ? waiting.filter((a) => !inline.has(a.id)) : [];
  const lastAsk = items.findLastIndex((i) => i.kind === 'user');
  const lastErr = items.findLastIndex((i) => i.kind === 'error');
  const retryKey = lastErr > lastAsk ? items[lastErr]?.key : undefined;
  return (
    <div className="cx">
      {list.map((b) => {
        if (b.kind === 'work') return <WorkFold key={b.key} items={b.items} />;
        if (b.kind === 'approval') return <Fragment key={b.key}>{renderApproval?.(b.approval)}</Fragment>;
        return <Item key={b.item.key} item={b.item} onRetry={b.item.key === retryKey ? onRetry : undefined} />;
      })}
      {rest.map((a) => (
        <Fragment key={a.id}>{renderApproval?.(a)}</Fragment>
      ))}
      {isWorking(now) && now.words ? <LiveStatus words={now.words} since={now.since} /> : null}
      {suggestions.length > 0 && !isWorking(now) ? (
        <div className="cx-follow" role="list" aria-label="Follow-ups">
          {suggestions.map((s) => (
            <button key={s.label} type="button" role="listitem" onClick={() => onFollowUp(s)}>
              {s.label}
            </button>
          ))}
        </div>
      ) : null}
      {children}
      {notices.map((n) => (
        <p key={n.key} className="cx-err">
          {n.text}
        </p>
      ))}
    </div>
  );
}
