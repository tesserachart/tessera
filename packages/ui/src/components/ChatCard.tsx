import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type ChatCardState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';
export type ChatCardMark = 'done' | 'partial' | 'missing' | 'running' | 'failed';

export interface ChatCardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  state: ChatCardState;
  meta?: ReactNode;
  progress?: ReactNode;
  detail?: ReactNode;
  detailLabel?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

export function ChatCard({
  title,
  state,
  meta,
  progress,
  detail,
  detailLabel = 'Details',
  actions,
  children,
  className,
  ...rest
}: ChatCardProps) {
  return (
    <section
      className={cx(
        'flex flex-col gap-1.5 py-2 px-3 border border-line border-l-2 border-l-line-2 bg-raise font-sans text-meta normal-nums text-t2',
        state === 'running' && 'border-l-mist-45',
        state === 'failed' && 'border-l-down-60',
        className,
      )}
      data-state={state}
      {...rest}
    >
      <header className="flex items-baseline gap-2 min-w-0">
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-body leading-(--text-meta--line-height) font-em normal-nums text-t1">
          {title}
        </span>
        {meta !== undefined ? <span className="flex-none ml-auto text-t3 tabular-nums">{meta}</span> : null}
      </header>
      {children !== undefined ? <div className="flex flex-col">{children}</div> : null}
      {progress !== undefined ? (
        <p className="m-0 pl-[22px] text-t2 tabular-nums" aria-live="polite">
          {progress}
        </p>
      ) : null}
      {detail !== undefined ? (
        <details className="group/detail">
          <summary className="inline-flex items-center gap-1 ml-[calc(22px-calc(var(--spacing)*1))] py-px px-1 list-none cursor-pointer text-t3 hover:text-t1 [&::-webkit-details-marker]:hidden after:content-['›'] after:[transition:transform_160ms_var(--ease-out)] group-open/detail:after:[transform:rotate(90deg)] motion-reduce:after:[transition:none]">
            {detailLabel}
          </summary>
          <div className="max-h-[240px] mt-1 ml-[22px] overflow-auto select-text text-t2 tabular-nums">{detail}</div>
        </details>
      ) : null}
      {actions !== undefined ? <div className="flex flex-wrap gap-1 pl-[18px]">{actions}</div> : null}
    </section>
  );
}

export interface ChatCardRowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  mark: ChatCardMark;
  label: ReactNode;
  value?: ReactNode;
  children?: ReactNode;
}

const MARK_LOOK: Record<ChatCardMark, string> = {
  done: 'border-t2 bg-t2',
  partial: 'border-t2 [box-shadow:inset_4px_0_0_var(--color-t2)]',
  missing: '',
  running: 'border-mist-70 border-t-transparent',
  failed: 'border-down-60',
};

const MARK_WORD: Record<ChatCardMark, string> = {
  done: 'all there',
  partial: 'some there',
  missing: 'none there',
  running: 'under way',
  failed: 'failed',
};

export function ChatCardRow({ mark, label, value, children, className, ...rest }: ChatCardRowProps) {
  return (
    <div
      className={cx(
        'grid grid-cols-[16px_minmax(0,auto)_minmax(0,1fr)] items-center gap-x-1.5 min-h-[22px]',
        className,
      )}
      data-mark={mark}
      {...rest}
    >
      <span
        className={cx('w-2 h-2 justify-self-center border border-t3 rounded-pill', MARK_LOOK[mark])}
        role="img"
        aria-label={MARK_WORD[mark]}
      />
      <span className="text-t1 whitespace-nowrap">{label}</span>
      {value !== undefined ? (
        <span className="[justify-self:end] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-t2 tabular-nums">
          {value}
        </span>
      ) : null}
      {children}
    </div>
  );
}
