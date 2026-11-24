import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, ReactNode, Ref } from 'react';
import { cx } from '../cx.ts';

export interface ScrollAreaProps extends Omit<ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>, 'dir'> {
  orientation?: 'vertical' | 'horizontal' | 'both';
  type?: 'hover' | 'scroll' | 'auto' | 'always';
  viewportRef?: Ref<HTMLDivElement>;
  viewportClassName?: string;
  children?: ReactNode;
}

export function ScrollArea({
  orientation = 'vertical',
  type = 'hover',
  scrollHideDelay = 600,
  viewportRef,
  viewportClassName,
  className,
  children,
  ...rest
}: ScrollAreaProps) {
  const y = orientation !== 'horizontal';
  const x = orientation !== 'vertical';
  return (
    <ScrollAreaPrimitive.Root
      className={cx('t-scrollarea', className)}
      type={type}
      scrollHideDelay={scrollHideDelay}
      data-scroll={orientation}
      {...rest}
    >
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className={cx('t-scrollarea-view', viewportClassName)}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      {y ? (
        <ScrollAreaPrimitive.Scrollbar className="t-scrollbar" orientation="vertical">
          <ScrollAreaPrimitive.Thumb className="t-scrollbar-thumb" />
        </ScrollAreaPrimitive.Scrollbar>
      ) : null}
      {x ? (
        <ScrollAreaPrimitive.Scrollbar className="t-scrollbar" orientation="horizontal">
          <ScrollAreaPrimitive.Thumb className="t-scrollbar-thumb" />
        </ScrollAreaPrimitive.Scrollbar>
      ) : null}
      {x && y ? <ScrollAreaPrimitive.Corner /> : null}
    </ScrollAreaPrimitive.Root>
  );
}
