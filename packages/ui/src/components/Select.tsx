import { Select as SelectPrimitive } from 'radix-ui';
import { Fragment, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { cx } from '../cx.ts';
import { groupOptions } from '../search.ts';
import { Icon } from './Icon.tsx';
import { usePrivate } from './Private.tsx';

export type SelectVariant = 'field' | 'quiet';

export interface SelectTriggerProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  variant?: SelectVariant;
  size?: 'md' | 's';
  placeholder?: ReactNode;
}

export function SelectTrigger({ variant = 'field', size = 'md', placeholder, className, ...rest }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      className={cx('t-select', variant === 'quiet' && 'quiet', size === 's' && 's', className)}
      data-press="none"
      {...rest}
    >
      <SelectPrimitive.Value placeholder={placeholder} />
      <SelectPrimitive.Icon asChild>
        <Icon name="chevron-down" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  sideOffset = 4,
  align = 'start',
  ...rest
}: ComponentPropsWithoutRef<typeof SelectPrimitive.Content>) {
  const privacy = usePrivate();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        {...privacy}
        className={cx('t-menu', 't-select-menu', className)}
        position="popper"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...rest}
      >
        <SelectPrimitive.ScrollUpButton className="t-select-scroll">
          <Icon name="chevron-up" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="t-select-scroll">
          <Icon name="chevron-down" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export interface SelectItemProps extends ComponentPropsWithoutRef<typeof SelectPrimitive.Item> {
  hint?: ReactNode;
}

export function SelectItem({ className, children, hint, ...rest }: SelectItemProps) {
  return (
    <SelectPrimitive.Item className={cx('t-menu-item', className)} {...rest}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {hint ? <span className="r">{hint}</span> : null}
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...rest }: ComponentPropsWithoutRef<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cx('t-menu-label', className)} {...rest} />;
}

export function SelectSeparator({ className, ...rest }: ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cx('t-menu-sep', className)} {...rest} />;
}

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  textValue?: string;
  hint?: ReactNode;
  group?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  options: readonly SelectOption<T>[];
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  label?: string;
  id?: string;
  placeholder?: ReactNode;
  variant?: SelectVariant;
  size?: 'md' | 's';
  disabled?: boolean;
  name?: string;
  required?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  className?: string;
  contentClassName?: string;
}

export function Select<T extends string = string>({
  options,
  value,
  defaultValue,
  onValueChange,
  label,
  id,
  placeholder,
  variant,
  size,
  disabled,
  name,
  required,
  open,
  defaultOpen,
  onOpenChange,
  align,
  className,
  contentClassName,
}: SelectProps<T>) {
  const groups = groupOptions(options);
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
      required={required}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        variant={variant}
        size={size}
        placeholder={placeholder}
        className={className}
      />
      <SelectContent align={align} className={contentClassName}>
        {groups.map((g, i) => (
          <Fragment key={g.group ?? ''}>
            {i > 0 ? <SelectSeparator /> : null}
            <SelectPrimitive.Group>
              {g.group ? <SelectLabel>{g.group}</SelectLabel> : null}
              {g.options.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled} textValue={o.textValue} hint={o.hint}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectPrimitive.Group>
          </Fragment>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  );
}
