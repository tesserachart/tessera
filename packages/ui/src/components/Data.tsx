import { Fragment, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { formatPrice } from '../format.ts';

export const PRICE_TEXT =
  't-price font-fig text-fig-row leading-none font-normal tabular-nums text-t1 whitespace-nowrap in-data-[trust=behind]:text-t3 in-data-[trust=stale]:text-t4-fig in-data-[trust=invalid]:text-t3 in-data-[trust=invalid]:[background:var(--hatch)]';

export const FIGURE_TEXT =
  't-figure font-fig text-figure normal-nums text-t1 in-data-[trust=behind]:text-t3 in-data-[trust=stale]:text-t4-fig in-data-[trust=invalid]:text-t3 in-data-[trust=invalid]:[background:var(--hatch)]';

export const FIGURE_CARD_TEXT = 't-figure-card font-fig text-fig-card font-normal normal-nums tracking-[-0.01em]';

export const META_TEXT = 'font-sans text-meta normal-nums text-t3';

export const STRONG_TEXT = 'font-sans text-strong normal-nums text-t1';

export interface PriceProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  value?: number | null;
  precision?: number;
  text?: ReactNode;
  size?: 'row' | 'l' | 's';
}

export function Price({ value, precision = 2, text, size = 'row', className, ...rest }: PriceProps) {
  return (
    <span
      className={cx(
        PRICE_TEXT,
        size === 'l' && 'text-fig-strong leading-none',
        size === 's' && 'text-fig-meta leading-none',
        className,
      )}
      {...rest}
    >
      {text ?? formatPrice(value, precision)}
    </span>
  );
}

export function Figure({ card, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { card?: boolean }) {
  return <span className={cx(card ? FIGURE_CARD_TEXT : FIGURE_TEXT, className)} {...rest} />;
}

export interface KvRow {
  label: ReactNode;
  value: ReactNode;
}

export interface KvProps extends Omit<HTMLAttributes<HTMLDListElement>, 'children'> {
  rows: readonly KvRow[];
}

export function Kv({ rows, className, ...rest }: KvProps) {
  return (
    <dl className={cx('grid grid-cols-[auto_minmax(0,1fr)] gap-x-4', className)} {...rest}>
      {rows.map((r, i) => (
        <Fragment key={i}>
          <dt className="h-row-kv flex items-center text-t3 whitespace-nowrap">{r.label}</dt>
          <dd data-selectable className="h-row-kv flex items-center justify-end gap-2 text-t1 whitespace-nowrap">
            {r.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Log({ seconds, className, ...rest }: HTMLAttributes<HTMLDivElement> & { seconds?: boolean }) {
  return <div className={cx('group/log flex flex-col', seconds && 'has-seconds', className)} role="log" {...rest} />;
}

export interface LogEntryProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  time: string;
  by?: 'analyst' | 'you' | 'sealed' | 'working';
  children: ReactNode;
  src?: ReactNode;
}

export function LogEntry({ time, by, children, src, className, ...rest }: LogEntryProps) {
  return (
    <div
      className={cx(
        'relative grid grid-cols-[44px_minmax(0,1fr)] group-[.has-seconds]/log:grid-cols-[64px_minmax(0,1fr)] py-1.5 px-pad text-t2 leading-[19px] [&_b]:text-t1 [&_b]:font-em',
        by === 'analyst' &&
          "before:content-[''] before:absolute before:left-[calc(var(--spacing-pad)-calc(var(--spacing)*3))] before:top-[calc(calc(var(--spacing)*1.5)+3px)] before:w-rule before:h-[13px] before:bg-aqua",
        by === 'you' && 'text-t3',
        className,
      )}
      {...rest}
    >
      <time className={cx('font-sans text-meta leading-[19px] tabular-nums text-t3', by === 'sealed' && 'text-t2')}>
        {time}
      </time>
      <span>
        {children}
        {src !== undefined ? (
          <span className="block mt-1 text-(length:--text-meta) text-t3 leading-[16px]">{src}</span>
        ) : null}
      </span>
    </div>
  );
}

export function LogFold({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <button
      type="button"
      className={cx(
        'block w-full text-left pr-pad pl-[calc(var(--spacing-pad)+44px)] py-1 text-(length:--text-meta) text-t3 hover:text-t2',
        className,
      )}
      {...rest}
    />
  );
}

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  label: ReactNode;
  figure: ReactNode;
  delta?: ReactNode;
  src?: ReactNode;
  focal?: boolean;
  weak?: boolean;
  children?: ReactNode;
}

export function Stat({ label, figure, delta, src, focal, weak, children, className, ...rest }: StatProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)} {...rest}>
      <span className="font-sans text-meta leading-none normal-nums text-t3">{label}</span>
      <span
        className={cx(
          'font-fig text-fig-card leading-none font-normal normal-nums tracking-[-0.01em] text-t1',
          focal && 'text-(length:--text-figure) leading-none',
          weak && 'text-t2',
        )}
      >
        {figure}
      </span>
      {delta !== undefined ? <span className="text-(length:--text-body) tabular-nums text-t1">{delta}</span> : null}
      {children}
      {src !== undefined ? <span className="font-sans text-meta normal-nums text-t3">{src}</span> : null}
    </div>
  );
}
