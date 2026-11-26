import {
  Dialog as DialogPrimitive,
  DropdownMenu,
  Popover as PopoverPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { cx } from '../cx.ts';
import { MOTION } from '../tokens.ts';
import { Button } from './Button.tsx';
import { Key } from './Key.tsx';
import { MenuLead, MenuMark, MenuRowEnd, MenuSubChevron, type MenuIcon } from './MenuRow.tsx';
import { usePrivate } from './Private.tsx';
import { useRootFlagWhileOpen } from '../rootFlags.ts';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={MOTION.tooltipDelayMs} skipDelayDuration={MOTION.tooltipSkipMs}>
      <HasTooltipProvider.Provider value={true}>{children}</HasTooltipProvider.Provider>
    </TooltipPrimitive.Provider>
  );
}

/** Radix's tooltip throws without a provider above it. */
const HasTooltipProvider = createContext(false);

export interface TooltipProps {
  content: ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  open?: boolean;
  children: ReactNode;
}

/** Radix's `asChild` trigger needs a child that takes a ref. */
export function Tooltip(props: TooltipProps) {
  if (useContext(HasTooltipProvider)) return <TooltipRoot {...props} />;
  return (
    <TooltipProvider>
      <TooltipRoot {...props} />
    </TooltipProvider>
  );
}

/** A Radix menu, popover or dialog that closes gives the focus back to its trigger. */
let lastInput: 'pointer' | 'key' = 'pointer';
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), { capture: true, passive: true });
  window.addEventListener('keydown', () => (lastInput = 'key'), { capture: true, passive: true });
}

export function tooltipOnFocus(e: Pick<FocusEvent, 'preventDefault'>): void {
  if (lastInput === 'pointer') e.preventDefault();
}

function TooltipRoot({ content, shortcut, side = 'bottom', open, children }: TooltipProps) {
  const privacy = usePrivate();
  return (
    <TooltipPrimitive.Root {...(open === undefined ? {} : { open })}>
      <TooltipPrimitive.Trigger asChild onFocus={tooltipOnFocus}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="t-tip" side={side} sideOffset={4} collisionPadding={8} {...privacy}>
          {content}
          {shortcut ? <Key shortcut={shortcut} /> : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

const MenuTriggerEl = createContext<RefObject<HTMLElement | null> | null>(null);
const CloseMenu = createContext<(() => void) | null>(null);

export function Menu(props: ComponentPropsWithoutRef<typeof DropdownMenu.Root>) {
  const { open: openProp, defaultOpen = false, ...rest } = props;
  const trigger = useRef<HTMLElement | null>(null);
  const [own, setOwn] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : own;
  const setOpen = (o: boolean) => {
    if (!controlled) setOwn(o);
    props.onOpenChange?.(o);
  };
  return (
    <MenuTriggerEl.Provider value={trigger}>
      <CloseMenu.Provider value={() => setOpen(false)}>
        <DropdownMenu.Root {...rest} open={open} onOpenChange={setOpen} />
      </CloseMenu.Provider>
    </MenuTriggerEl.Provider>
  );
}

export function useCloseMenu(): () => void {
  return useContext(CloseMenu) ?? noop;
}

function noop(): void {}

export function MenuTrigger({
  ref,
  ...props
}: ComponentPropsWithoutRef<typeof DropdownMenu.Trigger> & { ref?: Ref<HTMLButtonElement> }) {
  const triggerRef = useContext(MenuTriggerEl);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      if (triggerRef) triggerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [triggerRef, ref],
  );
  return <DropdownMenu.Trigger {...props} ref={setRef} />;
}

export const MenuGroup = DropdownMenu.Group;
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuContent({
  className,
  sideOffset = 4,
  align = 'start',
  onCloseAutoFocus,
  onInteractOutside,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.Content>) {
  const triggerRef = useContext(MenuTriggerEl);
  const outsideRef = useRef(false);
  const privacy = usePrivate();
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        {...privacy}
        className={cx('t-menu', className)}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        onInteractOutside={(e) => {
          onInteractOutside?.(e);
          outsideRef.current = true;
        }}
        onCloseAutoFocus={(e) => {
          onCloseAutoFocus?.(e);
          const wentOutside = outsideRef.current;
          outsideRef.current = false;
          const el = triggerRef?.current;
          if (e.defaultPrevented) return;
          const doc = el?.ownerDocument ?? document;
          const active = doc.activeElement;
          // Radix counts a pick that moved the focus outside as an interaction outside, and takes the focus back
          if (active && active !== doc.body && active !== el && !active.closest('[role="menu"]')) {
            e.preventDefault();
            return;
          }
          if (wentOutside || lastInput !== 'pointer' || !el?.isConnected) return;
          e.preventDefault();
          el.focus({ preventScroll: true, focusVisible: false });
        }}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}

export interface MenuRowProps {
  shortcut?: string;
  hint?: ReactNode;
  icon?: MenuIcon;
  detail?: ReactNode;
}

function MenuText({ children, detail }: { children: ReactNode; detail: ReactNode }) {
  if (detail === undefined || detail === null) return children;
  return (
    <span className="t-menu-text">
      <span className="t">{children}</span>
      <span className="d">{detail}</span>
    </span>
  );
}

export interface MenuItemProps extends ComponentPropsWithoutRef<typeof DropdownMenu.Item>, MenuRowProps {
  current?: boolean;
  destructive?: boolean;
  why?: ReactNode;
}

export function MenuItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  detail,
  current,
  destructive,
  disabled,
  why,
  onSelect,
  ...rest
}: MenuItemProps) {
  const reasonId = useId();
  const row = (
    <DropdownMenu.Item
      className={cx('t-menu-item', current && 'is-on', destructive && 'is-destructive', className)}
      {...rest}
      {...(disabled && why
        ? {
            'aria-disabled': true,
            'aria-describedby': reasonId,
            'data-disabled': '',
            onSelect: (e: Event) => e.preventDefault(),
          }
        : { disabled, onSelect })}
    >
      <MenuLead icon={icon} />
      <MenuText detail={detail}>{children}</MenuText>
      <MenuRowEnd hint={hint} shortcut={shortcut} />
    </DropdownMenu.Item>
  );
  if (!disabled || !why) return row;
  return (
    <>
      <Tooltip content={why}>{row}</Tooltip>
      <span id={reasonId} className="sr-only">
        {why}
      </span>
    </>
  );
}

export type MenuChoiceProps = MenuRowProps;

export function MenuRadioItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  detail,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.RadioItem> & MenuChoiceProps) {
  return (
    <DropdownMenu.RadioItem className={cx('t-menu-item', className)} {...rest}>
      <MenuLead icon={icon} />
      <MenuText detail={detail}>{children}</MenuText>
      <MenuRowEnd hint={hint} shortcut={shortcut} />
    </DropdownMenu.RadioItem>
  );
}

