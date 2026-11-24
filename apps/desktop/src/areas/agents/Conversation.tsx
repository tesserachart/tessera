import type { Approval, Suggestion } from '@tessera/protocol';
import { Icon, ScrollArea, cx } from '@tessera/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import type { Transcript } from '../../app/agentTranscript.ts';
import { useTools } from '../../app/tools.ts';
import type { Activity } from '../../analyst/activity.ts';
import { registerApprovalScroller } from '../../analyst/focus.ts';
import { LiveCtx, RowCtx, TailCtx, type RowContext } from './rowContext.ts';
import { TimelineRow } from './Rows.tsx';
import { useOpenRows, toggleOpenRow } from './store.ts';
import { noteArrivals, stableRows, timelineRows, type Row } from './timeline.ts';
import { useClock } from '../../app/clock.ts';
import './agents.css';

const NO_NOTICES: readonly { key: string; text: string }[] = [];
const NONE_EXPIRED: readonly Approval[] = [];
const TAIL: Row = { kind: 'tail', key: 'tail' };

const AT_END_PX = 40;

const isDraft = (a: Approval) => a.kind === 'financial';

const pressedScrollbar = (target: EventTarget, viewport: HTMLElement | null) => !viewport?.contains(target as Node);

function estimate(row: Row | undefined): number {
  switch (row?.kind) {
    case 'user':
      return row.attachments.length > 0 ? 184 : 56;
    case 'assistant':
      return 96;
    case 'approval':
      return 220;
    case 'card':
      return 120;
    case 'entry':
    case 'group':
      return 28;
    case 'fold':
      return 36;
    default:
      return 36;
  }
}

export interface ConversationHandle {
  scrollToKey: (key: string) => void;
}

