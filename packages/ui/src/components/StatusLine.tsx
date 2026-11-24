import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Key } from './Key.tsx';

export type StatusKind = 'caution' | 'exposure' | 'mismatch' | 'receipt' | 'info';

const KIND: Record<StatusKind, string> = {
  caution: '',
  exposure: 'before:bg-brass',
  mismatch: 'before:bg-brass',
  receipt: 'before:bg-line-2',
  info: 'text-t2 before:bg-line-2',
};

export interface StatusLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  kind: StatusKind;
  src: ReactNode;
  fact?: ReactNode;
  exposure?: ReactNode;
  next?: ReactNode;
  more?: number;
  action?: { label: ReactNode; shortcut?: string; onClick: () => void } | null;
  band?: boolean;
  children?: ReactNode;
}

export function StatusLine({
  kind,
  src,
  fact,
  exposure,
  next,
  more,
  action,
  band,
  children,
  className,
  ...rest
}: StatusLineProps) {
  return (
    <div
      className={cx(
        "t-annun relative flex items-center gap-3 min-h-annun py-2 px-pad bg-ink text-t1 whitespace-nowrap before:content-[''] before:absolute before:left-0 before:right-0 before:top-0 before:h-px before:bg-t3 [&_.t-icon]:text-t2 [&_.t-icon]:-m-0.5",
        KIND[kind],
        band && 'whitespace-normal items-baseline flex-wrap gap-x-1.5 gap-y-0.5',
        className,
      )}
      data-kind={kind}
      role="status"
      {...rest}
    >
      <span className="src text-t1 font-em">{src}</span>
      {fact}
      {exposure !== undefined ? (
        <span className={kind === 'exposure' || kind === 'mismatch' ? 'text-brass' : undefined}>{exposure}</span>
      ) : null}
      {next !== undefined ? <span className="text-t2">{next}</span> : null}
      {more ? <span className="more text-t3">+{more}</span> : null}
      {action ? (
        <button
          type="button"
          className="do ml-auto inline-flex items-center gap-1.5 min-h-hit text-t2 font-em hover:text-t1"
          onClick={action.onClick}
        >
          {action.shortcut ? <Key shortcut={action.shortcut} className="text-t3" /> : null}
          {action.label}
        </button>
      ) : null}
      {children}
    </div>
  );
}
