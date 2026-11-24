import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef } from 'react';
import { cx } from '../cx.ts';
import { Key } from './Key.tsx';
import type { MenuChoiceProps, MenuItemProps, MenuRowProps } from './Floating.tsx';
import { MenuLead, MenuMark, MenuRowEnd, MenuSubChevron } from './MenuRow.tsx';
import { usePrivate } from './Private.tsx';

/**
 * The browser aims a keyboard context-menu request at the focused element, so a list with `aria-activedescendant`
 * rows gets it, not the row the keys have reached.
 */
export function isContextMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
}

export function openContextMenuAt(el: Element): void {
  const box = el.getBoundingClientRect();
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: box.left + box.height,
      clientY: box.bottom,
    }),
  );
}

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuRadioGroup = ContextMenuPrimitive.RadioGroup;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  const privacy = usePrivate();
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        {...privacy}
        className={cx('t-menu', 't-ctxmenu', className)}
        collisionPadding={8}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export type ContextMenuItemProps = ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> &
  Pick<MenuItemProps, 'shortcut' | 'hint' | 'icon' | 'current' | 'destructive'>;

export function ContextMenuItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  current,
  destructive,
  ...rest
}: ContextMenuItemProps) {
  return (
    <ContextMenuPrimitive.Item
      className={cx('t-menu-item', current && 'is-on', destructive && 'is-destructive', className)}
      {...rest}
    >
      <MenuLead icon={icon} />
      {children}
      <MenuRowEnd hint={hint} shortcut={shortcut} />
    </ContextMenuPrimitive.Item>
  );
}

export function ContextMenuRadioItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.RadioItem> & MenuChoiceProps) {
  return (
    <ContextMenuPrimitive.RadioItem className={cx('t-menu-item', className)} {...rest}>
      <MenuLead icon={icon} />
      {children}
      <MenuRowEnd hint={hint} shortcut={shortcut} />
    </ContextMenuPrimitive.RadioItem>
  );
}

export function ContextMenuCheckboxItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem> & MenuChoiceProps) {
  return (
    <ContextMenuPrimitive.CheckboxItem className={cx('t-menu-item', 't-menu-check', className)} {...rest}>
      <MenuLead icon={icon} />
      {children}
      {hint ? <span className="r">{hint}</span> : null}
      <MenuMark />
      {shortcut ? <Key shortcut={shortcut} /> : null}
    </ContextMenuPrimitive.CheckboxItem>
  );
}

export function ContextMenuSubTrigger({
  className,
  children,
  hint,
  icon,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> & Omit<MenuRowProps, 'shortcut'>) {
  return (
    <ContextMenuPrimitive.SubTrigger className={cx('t-menu-item', 't-menu-sub', className)} {...rest}>
      <MenuLead icon={icon} />
      {children}
      {hint ? <span className="r">{hint}</span> : null}
      <MenuSubChevron />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  sideOffset = 2,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>) {
  const privacy = usePrivate();
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        {...privacy}
        className={cx('t-menu', 't-ctxmenu', className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuLabel({ className, ...rest }: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cx('t-menu-label', className)} {...rest} />;
}

export function ContextMenuSeparator({
  className,
  ...rest
}: ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cx('t-menu-sep', className)} {...rest} />;
}
