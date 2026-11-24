import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cx } from '../cx.ts';

export interface SwitchProps extends Omit<ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'children'> {
  children?: ReactNode;
  label?: string;
}

export function Switch({ children, label, className, disabled, ...rest }: SwitchProps) {
  const control = (
    <SwitchPrimitive.Root
      className={cx('t-switch', !children && className)}
      aria-label={label}
      disabled={disabled}
      {...rest}
    >
      <SwitchPrimitive.Thumb className="thumb" />
    </SwitchPrimitive.Root>
  );
  if (!children) return control;
  return (
    <label className={cx('t-switch-row', disabled && 'is-disabled', className)}>
      {control}
      <span className="w">{children}</span>
    </label>
  );
}
