import {
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cx } from '../cx.ts';
import { MOTION } from '../tokens.ts';
import type { EnvKind } from './Env.tsx';
import { ShownContext } from './Shown.ts';

export type ApproveState = 'arming' | 'armed' | 'approved' | 'refused' | 'disabled';

export interface ApproveLabel {
  l1: ReactNode;
  l2?: ReactNode;
}

export interface ApproveProps {
  env: EnvKind;
  envLabel: ReactNode;
  onApprove: () => void;
  disarmed?: ApproveLabel | null;
  refused?: ApproveLabel | null;
  approved?: ApproveLabel | null;
  armKey?: unknown;
  inline?: boolean;
  still?: { state: ApproveState; p?: number } | null;
  className?: string;
}

export interface ApproveHandle {
  focus: () => void;
}

export const Approve = forwardRef<ApproveHandle, ApproveProps>(function Approve(
  { env, envLabel, onApprove, disarmed, refused, approved, armKey, inline, still, className },
  ref,
) {
  const button = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  const [arming, setArming] = useState(0);
  const committed = useRef(false);
  const blocked = !!(disarmed ?? refused ?? approved);
  const shown = useContext(ShownContext);

  useImperativeHandle(ref, () => ({ focus: () => button.current?.focus() }), []);

  const rearm = useCallback(() => {
    setArmed(false);
    setArming((n) => n + 1);
  }, []);
  useEffect(() => {
    rearm();
    committed.current = false;
  }, [armKey, env, rearm]);
  useEffect(() => {
    if (!blocked) {
      committed.current = false;
      rearm();
    }
  }, [blocked, rearm]);
  useEffect(() => {
    if (armed || blocked || !shown) return;
    const t = setTimeout(() => setArmed(true), MOTION.armMs);
    return () => clearTimeout(t);
  }, [arming, armed, blocked, shown]);
  useEffect(() => {
    window.addEventListener('focus', rearm);
    return () => window.removeEventListener('focus', rearm);
  }, [rearm]);

  const live = armed && shown && !blocked && !still;
  const commit = useCallback(() => {
    if (committed.current) return;
    committed.current = true;
    onApprove();
  }, [onApprove]);
  const state: ApproveState = still
    ? still.state
    : approved
      ? 'approved'
      : refused
        ? 'refused'
        : disarmed
          ? 'disabled'
          : !armed || !shown
            ? 'arming'
            : 'armed';

  const label: ApproveLabel = approved ?? refused ?? disarmed ?? { l1: 'Approve', l2: envLabel };

  const onClick = () => {
    if (live) commit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ') e.preventDefault();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (live && !e.repeat) commit();
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ') e.preventDefault();
  };

  const p = still ? (still.p ?? 0) : 0;
  const inert = !!still || state !== 'armed';
  return (
    <button
      ref={button}
      type="button"
      tabIndex={-1}
      className={cx('t-approve', inline && 'inline', className)}
      data-state={state}
      data-press="none"
      aria-disabled={inert ? true : undefined}
      style={{ '--p': p } as CSSProperties}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      {state === 'arming' ? <span key={arming} className={still ? 'arm' : 'arm run'} /> : null}
      <span className="l1">{label.l1}</span>
      {label.l2 !== undefined ? <span className="l2">{label.l2}</span> : null}
    </button>
  );
});