export function Conversation({
  sessionId,
  transcript,
  waiting,
  expired = NONE_EXPIRED,
  settled,
  working,
  activity,
  notices = NO_NOTICES,
  renderApproval,
  onFollowUp,
  onRetry,
  empty,
  narrow = false,
  handle,
  onOutOfView,
  tail,
}: {
  sessionId: string | null;
  transcript: Transcript | null;
  waiting: readonly Approval[];
  expired?: readonly Approval[];
  settled: boolean;
  working: boolean;
  activity: Activity;
  notices?: readonly { key: string; text: string }[];
  renderApproval: (a: Approval) => ReactNode;
  onFollowUp: (s: Suggestion) => void;
  onRetry?: (() => void) | undefined;
  empty?: ReactNode;
  narrow?: boolean;
  handle?: Ref<ConversationHandle>;
  onOutOfView?: (out: ReadonlyMap<string, 'above' | 'below'>) => void;
  tail?: ReactNode;
}) {
  const tools = useTools();
  const clock = useClock();
  const arrivals = useRef({ sessionId, seen: new Map<string, boolean>() });
  if (arrivals.current.sessionId !== sessionId) arrivals.current = { sessionId, seen: new Map() };
  const openKeys = useOpenRows(sessionId);
  const open = useMemo(() => new Set(openKeys), [openKeys]);
  const shared = useRef(new Map<string, Row>());
  const drafts = useMemo(() => waiting.filter(isDraft), [waiting]);
  const rows = useMemo(() => {
    const ended = new Set(expired.map((a) => a.id));
    const all = timelineRows({
      transcript,
      waiting,
      expired,
      settled,
      working,
      open,
      notices,
      shownApart: (a) => isDraft(a) && !ended.has(a.id),
    });
    const next = stableRows(shared.current, tail && all.length > 0 ? [...all, TAIL] : all);
    shared.current = new Map(next.map((r) => [r.key, r]));
    noteArrivals(arrivals.current.seen, next, transcript?.times ?? {}, clock.now());
    return next;
  }, [transcript, waiting, expired, settled, working, open, notices, tail, clock]);

  const retryKey = useMemo(() => {
    const items = transcript?.items ?? [];
    const lastAsk = items.findLastIndex((i) => i.kind === 'user');
    const lastErr = items.findLastIndex((i) => i.kind === 'error');
    return lastErr > lastAsk ? (items[lastErr]?.key ?? null) : null;
  }, [transcript]);

  const follow = useRef(true);
  const toggle = useCallback(
    (key: string) => {
      follow.current = false;
      if (sessionId) toggleOpenRow(sessionId, key);
    },
    [sessionId],
  );
  const ctx = useMemo<RowContext>(
    () => ({ toggle, renderApproval, onFollowUp, onRetry, retryKey, tools }),
    [toggle, renderApproval, onFollowUp, onRetry, retryKey, tools],
  );

  const viewport = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: (i) => estimate(rows[i]),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
    paddingStart: narrow ? 12 : 20,
    paddingEnd: narrow ? 16 : 28,
    useFlushSync: false,
  });

  const [away, setAway] = useState(false);
  const pin = useCallback(() => {
    const el = viewport.current;
    if (el && follow.current) el.scrollTop = rows.length === 0 ? 0 : el.scrollHeight;
  }, [rows.length]);
  const grew = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    if (follow.current) el.scrollTop = el.scrollHeight;
    else setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AT_END_PX);
  }, []);
  const leave = useCallback(() => {
    follow.current = false;
    const el = viewport.current;
    if (el) setAway(el.scrollHeight - el.scrollTop - el.clientHeight > AT_END_PX);
  }, []);
  const lastTop = useRef(0);

  const openOnNewest = useEffectEvent(() => {
    follow.current = true;
    setAway(false);
    if (rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  });
  useLayoutEffect(() => openOnNewest(), [sessionId]);
  useLayoutEffect(pin);
  const sizer = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(grew);
      ro.observe(el);
      return () => ro.disconnect();
    },
    [grew],
  );

  const items = virtualizer.getVirtualItems();
  const first = virtualizer.range?.startIndex ?? 0;
  const last = virtualizer.range?.endIndex ?? -1;
  const approvalAt = useMemo(
    () => rows.flatMap((r, i) => (r.kind === 'approval' ? [[r.approval.id, i] as const] : [])),
    [rows],
  );
  const outKey = approvalAt
    .filter(([, i]) => i < first || i > last)
    .map(([id, i]) => `${id}:${i < first ? 'above' : 'below'}`)
    .join(',');
  useEffect(() => {
    if (!onOutOfView) return;
    const out = new Map<string, 'above' | 'below'>();
    for (const part of outKey ? outKey.split(',') : []) {
      const at = part.lastIndexOf(':');
      out.set(part.slice(0, at), part.slice(at + 1) as 'above' | 'below');
    }
    onOutOfView(out);
  }, [onOutOfView, outKey]);

  useEffect(
    () =>
      registerApprovalScroller((id) => {
        const i = rows.findIndex((r) => r.kind === 'approval' && r.approval.id === id);
        if (i < 0) return;
        follow.current = false;
        virtualizer.scrollToIndex(i, { align: 'center' });
      }),
    [rows, virtualizer],
  );

  useImperativeHandle(
    handle,
    () => ({
      scrollToKey: (key) => {
        const i = rows.findIndex((r) => r.key === key);
        if (i < 0) return;
        follow.current = false;
        virtualizer.scrollToIndex(i, { align: 'center' });
      },
    }),
    [rows, virtualizer],
  );

  return (
    <div className={cx('ag-conv', narrow && 'is-narrow')}>
      <div className="ag-history">
        <ScrollArea
          className="ag-scroll"
          viewportRef={viewport}
          viewportClassName="ag-scroll-view"
          role="log"
          aria-label="Conversation"
          onWheelCapture={(e) => {
            if (e.deltaY < 0) leave();
          }}
          onTouchMoveCapture={leave}
          onKeyDownCapture={(e) => {
            if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) requestAnimationFrame(leave);
          }}
          onPointerDownCapture={(e) => {
            if (pressedScrollbar(e.target, viewport.current)) requestAnimationFrame(leave);
          }}
          onScrollCapture={() => {
            const el = viewport.current;
            if (!el) return;
            const down = el.scrollTop > lastTop.current;
            lastTop.current = el.scrollTop;
            if (follow.current) return;
            const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_END_PX;
            if (atEnd && down) {
              follow.current = true;
              setAway(false);
            } else setAway(!atEnd);
          }}
        >
          {rows.length === 0 && empty ? (
            <div className="ag-empty">{empty}</div>
          ) : (
            <RowCtx.Provider value={ctx}>
              <LiveCtx.Provider value={activity}>
                <TailCtx.Provider value={tail ?? null}>
                  <div ref={sizer} className="ag-rows" data-selectable style={{ height: virtualizer.getTotalSize() }}>
                    {items.map((vi) => {
                      const row = rows[vi.index];
                      if (!row) return null;
                      return (
                        <div
                          key={vi.key}
                          data-index={vi.index}
                          ref={virtualizer.measureElement}
                          className="ag-row"
                          data-kind={row.kind}
                          data-history={arrivals.current.seen.get(row.key) ? undefined : ''}
                          style={{ transform: `translateY(${String(vi.start)}px)` }}
                        >
                          <div className="ag-lane">
                            <TimelineRow row={row} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </TailCtx.Provider>
              </LiveCtx.Provider>
            </RowCtx.Provider>
          )}
        </ScrollArea>
        {away ? (
          <button
            type="button"
            className="ag-to-end"
            onClick={() => {
              follow.current = true;
              setAway(false);
              const el = viewport.current;
              el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }}
          >
            <Icon name="jump-down" />
            <span>Latest</span>
          </button>
        ) : null}
      </div>
      {drafts.length > 0 ? (
        <div className="ag-waiting" role="region" aria-label="Waiting drafts">
          <div className="ag-lane">
            {drafts.map((approval) => (
              <div key={approval.id} className="ag-approval">
                {renderApproval(approval)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
