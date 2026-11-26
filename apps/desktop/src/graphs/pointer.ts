import { useCallback, useState, type PointerEvent } from 'react';

export function useWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [w, setW] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function pointerX(e: PointerEvent): number {
  return e.clientX - e.currentTarget.getBoundingClientRect().left;
}
