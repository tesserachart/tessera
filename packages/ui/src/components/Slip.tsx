import { Fragment, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { PRICE_TEXT } from './Data.tsx';

export type SlipState =
  | 'draft'
  | 'staged'
  | 'working'
  | 'moving'
  | 'cancelling'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'unconfirmed'
  | 'expired';

const EDGE: Record<SlipState, string> = {
  draft: 'before:[border-left:var(--spacing-rule)_dashed_var(--color-aqua)] before:border-aqua',
  staged: 'before:[border-left:var(--spacing-rule)_dashed_var(--color-mist)] before:border-mist',
  working: 'before:[border-left:var(--spacing-rule)_solid_var(--color-mist)] before:border-mist',
  moving: 'before:[border-left:var(--spacing-rule)_dotted_var(--color-mist)] before:border-mist',
  cancelling: 'before:[border-left:var(--spacing-rule)_dotted_var(--color-mist)] before:border-mist',
  filled: 'before:[border:0] before:w-1.5 before:h-1.5 before:top-4 before:-left-0.5 before:bg-mist',
  cancelled: 'before:[border-left:var(--spacing-rule)_solid_var(--color-t4)] before:border-t4',
  rejected: 'before:[border-left:var(--spacing-rule)_solid_var(--color-t3)] before:border-t3',
  unconfirmed:
    'before:[border:1px_solid_var(--color-t2)] before:w-1.5 before:h-1.5 before:top-4 before:-left-0.5 before:bg-transparent',
  expired: 'before:[border-left:var(--spacing-rule)_dashed_var(--color-t4)] before:border-t4',
};

export interface SlipPart {
  w?: ReactNode;
  price?: ReactNode;
  was?: ReactNode;
  text?: ReactNode;
}

export interface SlipProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  state: SlipState;
  verb: ReactNode;
  parts?: readonly SlipPart[];
  env?: ReactNode;
  status: ReactNode;
  statusMore?: ReactNode;
  rule?: { text: ReactNode; block?: boolean; act?: ReactNode } | null;
  progress?: number;
}

export function Slip({
  state,
  verb,
  parts = [],
  env,
  status,
  statusMore,
  rule,
  progress,
  className,
  style,
  ...rest
}: SlipProps) {
  const tail = env !== undefined ? [{ env }] : [];
  const pieces: ({ part: SlipPart } | { env: ReactNode })[] = [...parts.map((part) => ({ part })), ...tail];
  const gone = state === 'cancelled' || state === 'expired';
  return (
    <div
      className={cx(
        "relative grid grid-cols-[minmax(0,1fr)_var(--slip-state-w,184px)] items-baseline gap-x-4 py-2 pr-0 pl-3 text-t2 before:content-[''] before:absolute before:left-0 before:top-2 before:bottom-2 before:w-0 [&_.t-price]:text-(length:--text-fig-strong)",
        EDGE[state],
        gone && 'text-t3 [&_.t-price]:text-t4-fig',
        state === 'rejected' && '[&_.t-price]:text-t3',
        className,
      )}
      data-state={state}
      style={progress !== undefined ? ({ ...style, '--p': progress } as CSSProperties) : style}
      {...rest}
    >
      <span
        className={cx(
          'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 leading-[22px]',
          state === 'rejected' && 'line-through decoration-t3 text-t3',
        )}
      >
        <span
          className={cx(
            'font-sans text-strong leading-none normal-nums text-t1',
            (gone || state === 'rejected') && 'text-t3',
          )}
        >
          {verb}
        </span>
        {pieces.map((piece, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="text-t4">·</span> : null}
            {'env' in piece ? (
              <span className="text-t2">{piece.env}</span>
            ) : (
              <>
                {piece.part.w !== undefined ? (
                  <span className={gone ? 'text-t4-fig' : 'text-t3'}>{piece.part.w}</span>
                ) : null}
                {piece.part.was !== undefined ? (
                  <span
                    className={cx(
                      'text-t4-fig line-through decoration-1',
                      state === 'moving' && 'text-(length:--text-fig-strong) font-fig',
                    )}
                  >
                    {piece.part.was}
                  </span>
                ) : null}
                {piece.part.price !== undefined ? <span className={PRICE_TEXT}>{piece.part.price}</span> : null}
                {piece.part.text}
              </>
            )}
          </Fragment>
        ))}
      </span>
      <span
        className={cx(
          'font-sans text-meta leading-none font-em normal-nums text-t2 whitespace-nowrap text-right',
          state === 'draft' && 'text-aqua',
          (state === 'filled' || state === 'unconfirmed') && 'text-t1',
        )}
      >
        {status}
        {statusMore !== undefined ? (
          <span className={state === 'draft' ? 'text-t2' : undefined}> {statusMore}</span>
        ) : null}
      </span>
      {rule ? (
        <span
          className={cx(
            'col-span-full mt-1.5 text-(length:--text-meta) text-t3',
            rule.block && 'text-brass pl-2 [box-shadow:inset_var(--spacing-rule)_0_0_var(--color-brass)]',
            state === 'rejected' && 'text-t1',
          )}
        >
          {rule.text}
          {rule.act !== undefined ? <span className="text-t1 font-em ml-1.5">{rule.act}</span> : null}
        </span>
      ) : null}
      {progress !== undefined ? (
        <span
          className="absolute left-3 bottom-1 h-px w-[calc(var(--p,0.5)*(100%-calc(var(--spacing)*3)))] bg-t2"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );
}
