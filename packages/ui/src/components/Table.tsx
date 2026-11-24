import {
  forwardRef,
  type HTMLAttributes,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
  type TableHTMLAttributes,
} from 'react';
import { cx, flag } from '../cx.ts';
import { PRICE_TEXT } from './Data.tsx';
import { formatInt, formatMoney, formatPercent, formatPrice, formatSigned, formatVolume, toneOf } from '../format.ts';

const TABLE = [
  'w-full [border-collapse:collapse]',
  '[&_th]:h-7 [&_th]:px-3 [&_th]:text-left [&_th]:font-sans [&_th]:text-meta [&_th]:leading-none [&_th]:normal-nums [&_th]:text-t3 [&_th]:border-b [&_th]:border-b-line-2 [&_th]:whitespace-nowrap',
  '[&_td]:h-row [&_td]:px-3 [&_td]:text-t2 [&_td]:whitespace-nowrap',
  '[&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0',
  '[&_.n]:text-right [&_.n]:tabular-nums [&_td.p]:text-right [&_td_b]:text-t1 [&_td_b]:font-em',
  '[&_td.up]:text-up [&_td.down]:text-down [&_td.t1]:text-t1 [&_td.t3]:text-t3',
  '[&_tbody_tr:hover_td]:bg-raise [&_tr.is-on_td:not(.t3)]:text-t1',
  '[&_tr.is-on_td:first-child]:[box-shadow:inset_var(--spacing-rule)_0_0_var(--color-mist)] [&_tr.is-on_td:first-child]:pl-3',
  '[&_tr.grp_td]:h-9 [&_tr.grp_td]:pt-2 [&_tr.grp_td]:text-t1 [&_tr.grp_td]:font-strong [&_tr.grp_td]:text-(length:--text-strong)',
  '[&_tr.grp+tr_td]:border-t-0 [&_tr.gap_td]:border-t-0 [&_tbody_tr.grp:not(:first-child)_td]:border-t [&_tbody_tr.grp:not(:first-child)_td]:border-t-line',
  '[&_tbody_tr:hover]:[--t3:var(--color-t3-raised)] [&_tbody_tr:hover]:[--color-t3:var(--color-t3-raised)] [&_tr.is-on]:[--t3:var(--color-t3-raised)] [&_tr.is-on]:[--color-t3:var(--color-t3-raised)]',
].join(' ');

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(function Table(
  { className, ...rest },
  ref,
) {
  return <table ref={ref} className={cx(TABLE, className)} {...rest} />;
});

export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  total?: boolean;
}

export function Tr({ selected, total, className, ...rest }: TrProps) {
  return (
    <tr
      className={cx(selected && 'is-on', className)}
      data-selected={flag(selected)}
      data-total={flag(total)}
      aria-selected={selected}
      {...rest}
    />
  );
}

export function TGroup({
  children,
  colSpan,
  className,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { colSpan: number }) {
  return (
    <tr className={cx('grp', className)} {...rest}>
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right';
}

export function Th({ align = 'left', className, ...rest }: ThProps) {
  return <th scope="col" className={cx(align === 'right' && 'n', className)} {...rest} />;
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right';
}

export function Td({ align = 'left', className, ...rest }: TdProps) {
  return <td className={cx(align === 'right' && 'n', className)} {...rest} />;
}

export type NumberKind = 'price' | 'signed' | 'money' | 'pnl' | 'percent' | 'volume' | 'int';

export interface NumberFormatProps {
  value: number | null | undefined;
  kind?: NumberKind;
  precision?: number;
  tone?: 'sign' | 'none' | 'up' | 'down' | 'muted';
  currency?: string;
}

function formatNumber({ value, kind = 'price', precision, currency }: NumberFormatProps): string {
  switch (kind) {
    case 'price':
      return formatPrice(value, precision ?? 2);
    case 'signed':
      return formatSigned(value, precision ?? 2, true);
    case 'money':
      return formatMoney(value, { currency });
    case 'pnl':
      return formatMoney(value, { signed: true, currency });
    case 'percent':
      return formatPercent(value, precision ?? 2);
    case 'volume':
      return formatVolume(value);
    case 'int':
      return formatInt(value);
  }
}

function resolveTone({ value, kind = 'price', tone }: NumberFormatProps): string | undefined {
  const t = tone ?? (kind === 'signed' || kind === 'pnl' || kind === 'percent' ? 'sign' : 'none');
  if (t === 'none') return undefined;
  if (t === 'sign') {
    const s = toneOf(value);
    return s === 'flat' ? undefined : s;
  }
  return t;
}

export type NumProps = NumberFormatProps & Omit<HTMLAttributes<HTMLSpanElement>, 'children'>;

export function Num({ value, kind, precision, tone, currency, className, ...rest }: NumProps) {
  const fmtProps: NumberFormatProps = { value, kind, precision, tone, currency };
  return (
    <span
      className={cx(
        'tabular-nums whitespace-nowrap data-[tone=up]:text-up data-[tone=down]:text-down data-[tone=muted]:text-t3',
        className,
      )}
      data-tone={resolveTone(fmtProps)}
      {...rest}
    >
      {formatNumber(fmtProps)}
    </span>
  );
}

export type NumberCellProps = NumberFormatProps & Omit<TdHTMLAttributes<HTMLTableCellElement>, 'children'>;

export function NumberCell({ value, kind = 'price', precision, tone, currency, className, ...rest }: NumberCellProps) {
  const fmtProps: NumberFormatProps = { value, kind, precision, tone, currency };
  const t = resolveTone(fmtProps);
  const text = formatNumber(fmtProps);
  if (kind === 'price') {
    return (
      <td className={cx('p', className)} data-tone={t} {...rest}>
        <span className={cx(PRICE_TEXT, t === 'muted' && 'text-t3')}>{text}</span>
      </td>
    );
  }
  return (
    <td
      className={cx('n', t === 'up' || t === 'down' ? t : t === 'muted' ? 't3' : undefined, className)}
      data-tone={t}
      {...rest}
    >
      {text}
    </td>
  );
}
