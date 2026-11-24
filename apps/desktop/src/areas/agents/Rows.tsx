import type { ApprovalStatus, ToolDescriptor } from '@tessera/protocol';
import { Button, Icon, cx, formatDuration, formatElapsed, type IconName } from '@tessera/ui';
import { memo, useContext, useState } from 'react';
import { useNow } from '../../app/runtimeContext.ts';
import type { Work } from '../../analyst/blocks.ts';
import { Result } from '../../shell/AgentTranscript.tsx';
import { toolTitle } from '../../shell/approval.ts';
import { MessageFiles } from './Attachments.tsx';
import { Markdown } from './Markdown.tsx';
import { LiveCtx, RowCtx, TailCtx, type RowContext } from './rowContext.ts';
import { foldWords, groupWords, hasArgs, prettyJson, thoughtLine, type Row } from './timeline.ts';
import { LiveCard } from '../../analyst/cards/LiveCard.tsx';

function TailRow() {
  return <div className="ag-tail">{useContext(TailCtx)}</div>;
}

function useRowCtx(): RowContext {
  const ctx = useContext(RowCtx);
  if (!ctx) throw new Error('a conversation row outside its conversation');
  return ctx;
}

function toolIcon(tool: string): IconName {
  const ns = tool.split('.')[0] ?? '';
  if (ns === 'chart') return 'chart';
  if (ns === 'indicators') return 'indicators';
  if (ns === 'market' || ns === 'orders' || ns === 'portfolio' || ns === 'broker') return 'ticket';
  if (ns === 'levels' || ns === 'intel' || ns === 'concepts') return 'levels';
  if (ns === 'drawings') return 'trend-line';
  if (ns === 'settings') return 'settings';
  if (ns === 'appearance') return 'appearance';
  if (ns === 'workspace' || ns === 'layout' || ns === 'areas') return 'desk';
  if (ns === 'research' || ns === 'strategy') return 'research';
  if (ns === 'journal') return 'journal';
  if (ns === 'connections') return 'accounts';
  return 'command';
}

const APPROVAL_WORD: Record<ApprovalStatus | 'pending', string> = {
  pending: 'waits for you',
  approved: 'approved',
  rejected: 'rejected',
  stale: 'expired',
  superseded: 'edited',
  cancelled: 'cancelled',
};

function entryParts(
  e: Work,
  tools: ReadonlyMap<string, ToolDescriptor> | null,
): { icon: IconName; label: string; meta: string | null; tone: 'need' | 'failed' | null } {
  switch (e.kind) {
    case 'tool': {
      const label = e.title ?? tools?.get(e.tool)?.title ?? toolTitle(e.tool);
      if (e.outcome === 'running') return { icon: toolIcon(e.tool), label: `${label}…`, meta: null, tone: null };
      if (e.outcome === 'pending_approval')
        return { icon: toolIcon(e.tool), label, meta: 'waits for you', tone: 'need' };
      if (e.outcome === 'error') return { icon: toolIcon(e.tool), label, meta: 'failed', tone: 'failed' };
      if (e.outcome === 'denied') return { icon: toolIcon(e.tool), label, meta: 'refused', tone: 'failed' };
      return {
        icon: toolIcon(e.tool),
        label,
        meta: e.summary ?? (e.durationMs !== null ? formatDuration(e.durationMs) : null),
        tone: null,
      };
    }
    case 'reasoning':
      return {
        icon: 'analyst',
        label: thoughtLine(e.text),
        meta: e.durationMs !== null ? formatDuration(e.durationMs) : null,
        tone: null,
      };
    case 'approval': {
      const what = e.approvalKind === 'financial' ? 'Draft' : e.tool ? toolTitle(e.tool) : 'Change';
      return {
        icon: 'done',
        label: what,
        meta: APPROVAL_WORD[e.status],
        tone: e.status === 'pending' ? 'need' : null,
      };
    }
    case 'artifact':
      return { icon: 'note', label: e.title, meta: null, tone: null };
  }
}

function EntryDetail({ entry }: { entry: Work }) {
  if (entry.kind === 'reasoning')
    return (
      <div className="ag-detail">
        <Markdown text={entry.text} />
      </div>
    );
  if (entry.kind !== 'tool') return null;
  const args = hasArgs(entry.args) ? prettyJson(entry.args) : null;
  const result = entry.result ? prettyJson(entry.result) : null;
  return (
    <div className="ag-detail">
      <p className="nm">{entry.tool}</p>
      {args ? (
        <>
          <p className="lb">Arguments</p>
          <pre>{args}</pre>
        </>
      ) : null}
      {entry.error ? <p className="er">{entry.error}</p> : null}
      {result ? (
        <>
          <p className="lb">Answer</p>
          <pre>{result}</pre>
        </>
      ) : null}
    </div>
  );
}

