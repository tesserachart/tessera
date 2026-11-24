import type { HTMLAttributes } from 'react';
import { cx } from '../cx.ts';

export type DotState = 'ok' | 'degraded' | 'down' | 'off' | 'agent';

const LOOK: Record<DotState, string> = {
  ok: '',
  degraded:
    "relative overflow-hidden bg-transparent border border-t2 after:content-[''] after:absolute after:[inset:0_50%_0_0] after:bg-t2",
  down: 'bg-down',
  off: 'bg-transparent border border-t3',
  agent: 'bg-aqua',
};

const LABEL: Record<DotState, string> = {
  ok: 'ok',
  degraded: 'degraded',
  down: 'error',
  off: 'off',
  agent: 'running',
};

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  state: DotState;
}

export function StatusDot({ state, className, ...rest }: StatusDotProps) {
  return (
    <span
      role="img"
      aria-label={LABEL[state]}
      className={cx('inline-block w-[7px] h-[7px] rounded-[50%] flex-none bg-up', LOOK[state], className)}
      data-state={state}
      {...rest}
    />
  );
}
