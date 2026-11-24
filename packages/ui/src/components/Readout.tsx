import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';
import type { Tone } from '../format.ts';
import { PRICE_TEXT } from './Data.tsx';

export interface ReadoutProps extends Omit<HTMLAttributes<HTMLDListElement>, 'children'> {
  label?: string;
  children?: ReactNode;
}

export function Readout({ label, className, children, ...rest }: ReadoutProps) {
  return (
    <dl className={cx('t-readout', className)} aria-label={label} {...rest}>
      {children}
    </dl>
  );
}

export interface ReadoutRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  value: ReactNode;
  tone?: Tone | null;
  note?: ReactNode;
  noteBinds?: boolean;
  quiet?: boolean;
}

export function ReadoutRow({
  label,
  value,
  tone,
  note,
  noteBinds = false,
  quiet = false,
  className,
  ...rest
}: ReadoutRowProps) {
  return (
    <div className={cx('t-readout-row', className)} {...rest}>
      <dt>{label}</dt>
      <dd>
        {note !== undefined && note !== null ? (
          <span className={cx('note', PRICE_TEXT)} data-binds={noteBinds || undefined}>
            {note}
          </span>
        ) : null}
        <span
          className={cx('v', !quiet && PRICE_TEXT, quiet && 'is-quiet')}
          data-tone={tone && tone !== 'flat' ? tone : undefined}
        >
          {value}
        </span>
      </dd>
    </div>
  );
}
