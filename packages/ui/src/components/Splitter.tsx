import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { cx, flag } from '../cx.ts';

export interface SplitterProps {
  orientation?: 'vertical' | 'horizontal';
  onDrag: (travelPx: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onStep?: (deltaPx: number) => void;
  onReset?: () => void;
  label: string;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  style?: CSSProperties;
}

export function Splitter({
  orientation = 'vertical',
  onDrag,
  onDragStart,
  onDragEnd,
  onStep,
  onReset,
  label,
  value,
  min,
  max,
  step = 16,
  className,
  style,
}: SplitterProps) {
  const origin = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const axis = (e: PointerEvent) => (orientation === 'vertical' ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = axis(e);
    setDragging(true);
    onDragStart?.();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (origin.current === null) return;
    onDrag(axis(e) - origin.current);
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (origin.current === null) return;
    origin.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onDragEnd?.();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const dec = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const inc = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const by = e.shiftKey ? step * 4 : step;
    if (e.key === dec) onStep?.(-by);
    else if (e.key === inc) onStep?.(by);
    else if (e.key === 'Enter' && onReset) onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cx('ui-splitter', className)}
      style={style}
      data-dragging={flag(dragging)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