export function MenuCheckboxItem({
  className,
  children,
  shortcut,
  hint,
  icon,
  detail,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.CheckboxItem> & MenuChoiceProps) {
  return (
    <DropdownMenu.CheckboxItem className={cx('t-menu-item', 't-menu-check', className)} {...rest}>
      <MenuLead icon={icon} />
      <MenuText detail={detail}>{children}</MenuText>
      {hint ? <span className="r">{hint}</span> : null}
      <MenuMark />
      {shortcut ? <Key shortcut={shortcut} /> : null}
    </DropdownMenu.CheckboxItem>
  );
}

export const MenuSub = DropdownMenu.Sub;

export function MenuSubTrigger({
  className,
  children,
  hint,
  icon,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubTrigger> & Omit<MenuRowProps, 'shortcut'>) {
  return (
    <DropdownMenu.SubTrigger className={cx('t-menu-item', 't-menu-sub', className)} {...rest}>
      <MenuLead icon={icon} />
      {children}
      {hint ? <span className="r">{hint}</span> : null}
      <MenuSubChevron />
    </DropdownMenu.SubTrigger>
  );
}

export function MenuSubContent({
  className,
  sideOffset = 2,
  ...rest
}: ComponentPropsWithoutRef<typeof DropdownMenu.SubContent>) {
  const privacy = usePrivate();
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.SubContent
        {...privacy}
        className={cx('t-menu', className)}
        sideOffset={sideOffset}
        collisionPadding={8}
        {...rest}
      />
    </DropdownMenu.Portal>
  );
}

export function MenuLabel({ className, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cx('t-menu-label', className)} {...rest} />;
}

export function MenuSeparator({ className, ...rest }: ComponentPropsWithoutRef<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cx('t-menu-sep', className)} {...rest} />;
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  sideOffset = 4,
  align = 'start',
  ...rest
}: ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  const privacy = usePrivate();
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        {...privacy}
        className={cx('t-popover', className)}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
}

export const DIALOG_OPEN = 'data-dialog-open';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  headerRight?: ReactNode;
}

export function DialogContent({
  className,
  title,
  description,
  hideTitle,
  headerRight,
  children,
  ...rest
}: DialogContentProps) {
  const privacy = usePrivate();
  const content = useRootFlagWhileOpen(DIALOG_OPEN);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content ref={content} className={cx('ui-dialog', className)} {...privacy} {...rest}>
        {hideTitle ? (
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        ) : (
          <div className="ui-dialog-header">
            <DialogPrimitive.Title className="ui-dialog-title">{title}</DialogPrimitive.Title>
            {headerRight ? <div style={{ marginLeft: 'auto' }}>{headerRight}</div> : null}
          </div>
        )}
        {description ? (
          <DialogPrimitive.Description className="ui-dialog-description">{description}</DialogPrimitive.Description>
        ) : (
          <DialogPrimitive.Description className="sr-only">
            {typeof title === 'string' ? title : 'Dialog'}
          </DialogPrimitive.Description>
        )}
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-confirm" title={title} description={description}>
        <div className="ui-dialog-body ui-confirm-actions">
          <DialogClose asChild>
            <Button autoFocus>{cancelLabel}</Button>
          </DialogClose>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
