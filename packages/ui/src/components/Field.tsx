import { forwardRef, useId, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Icon } from './Icon.tsx';
import { PRICE_TEXT } from './Data.tsx';

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
  htmlFor?: string;
}

export function Field({ label, help, error, className, children, htmlFor }: FieldProps) {
  return (
    <div className={cx('t-field', error ? 'is-error' : undefined, className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="err" role="alert">
          <Icon name="attention" />
          {error}
        </span>
      ) : help ? (
        <span className="help">{help}</span>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  unit?: ReactNode;
  size?: 'md' | 's';
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { unit, size = 'md', className, disabled, ...rest },
  ref,
) {
  return (
    <div className={cx('t-input', size === 's' && 's', disabled && 'is-disabled', className)}>
      <input ref={ref} disabled={disabled} {...rest} />
      {unit !== undefined ? <span className="unit">{unit}</span> : null}
    </div>
  );
});

export interface PriceInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'step' | 'type'
> {
  value: string;
  onChange: (value: string) => void;
  onStep: (ticks: number) => void;
}

export const PriceInput = forwardRef<HTMLInputElement, PriceInputProps>(function PriceInput(
  { value, onChange, onStep, className, disabled, onKeyDown, ...rest },
  ref,
) {
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const n = e.shiftKey ? 4 : 1;
    if (e.key === 'ArrowUp') onStep(n);
    else if (e.key === 'ArrowDown') onStep(-n);
    else return;
    e.preventDefault();
  };
  return (
    <div className={cx('t-input', 'price', disabled && 'is-disabled', className)}>
      <input
        ref={ref}
        className={PRICE_TEXT}
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={key}
        {...rest}
      />
      <span className="t-step">
        <button type="button" aria-label="Down a tick" tabIndex={-1} disabled={disabled} onClick={() => onStep(-1)}>
          <Icon name="remove" />
        </button>
        <button type="button" aria-label="Up a tick" tabIndex={-1} disabled={disabled} onClick={() => onStep(1)}>
          <Icon name="plus" />
        </button>
      </span>
    </div>
  );
});

export interface QtyFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'type'
> {
  mode: 'qty' | 'risk';
  onModeChange?: (mode: 'qty' | 'risk') => void;
  value: string;
  onChange: (value: string) => void;
}

export const QtyField = forwardRef<HTMLInputElement, QtyFieldProps>(function QtyField(
  { mode, onModeChange, value, onChange, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  const word = mode === 'qty' ? 'Qty' : 'Risk';
  return (
    <span className={cx('t-qty', className)}>
      {onModeChange ? (
        <button
          type="button"
          className="lab"
          aria-label={`${word}: switch to ${mode === 'qty' ? 'risk' : 'quantity'}`}
          onClick={() => onModeChange(mode === 'qty' ? 'risk' : 'qty')}
        >
          <u>{word}</u>
        </button>
      ) : (
        <label className="lab" htmlFor={inputId}>
          {word}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={PRICE_TEXT}
        inputMode="decimal"
        size={Math.max(1, value.length)}
        value={value}
        aria-label={word}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
      />
    </span>
  );
});
