import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type TrustState = 'live' | 'quiet' | 'behind' | 'stale' | 'invalid';

export const TRUST_MS = {
  behind: 1000,
  disarm: 2000,
  stale: 3000,
} as const;

export interface TrustInput {
  lagMs?: number;
  silentMs?: number;
  quiet?: boolean;
  sourceDown?: boolean;
  staleAfterMs?: number;
}

export function trustOf({
  lagMs = 0,
  silentMs = 0,
  quiet = false,
  sourceDown = false,
  staleAfterMs = TRUST_MS.stale,
}: TrustInput): TrustState {
  if (sourceDown) return 'invalid';
  if (silentMs >= staleAfterMs) return 'stale';
  if (lagMs >= TRUST_MS.behind) return 'behind';
  return quiet ? 'quiet' : 'live';
}

export function trustDisarms(state: TrustState, lagMs = 0): boolean {
  if (state === 'stale' || state === 'invalid') return true;
  return state === 'behind' && lagMs >= TRUST_MS.disarm;
}

export interface TrustProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  trust: TrustState;
  children: ReactNode;
  age?: ReactNode;
}

export function Trust({ trust, children, age, className, ...rest }: TrustProps) {
  const shows = trust === 'behind' || trust === 'stale' || trust === 'invalid';
  return (
    <span className={cx('inline-flex flex-col items-start gap-1', className)} data-trust={trust} {...rest}>
      {children}
      {shows && age !== undefined ? (
        <span className="font-sans text-meta leading-none normal-nums text-t2 whitespace-nowrap">{age}</span>
      ) : null}
    </span>
  );
}
