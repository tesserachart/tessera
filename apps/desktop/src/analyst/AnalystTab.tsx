import { Count, formatElapsed } from '@tessera/ui';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useNow } from '../app/runtimeContext.ts';
import type { Activity } from './activity.ts';
import { TAB_MAX_PX, useAnalystStatus } from './status.ts';

function ElapsedTime({ since }: { since: number }) {
  const now = useNow();
  return (
    <>
      <span className="flex-none text-t3 tabular-nums" aria-hidden="true">
        ·
      </span>
      <time className="el">{formatElapsed(now - since)}</time>
    </>
  );
}

function ActivityWords({ activity }: { activity: Activity }) {
  if (!activity.words) return null;
  return (
    <span className="an-act" data-phase={activity.phase}>
      <span className="w">{activity.words}</span>
      {activity.since !== null ? <ElapsedTime since={activity.since} /> : null}
    </span>
  );
}

export function AnalystTab() {
  const { activity, count, unread } = useAnalystStatus();
  const el = useRef<HTMLSpanElement>(null);
  const turn = activity.phase === 'working' || activity.phase === 'waiting';
  const turnRef = useRef(turn);
  useLayoutEffect(() => {
    turnRef.current = turn;
    if (!turn && el.current) el.current.style.minWidth = '';
  }, [turn]);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!turnRef.current) return;
      const w = Math.min(TAB_MAX_PX, Math.ceil(node.getBoundingClientRect().width));
      if (w > (parseFloat(node.style.minWidth) || 0)) node.style.minWidth = `${String(w)}px`;
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return (
    <span className="an-tab" ref={el}>
      <span className="dock-tab-title">Analyst</span>
      <ActivityWords activity={activity} />
      <Count n={count} label={`${String(count)} need${count === 1 ? 's' : ''} you`} />
      {unread && count === 0 && !activity.words ? <i className="an-unread" role="img" aria-label="New answer" /> : null}
    </span>
  );
}

export function AnalystBadge() {
  const { count, unread } = useAnalystStatus();
  if (count > 0)
    return <Count n={count} className="an-strip-count absolute top-[3px] right-[3px] min-w-[13px] h-[13px] px-0.5" />;
  return unread ? <i className="an-unread an-strip-unread" aria-hidden="true" /> : null;
}
