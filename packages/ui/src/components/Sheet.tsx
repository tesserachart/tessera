import { Dialog as DialogPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from 'react';
import { cx } from '../cx.ts';
import { ICON_BUTTON } from './Button.tsx';
import { Tooltip } from './Floating.tsx';
import { Icon } from './Icon.tsx';
import { ScrollArea } from './ScrollArea.tsx';
import { usePrivate } from './Private.tsx';

const TABBABLE =
  'input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';

function focusFlow(sheet: HTMLElement) {
  const first =
    sheet.querySelector<HTMLElement>(`.t-sheet-body :is(${TABBABLE})`) ??
    sheet.querySelector<HTMLElement>(`.t-sheet-foot :is(${TABBABLE})`);
  (first ?? sheet).focus();
}

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  side?: 'right' | 'left' | 'bottom';
  size?: number | string;
  headerRight?: ReactNode;
  footer?: ReactNode;
  container?: HTMLElement | null;
}

export function SheetContent({
  title,
  description,
  side = 'right',
  size,
  headerRight,
  footer,
  container,
  className,
  style,
  children,
  onOpenAutoFocus,
  onFocusOutside,
  ...rest
}: SheetContentProps) {
  const inset = container !== undefined;
  const privacy = usePrivate();
  const sized =
    size === undefined
      ? style
      : ({ ...style, '--sheet-size': typeof size === 'number' ? `${String(size)}px` : size } as CSSProperties);
  return (
    <DialogPrimitive.Portal container={container ?? undefined}>
      {inset ? null : <DialogPrimitive.Overlay className="t-scrim" />}
      <DialogPrimitive.Content
        {...privacy}
        className={cx('t-sheet', inset ? 'is-inset' : 'is-drawer', className)}
        data-side={inset ? undefined : side}
        style={sized}
        onOpenAutoFocus={(e) => {
          onOpenAutoFocus?.(e);
          if (e.defaultPrevented || !(e.currentTarget instanceof HTMLElement)) return;
          e.preventDefault();
          focusFlow(e.currentTarget);
        }}
        onFocusOutside={(e) => {
          onFocusOutside?.(e);
          // a closing Radix menu gives the focus back to its trigger, which a non-modal dialog takes as a focus outside
          if (inset) e.preventDefault();
        }}
        {...rest}
      >
        <header className="t-sheet-head">
          <div className="tt">
            <DialogPrimitive.Title className="t-sheet-title">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="t-sheet-note">{description}</DialogPrimitive.Description>
            ) : null}
          </div>
          {headerRight ? <div className="end">{headerRight}</div> : null}
          <Tooltip content="Close" shortcut="escape">
            <DialogPrimitive.Close className={cx(ICON_BUTTON, 't-sheet-x')} aria-label="Close">
              <Icon name="close" className="text-inherit" />
            </DialogPrimitive.Close>
          </Tooltip>
        </header>
        <ScrollArea className="t-sheet-body">{children}</ScrollArea>
        {footer ? <footer className="t-sheet-foot">{footer}</footer> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
