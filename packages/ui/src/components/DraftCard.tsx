import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from '../cx.ts';
import { MOTION } from '../tokens.ts';
import { Approve, type ApproveHandle, type ApproveLabel, type ApproveState } from './Approve.tsx';
import { FIGURE_CARD_TEXT, PRICE_TEXT } from './Data.tsx';
import type { EnvKind } from './Env.tsx';
import { Mark, type MarkState } from './Mark.tsx';
import { useShown } from './Shown.ts';

export function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function easeOut(t: number): number {
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * 0.2 + 3 * (1 - u) * u * u * 0 + u * u * u;
  const by = (u: number) => 3 * (1 - u) * u * u * 1 + u * u * u;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

interface Moment {
  mark: MarkState;
  p: number;
  seam: boolean;
}

function useApproveMoment(onSettled?: () => void) {
  const [m, setM] = useState<Moment>({ mark: 'draft', p: 0, seam: false });
  const raf = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  }, [onSettled]);
  const clear = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clear, [clear]);

  const tween = useCallback((ms: number, f: (p: number) => void, done: () => void) => {
    if (prefersReducedMotion() || ms <= 0) {
      f(1);
      done();
      return;
    }
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / ms);
      f(p);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else {
        raf.current = null;
        done();
      }
    };
    raf.current = requestAnimationFrame(step);
  }, []);
  const after = useCallback((ms: number, f: () => void) => {
    timers.current.push(setTimeout(f, prefersReducedMotion() ? 0 : ms));
  }, []);

  const seal = useCallback(() => {
    setM({ mark: 'level', p: 1, seam: true });
    tween(
      MOTION.seamMs,
      (p) => setM({ mark: 'lit', p, seam: true }),
      () =>
        after(MOTION.litMs, () =>
          tween(
            MOTION.drainMs,
            (p) => setM({ mark: 'drain', p, seam: true }),
            () => {
              setM({ mark: 'rest', p: 0, seam: true });
              settled.current?.();
            },
          ),
        ),
    );
  }, [after, tween]);

  const clickRise = useCallback(() => {
    tween(MOTION.riseMs, (p) => setM({ mark: 'rise', p: easeOut(p), seam: false }), seal);
  }, [seal, tween]);
  return { moment: m, clickRise };
}

export interface DraftRow {
  label: ReactNode;
  price?: ReactNode;
  text?: ReactNode;
  value?: ReactNode;
  wide?: boolean;
}

export interface DraftCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  env: EnvKind;
  account: ReactNode;
  plan?: ReactNode;
  left?: ReactNode;
  order: ReactNode;
  pre?: ReactNode;
  price?: ReactNode;
  post?: ReactNode;
  was?: ReactNode;
  distance?: ReactNode;
  distanceWide?: ReactNode;
  rows?: readonly DraftRow[];
  sum?: ReactNode;
  room?: { text: ReactNode; block?: boolean; fit?: ReactNode } | null;
  by?: { text: ReactNode; off?: boolean } | null;
  envLabel: ReactNode;
  disarmed?: ApproveLabel | null;
  refused?: ApproveLabel | null;
  expired?: ApproveLabel | null;
  approved?: { at: ReactNode; l2?: ReactNode; sending?: ReactNode } | null;
  armKey?: unknown;
  typed?: boolean;
  typedBy?: ReactNode;
  onApprove: () => void;
  onEdit?: () => void;
  onReject?: () => void;
  onRedraft?: () => void;
  onSettled?: () => void;
  still?: { approve: { state: ApproveState; p?: number }; mark?: { state: MarkState; p?: number }; seam?: number };
}

