import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import type { ToastAction, ToastQueue, ToastTone } from '../toast.ts';
import { EASE, MOTION } from '../tokens.ts';
import { prefersReducedMotion } from './DraftCard.tsx';
import { Icon, type IconName } from './Icon.tsx';

const TONE_ICON: Record<ToastTone, IconName> = { ok: 'done', info: 'note', err: 'attention' };

export interface ToastProps {
  tone?: ToastTone | 'hint';
  title: ReactNode;
  detail?: ReactNode;
  action?: Pick<ToastAction, 'label'> | null;
  onAction?: () => void;
  onDismiss?: () => void;
  state?: 'open' | 'closed';
  className?: string;
}

export function Toast({
  tone = 'ok',
  title,
  detail,
  action,
  onAction,
  onDismiss,
  state = 'open',
  className,
}: ToastProps) {
  const closed = state === 'closed';
  return (
    <div
      className={cx('t-toast', className)}
      data-tone={tone}
      data-state={state}
      role={tone === 'hint' ? undefined : tone === 'err' ? 'alert' : 'status'}
      onClick={
        onDismiss && !closed
          ? (e) => {
              if (!(e.target as Element).closest('button')) onDismiss();
            }
          : undefined
      }
    >
      {tone === 'hint' ? null : <Icon name={TONE_ICON[tone]} className="tone" />}
      <div className="body">
        <p className="tt">{title}</p>
        {detail ? <p className="dt">{detail}</p> : null}
      </div>
      {action ? (
        <button type="button" className="act" disabled={closed} onClick={onAction}>
          {action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <button type="button" className="x" aria-label="Dismiss" disabled={closed} onClick={onDismiss}>
          <Icon name="close" />
        </button>
      ) : null}
    </div>
  );
}

export function useToasts(queue: ToastQueue) {
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
}

export interface ToastStackProps {
  queue: ToastQueue;
  label: string;
  className?: string;
  children?: ReactNode;
}

export function ToastStack({ queue, label, className, children }: ToastStackProps) {
  const list = useToasts(queue);
  useEffect(() => () => queue.resume(), [queue]);
  const slots = useRef(new Map<number, HTMLElement>());
  const tops = useRef(new Map<number, number>());
  useLayoutEffect(() => {
    const next = new Map<number, number>();
    const still = prefersReducedMotion();
    for (const [id, el] of slots.current) {
      const top = el.getBoundingClientRect().top;
      next.set(id, top);
      const was = tops.current.get(id);
      if (!still && was !== undefined && Math.abs(was - top) >= 1 && typeof el.animate === 'function')
        el.animate([{ transform: `translateY(${String(was - top)}px)` }, { transform: 'none' }], {
          duration: MOTION.menuMs,
          easing: EASE.outStrong,
        });
    }
    tops.current = next;
  }, [list]);
  return (
    <div
      className={cx('t-toasts', className)}
      aria-label={label}
      data-empty={list.length === 0 && !children ? '' : undefined}
      onPointerEnter={() => queue.pause()}
      onPointerLeave={() => queue.resume()}
    >
      {list.map((t) => (
        <div
          key={t.id}
          className="t-toast-slot"
          data-state={t.state}
          ref={(el) => {
            if (el) slots.current.set(t.id, el);
            else slots.current.delete(t.id);
          }}
        >
          <Toast
            tone={t.tone}
            title={t.title}
            detail={t.detail}
            action={t.action}
            onAction={() => queue.act(t.id)}
            onDismiss={() => queue.dismiss(t.id)}
            state={t.state}
          />
        </div>
      ))}
      {children}
    </div>
  );
}
