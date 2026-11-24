import { useState, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './Floating.tsx';
import { Icon } from './Icon.tsx';
import { PRICE_TEXT } from './Data.tsx';

export interface StepperUnitOption<U extends string = string> {
  value: U;
  short: string;
  label: string;
  disabled?: boolean;
}

export interface StepperUnit<U extends string = string> {
  value: U;
  options: readonly StepperUnitOption<U>[];
  onChange: (value: U) => void;
  label: string;
}

export interface StepperProps {
  value: number;
  onValueChange: (value: number) => void;
  label: string;
  step?: number;
  shiftSteps?: number;
  min?: number;
  max?: number;
  onStep?: (n: number) => void;
  format?: (value: number) => string;
  parse?: (text: string) => number | null;
  prefix?: ReactNode;
  suffix?: ReactNode;
  unit?: StepperUnit;
  buttons?: boolean;
  size?: 'md' | 's';
  disabled?: boolean;
  invalid?: boolean;
  inputMode?: 'numeric' | 'decimal';
  fit?: boolean;
  className?: string;
  id?: string;
}

export function parseStep(text: string): number | null {
  const t = text.replace(/[,$%\s]/g, '').replace(/[a-z]+$/i, '');
  if (t === '' || t === '-' || t === '.') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function steppedValue(value: number, n: number, step: number, min = -Infinity, max = Infinity): number {
  const next = Number((value + n * step).toFixed(6));
  return Math.min(max, Math.max(min, next));
}

export function Stepper({
  value,
  onValueChange,
  label,
  step = 1,
  shiftSteps = 4,
  min = -Infinity,
  max = Infinity,
  onStep,
  format = String,
  parse = parseStep,
  prefix,
  suffix,
  unit,
  buttons = true,
  size = 'md',
  disabled = false,
  invalid = false,
  inputMode = 'decimal',
  fit = false,
  className,
  id,
}: StepperProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? format(value);
  const by = (n: number) => {
    setDraft(null);
    if (onStep) onStep(n);
    else onValueChange(steppedValue(value, n, step, min, max));
  };
  return (
    <span
      className={cx(
        't-input',
        't-stepper',
        size === 's' && 's',
        disabled && 'is-disabled',
        invalid && 'is-invalid',
        fit && 'is-fit',
        className,
      )}
      style={fit ? ({ '--chars': text.length } as CSSProperties) : undefined}
    >
      {prefix !== undefined ? <span className="pre">{prefix}</span> : null}
      <input
        id={id}
        className={PRICE_TEXT}
        inputMode={inputMode}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = parse(e.target.value);
          if (n !== null && n >= min && n <= max) onValueChange(n);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          const n = e.shiftKey ? shiftSteps : 1;
          if (e.key === 'ArrowUp') by(n);
          else if (e.key === 'ArrowDown') by(-n);
          else return;
          e.preventDefault();
        }}
      />
      {unit ? (
        <UnitMenu unit={unit} disabled={disabled} />
      ) : suffix !== undefined ? (
        <span className="post">{suffix}</span>
      ) : null}
      {buttons ? (
        <span className="t-step">
          <button
            type="button"
            aria-label={`Less ${label.toLowerCase()}`}
            tabIndex={-1}
            disabled={disabled || (!onStep && value <= min)}
            onClick={() => by(-1)}
          >
            <Icon name="remove" />
          </button>
          <button
            type="button"
            aria-label={`More ${label.toLowerCase()}`}
            tabIndex={-1}
            disabled={disabled || (!onStep && value >= max)}
            onClick={() => by(1)}
          >
            <Icon name="plus" />
          </button>
        </span>
      ) : null}
    </span>
  );
}

function UnitMenu({ unit, disabled }: { unit: StepperUnit; disabled: boolean }) {
  const on = unit.options.find((o) => o.value === unit.value);
  return (
    <Menu>
      <MenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          className="unit"
          aria-label={`${unit.label}: ${on?.label ?? unit.value}`}
          data-press="none"
        >
          <span className="u">{on?.short ?? unit.value}</span>
          <Icon name="chevron-down" />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="t-stepper-units" aria-label={unit.label}>
        <MenuRadioGroup value={unit.value} onValueChange={(v) => unit.onChange(v)}>
          {unit.options.map((o) => (
            <MenuRadioItem key={o.value} value={o.value} disabled={o.disabled} hint={o.short}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
