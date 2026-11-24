import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { PRICE_TEXT } from './Data.tsx';

export type PlanState = 'proposed' | 'amended' | 'armed' | 'triggered' | 'noroom' | 'stopped' | 'void' | 'expired';

export interface PlanStripProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'id'> {
  name: ReactNode;
  side: ReactNode;
  trigger: ReactNode;
  state: PlanState;
  status: ReactNode;
  away?: ReactNode;
  go?: { label: ReactNode; onClick: () => void } | null;
}

export function PlanStrip({ name, side, trigger, state, status, away, go, className, ...rest }: PlanStripProps) {
  return (
    <div
      className={cx(
        'grid grid-cols-[58px_44px_minmax(0,1fr)_auto] max-[1600px]:grid-cols-[52px_40px_minmax(0,1fr)_auto] items-baseline gap-x-3 max-[1600px]:gap-x-2 h-8 px-pad text-t2 whitespace-nowrap [&_.t-price]:text-(length:--text-fig-row)',
        '[&_.accept]:inline-block [&_.accept]:py-2 [&_.accept]:px-1 [&_.accept]:-my-2 [&_.accept]:-mr-1 [&_.accept]:ml-0 [&_.accept]:text-t1 [&_.accept]:font-em',
        (state === 'proposed' || state === 'void' || state === 'expired' || state === 'stopped') && 'text-t3',
        state === 'proposed' && '[&_.t-price]:text-t3',
        (state === 'void' || state === 'expired') && '[&_.t-price]:text-t4-fig',
        className,
      )}
      data-state={state}
      {...rest}
    >
      <span
        className={cx(
          'font-sans text-strong leading-none normal-nums text-t1',
          (state === 'proposed' || state === 'stopped') && 'text-t3',
        )}
      >
        {name}
      </span>
      <span>{side}</span>
      <span>{trigger}</span>
      <span
        className={cx(
          'font-sans text-meta leading-none font-em normal-nums text-t2 text-right [&_a]:text-aqua [&_a]:ml-2 [&_a]:no-underline',
          state === 'triggered' && 'text-aqua',
          state === 'noroom' && 'text-brass',
        )}
      >
        {status}
        {away !== undefined ? <span className="max-[1600px]:hidden"> · {away}</span> : null}
        {go ? (
          <button type="button" className="text-aqua ml-2 no-underline font-[inherit]" onClick={go.onClick}>
            {go.label}
          </button>
        ) : null}
      </span>
    </div>
  );
}

export interface NowLineProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  price: ReactNode;
  away?: ReactNode;
}

export function NowLine({ price, away, className, ...rest }: NowLineProps) {
  return (
    <div
      className={cx(
        "flex items-center gap-3 h-5 px-pad font-sans text-meta leading-none normal-nums text-t3 whitespace-nowrap after:content-[''] after:flex-1 after:h-px after:bg-line-2 after:order-1",
        className,
      )}
      {...rest}
    >
      now <span className={cx(PRICE_TEXT, 'text-fig-meta leading-none text-t2')}>{price}</span>
      {away !== undefined ? <span className="hidden order-2 text-t2 max-[1600px]:inline">{away}</span> : null}
    </div>
  );
}
