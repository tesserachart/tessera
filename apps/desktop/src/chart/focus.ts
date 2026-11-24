import type { MouseEvent, PointerEvent } from 'react';

export function afterOpenerTakesFocus(focus: () => void): () => void {
  const frame = requestAnimationFrame(focus);
  return () => cancelAnimationFrame(frame);
}

export function focusPastClosingMenu(focus: () => void): () => void {
  focus();
  const timer = setTimeout(focus, 0);
  return () => clearTimeout(timer);
}

export function actWithoutLeavingRow(act: () => void) {
  return {
    tabIndex: -1,
    onPointerDown: (e: PointerEvent) => e.stopPropagation(),
    onMouseDown: (e: MouseEvent) => e.preventDefault(),
    onPointerUp: (e: PointerEvent) => e.stopPropagation(),
    onClick: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      act();
    },
  };
}
