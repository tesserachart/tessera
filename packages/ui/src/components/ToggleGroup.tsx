import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../cx.ts';

export interface ToggleOption<T extends string = string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface ToggleGroupProps<T extends string = string> {
  options: readonly ToggleOption<T>[];
  value: readonly T[];
  onToggle: (value: T, on: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

export function ToggleGroup<T extends string = string>({
  options,
  value,
  onToggle,
  label,
  disabled,
  className,
}: ToggleGroupProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="multiple"
      className={cx('t-toggles', className)}
      // Radix's default role for a multiple toggle group is toolbar
      role="group"
      aria-label={label}
      disabled={disabled}
      value={[...value]}
      onValueChange={(next) => {
        const added = next.find((v) => !value.includes(v as T));
        if (added !== undefined) return onToggle(added as T, true);
        const removed = value.find((v) => !next.includes(v));
        if (removed !== undefined) onToggle(removed, false);
      }}
    >
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          className="t-toggle"
          aria-label={o.title}
          disabled={o.disabled}
          data-press="none"
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}
