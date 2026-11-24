import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon, iconLabel, type IconName } from './Icon.tsx';
import { Key } from './Key.tsx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'secondary' | 'primary' | 'quiet' | 'destructive';
  size?: 'md' | 's';
  shortcut?: string;
  what?: ReactNode;
  icon?: IconName;
}

const BUTTON =
  'inline-flex items-center justify-center gap-2 h-control px-4 font-sans text-body leading-none font-strong normal-nums text-t1 border border-line-3 whitespace-nowrap [transition:background-color_var(--dur-hover)_linear,color_var(--dur-hover)_linear,border-color_var(--dur-hover)_linear,scale_var(--dur-press)_var(--ease-out-strong)] focus-visible:shadow-ring [&.is-focus]:shadow-ring disabled:text-t4 disabled:border-line disabled:cursor-default [&.is-disabled]:text-t4 [&.is-disabled]:border-line [&.is-disabled]:cursor-default';

const PLAIN =
  'bg-transparent hover:bg-raise [&.is-hover]:bg-raise active:bg-panel [&.is-press]:bg-panel disabled:bg-transparent [&.is-disabled]:bg-transparent';

const VARIANT = {
  secondary: PLAIN,
  primary:
    'bg-teal border-teal text-on-petrol hover:bg-[color-mix(in_oklab,var(--color-teal)_84%,var(--color-dim))] hover:border-[color-mix(in_oklab,var(--color-teal)_84%,var(--color-dim))] [&.is-hover]:bg-[color-mix(in_oklab,var(--color-teal)_84%,var(--color-dim))] [&.is-hover]:border-[color-mix(in_oklab,var(--color-teal)_84%,var(--color-dim))] active:bg-[color-mix(in_oklab,var(--color-teal)_68%,var(--color-dim))] active:border-[color-mix(in_oklab,var(--color-teal)_68%,var(--color-dim))] [&.is-press]:bg-[color-mix(in_oklab,var(--color-teal)_68%,var(--color-dim))] [&.is-press]:border-[color-mix(in_oklab,var(--color-teal)_68%,var(--color-dim))] disabled:bg-raise disabled:border-raise disabled:text-t4 [&.is-disabled]:bg-raise [&.is-disabled]:border-raise [&.is-disabled]:text-t4',
  quiet:
    'bg-transparent border-transparent text-t2 px-2 font-em hover:bg-transparent hover:text-t1 [&.is-hover]:bg-transparent [&.is-hover]:text-t1 [&:active:not(:hover)]:bg-panel [&.is-press]:bg-panel disabled:bg-transparent disabled:border-transparent [&.is-disabled]:bg-transparent [&.is-disabled]:border-transparent',
  destructive: cx(
    PLAIN,
    'border-t3 text-t1 disabled:border-t3 disabled:text-t1 [&.is-disabled]:border-t3 [&.is-disabled]:text-t1',
  ),
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', shortcut, what, icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        't-btn',
        BUTTON,
        VARIANT[variant],
        size === 's' && 'h-control-s px-3',
        icon && !children && 'w-control p-0',
        className,
      )}
      aria-label={icon && !children ? iconLabel(icon) : undefined}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
      {what ? <span className={variant === 'destructive' ? 'font-normal text-t3' : undefined}>{what}</span> : null}
      {shortcut ? (
        <Key
          shortcut={shortcut}
          className={variant === 'primary' ? 'text-on-petrol in-[.show-keys]:text-on-petrol' : undefined}
        />
      ) : null}
    </button>
  );
});

export const ICON_BUTTON =
  'w-8 h-8 grid place-items-center text-t3 hover:text-t1 hover:bg-raise [&.is-hover]:text-t1 [&.is-hover]:bg-raise';

export const ICON_BUTTON_ON = 'text-t1 [box-shadow:inset_0_calc(var(--spacing-rule)*-1)_0_var(--color-mist)]';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon?: IconName;
  active?: boolean;
  analyst?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, active, analyst, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        ICON_BUTTON,
        active && ICON_BUTTON_ON,
        analyst && 'text-aqua hover:text-aqua [&.is-hover]:text-aqua',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : children}
    </button>
  );
});