function EntryRow({ row }: { row: Extract<Row, { kind: 'entry' }> }) {
  const { toggle, tools } = useRowCtx();
  const e = row.entry;
  const parts = entryParts(e, tools);
  const opens = e.kind === 'reasoning' || e.kind === 'tool';
  return (
    <div className="ag-entry" data-depth={row.depth} data-tone={parts.tone ?? undefined}>
      <button
        type="button"
        className="ag-line"
        aria-expanded={opens ? row.open : undefined}
        disabled={!opens}
        onClick={() => toggle(row.key)}
      >
        <Icon name={parts.icon} className="gl" />
        <span className="lb">{parts.label}</span>
        {parts.meta ? <span className="mt">{parts.meta}</span> : null}
        {opens ? <Icon name="chevron-right" className={cx('cv', row.open && 'is-open')} /> : null}
      </button>
      {row.open ? <EntryDetail entry={e} /> : null}
    </div>
  );
}

function GroupRow({ row }: { row: Extract<Row, { kind: 'group' }> }) {
  const { toggle } = useRowCtx();
  const w = groupWords(row.entries);
  return (
    <div
      className="ag-entry is-group"
      data-depth={row.depth}
      data-tone={w.need ? 'need' : w.failed ? 'failed' : undefined}
    >
      <button type="button" className="ag-line" aria-expanded={row.open} onClick={() => toggle(row.key)}>
        <span className="lb">
          {w.text}
          {w.running ? '…' : ''}
        </span>
        {w.need ? <span className="mt">waits for you</span> : null}
        <Icon name="chevron-right" className={cx('cv', row.open && 'is-open')} />
      </button>
    </div>
  );
}

function FoldRow({ row }: { row: Extract<Row, { kind: 'fold' }> }) {
  const { toggle } = useRowCtx();
  return (
    <div className="ag-fold">
      <button type="button" className="ag-line" aria-expanded={row.open} onClick={() => toggle(row.key)}>
        <span className="lb">{foldWords(row)}</span>
        {row.toolCalls > 0 ? (
          <span className="mt">
            {row.toolCalls} tool call{row.toolCalls === 1 ? '' : 's'}
          </span>
        ) : null}
        <Icon name="chevron-right" className={cx('cv', row.open && 'is-open')} />
      </button>
    </div>
  );
}

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="s"
      variant="quiet"
      className="ag-copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function LiveRow() {
  const activity = useContext(LiveCtx);
  return (
    <div className="ag-live">
      <span className="tx" role="status">
        {activity.words ?? 'Working'}
      </span>
      {activity.since !== null ? <Elapsed since={activity.since} /> : null}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const now = useNow();
  return (
    <>
      <span className="text-t4" aria-hidden="true">
        ·
      </span>
      <time aria-hidden="true">{formatElapsed(now - since)}</time>
    </>
  );
}

export const TimelineRow = memo(function TimelineRow({ row }: { row: Row }) {
  const ctx = useRowCtx();
  switch (row.kind) {
    case 'user':
      return (
        <div className="ag-you">
          <MessageFiles attachments={row.attachments} />
          {row.text ? <div className="bubble">{row.text}</div> : null}
        </div>
      );
    case 'assistant':
      return (
        <div className="ag-say" data-answer={row.answer ? '' : undefined}>
          {row.text ? <Markdown text={row.text} streaming={row.streaming} /> : null}
          {row.blocks.map((b, i) => (
            <Result key={i} block={b} />
          ))}
          {row.answer && !row.streaming && row.text ? (
            <div className="ag-meta">
              <CopyText text={row.text} />
            </div>
          ) : null}
        </div>
      );
    case 'entry':
      return <EntryRow row={row} />;
    case 'group':
      return <GroupRow row={row} />;
    case 'fold':
      return <FoldRow row={row} />;
    case 'approval':
      return <div className="ag-approval">{ctx.renderApproval(row.approval)}</div>;
    case 'card':
      return (
        <div className="ag-card">
          <LiveCard card={row.card} />
        </div>
      );
    case 'plan':
      return (
        <ol className="cx-plan ag-plan" aria-label="Plan">
          {row.steps.map((s, i) => (
            <li key={i} data-status={s.status}>
              {s.text}
            </li>
          ))}
        </ol>
      );
    case 'error':
      return (
        <div className="ag-err" role="alert">
          <p>{row.message}</p>
          {ctx.onRetry && row.retryable && row.key === ctx.retryKey ? (
            <Button size="s" onClick={ctx.onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      );
    case 'end':
      return <p className="ag-end">{foldWords(row)}</p>;
    case 'live':
      return <LiveRow />;
    case 'follow':
      return (
        <div className="cx-follow ag-follow" role="list" aria-label="Follow-ups">
          {row.items.map((s) => (
            <button key={s.label} type="button" role="listitem" onClick={() => ctx.onFollowUp(s)}>
              {s.label}
            </button>
          ))}
        </div>
      );
    case 'notice':
      return <p className="ag-err ag-notice">{row.text}</p>;
    case 'tail':
      return <TailRow />;
  }
});
