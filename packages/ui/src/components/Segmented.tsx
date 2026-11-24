import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '../cx.ts';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  ...rest
}: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cx('t-seg', className)} {...rest}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'is-on' : undefined}
          data-press="none"
          aria-pressed={o.value === value}
          aria-label={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface ChoiceProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: readonly SegmentedOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  locked?: boolean;
}

export function Choice<T extends string>({
  options,
  value,
  onChange,
  label,
  locked,
  className,
  ...rest
}: ChoiceProps<T>) {
  return (
    <div role="radiogroup" aria-label={label} className={cx('t-choice', locked && 'is-locked', className)} {...rest}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className={o.value === value ? 'is-on' : undefined}
          aria-checked={o.value === value}
          aria-label={o.title}
          aria-disabled={locked || o.disabled ? true : undefined}
          onClick={() => {
            if (!locked && !o.disabled && o.value !== value) onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface CheckProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'checked'> {
  checked: boolean | 'mixed';
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

export function Check({ checked, onChange, disabled, children, className, ...rest }: CheckProps) {
  return (
    <label
      className={cx(
        't-check',
        checked === true && 'is-on',
        checked === 'mixed' && 'is-mixed',
        disabled && 'is-disabled',
        className,
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked === true}
        aria-checked={checked === 'mixed' ? 'mixed' : undefined}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
      <span className="box" aria-hidden="true" />
      {children}
    </label>
  );
}

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  checked: boolean;
  onChange: () => void;
  name: string;
  children: ReactNode;
}

export function Radio({ checked, onChange, disabled, children, className, ...rest }: RadioProps) {
  return (
    <label className={cx('t-radio', checked && 'is-on', disabled && 'is-disabled', className)}>
      <input
        type="radio"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={() => onChange()}
        {...rest}
      />
      <span className="box" aria-hidden="true" />
      {children}
    </label>
  );
}