export function DraftCard({
  env,
  account,
  plan,
  left,
  order,
  pre = 'at',
  price,
  post,
  was,
  distance,
  distanceWide,
  rows = [],
  sum,
  room,
  by,
  envLabel,
  disarmed,
  refused,
  expired,
  approved,
  armKey,
  typed,
  typedBy,
  onApprove,
  onEdit,
  onReject,
  onRedraft,
  onSettled,
  still,
  className,
  onKeyDown,
  ...rest
}: DraftCardProps) {
  const approveRef = useRef<ApproveHandle>(null);
  const shown = useShown();
  const actRef = useRef<HTMLDivElement>(null);
  const { moment, clickRise } = useApproveMoment(onSettled);

  const commit = () => {
    onApprove();
    if (!typed) clickRise();
  };

  const state = approved ? 'approved' : expired ? 'expired' : refused ? 'refused' : 'armed';
  const settledLit = !!approved && moment.mark === 'draft';
  const markState: MarkState = still?.mark?.state ?? (expired ? 'rest' : settledLit ? 'lit' : moment.mark);
  const markP = still?.mark ? (still.mark.p ?? 0) : settledLit ? 1 : moment.p;
  const seamLit = still?.seam ?? (settledLit ? 1 : 0);

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const quiet = [...(actRef.current?.querySelectorAll<HTMLButtonElement>('button.quiet') ?? [])];
    const at = quiet.indexOf(document.activeElement as HTMLButtonElement);
    const onApproveBtn = document.activeElement?.classList.contains('t-approve') ?? false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.target === e.currentTarget) approveRef.current?.focus();
      else if (onApproveBtn) quiet[0]?.focus();
      else if (at >= 0) quiet[at + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at > 0) quiet[at - 1]?.focus();
      else if (at === 0) approveRef.current?.focus();
      else if (onApproveBtn) e.currentTarget.focus();
    }
  };

  const head = approved ? (
    <>
      {typed ? null : <Mark size={24} state={markState} p={markP} />}
      <b>Approved by you</b>
      <span className="r">
        <span className="t-num tabular-nums whitespace-nowrap">{approved.at}</span>
      </span>
    </>
  ) : typed ? (
    <>
      <b>{account}</b>
      {typedBy ? <span>{typedBy}</span> : null}
      {left ? (
        <span className="r">
          <span className="t-num tabular-nums whitespace-nowrap">{left}</span>
        </span>
      ) : null}
    </>
  ) : (
    <>
      <Mark size={24} state={markState} p={markP} />
      <b>Draft</b>
      {plan ? <span className="plan">{plan}</span> : null}
      <span className="r">
        <span>{account}</span>
        {left ? (
          <>
            <span className="t-sep text-t4">·</span>
            <span className="t-num tabular-nums whitespace-nowrap">{left}</span>
          </>
        ) : null}
      </span>
    </>
  );

  return (
    <div
      className={cx('t-draft', typed && 'is-typed', className)}
      data-state={state}
      tabIndex={0}
      role="group"
      aria-label={typed ? 'Ticket' : 'Draft'}
      onKeyDown={onCardKey}
      {...rest}
    >
      <div className="t-draft-head">{head}</div>
      <div className="t-card">
        <div className="prop">
          <div className="o">{order}</div>
          {price !== undefined ? (
            <div className="o2">
              {pre}
              <span className={FIGURE_CARD_TEXT}>{price}</span>
              {was !== undefined ? <span className="was">{was}</span> : null}
              {post !== undefined ? <span className="lt">{post}</span> : null}
            </div>
          ) : null}
          {distance !== undefined ? (
            <div className="dist">
              {distance}
              {distanceWide !== undefined ? <span className="wide">{distanceWide}</span> : null}
            </div>
          ) : null}
          {rows.length ? (
            <div className="kv">
              {rows.map((r, i) => (
                <DraftKv key={i} row={r} />
              ))}
            </div>
          ) : null}
          {sum !== undefined ? <div className="sum">{sum}</div> : null}
          {room ? (
            <div className={cx('room', room.block && 'is-block')}>
              {room.text}
              {room.fit !== undefined ? <span className="fit">{room.fit}</span> : null}
            </div>
          ) : null}
          {by ? <div className={cx('by', by.off && 'is-off')}>{by.text}</div> : null}
        </div>
        {typed ? null : (
          <div
            className={cx('t-seam', moment.seam && 'run')}
            style={{ '--seam': seamLit, '--dur-rise': '0ms' } as CSSProperties}
            aria-hidden="true"
          >
            <span />
            <span className="lit" />
          </div>
        )}
        <div className="act" ref={actRef}>
          <Approve
            key={shown ? 'shown' : 'hidden'}
            ref={approveRef}
            env={env}
            envLabel={envLabel}
            armKey={armKey}
            disarmed={expired ?? disarmed}
            refused={refused}
            approved={approved ? { l1: typed ? 'Sent' : 'Approved', l2: approved.l2 ?? envLabel } : null}
            onApprove={commit}
            still={still?.approve}
          />
          {approved ? (
            approved.sending !== undefined ? (
              <div className="sending">{approved.sending}</div>
            ) : null
          ) : (
            <>
              {expired ? (
                onRedraft ? (
                  <button type="button" className="quiet" onClick={onRedraft}>
                    Redraft
                  </button>
                ) : null
              ) : onEdit ? (
                <button type="button" className="quiet" onClick={onEdit}>
                  Edit
                </button>
              ) : null}
              {onReject ? (
                <button type="button" className="quiet" onClick={onReject}>
                  {expired ? 'Dismiss' : typed ? 'Discard' : 'Reject'}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftKv({ row }: { row: DraftRow }) {
  const wide = row.wide ? 'af' : undefined;
  return (
    <>
      <span className={wide}>{row.label}</span>
      {row.price !== undefined ? (
        <span className={PRICE_TEXT}>{row.price}</span>
      ) : (
        <span className={cx('x', wide)}>{row.text}</span>
      )}
      <span className="y">{row.value}</span>
    </>
  );
}

export interface AuditLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  act: ReactNode;
  at: ReactNode;
  answer?: { state: 'sending' | 'working' | 'filled' | 'rejected' | 'unconfirmed'; text: ReactNode; progress?: number };
}

export function AuditLine({ act, at, answer, className, style, ...rest }: AuditLineProps) {
  return (
    <div
      className={cx('t-audit', className)}
      data-state={answer?.state}
      style={answer?.progress !== undefined ? ({ ...style, '--p': answer.progress } as CSSProperties) : style}
      {...rest}
    >
      <div className="a1">
        <i className="t-halftile is-closed" aria-hidden="true" />
        <span>{act}</span>
        <time>{at}</time>
      </div>
      {answer ? <div className="a2">{answer.text}</div> : null}
    </div>
  );
}
