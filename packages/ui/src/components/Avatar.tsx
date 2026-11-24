import type { HTMLAttributes } from 'react';
import { cx } from '../cx.ts';
import { Icon } from './Icon.tsx';

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  initial: string | null;
  size?: 's' | 'l';
}

export function Avatar({ initial, size = 's', className, ...rest }: AvatarProps) {
  return (
    <span
      className={cx(
        'grid place-items-center flex-none w-6 h-6 bg-mist-12 [box-shadow:inset_0_0_0_1px_var(--color-line-2)] text-inherit font-serif text-[17px] leading-none font-normal normal-nums',
        size === 'l' && 'w-12 h-12 text-[30px]',
        !initial && '[background:none] shadow-none',
        className,
      )}
      data-size={size}
      data-empty={initial ? undefined : ''}
      aria-hidden="true"
      {...rest}
    >
      {initial ? (
        <span className="[transform:translateY(1px)]">{initial}</span>
      ) : (
        <Icon name="you" className="text-inherit" />
      )}
    </span>
  );
}
