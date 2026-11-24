import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

export const COMPACT_STEPS = ['chevrons', 'mode', 'effort', 'model'] as const;

export function compactWords(level: number): string {
  return COMPACT_STEPS.slice(0, Math.max(0, level)).join(' ');
}

export function fitLevel(fits: (level: number) => boolean): number {
  const last = COMPACT_STEPS.length;
  for (let level = 0; level < last; level++) if (fits(level)) return level;
  return last;
}

/** `scrollWidth` rounds to whole pixels. */
export function endsWithin(right: number, ends: readonly number[]): boolean {
  return ends.every((end) => end <= right + 0.5);
}

function rowFits(row: HTMLElement): boolean {
  const box = row.getBoundingClientRect();
  const right = box.right - (Number.parseFloat(getComputedStyle(row).paddingRight) || 0);
  const ends: number[] = [];
  for (const child of Array.from(row.children)) {
    const r = child.getBoundingClientRect();
    if (r.width > 0) ends.push(r.right);
  }
  return endsWithin(right, ends);
}

export function fitRow(row: HTMLElement): void {
  const level = fitLevel((l) => {
    row.dataset.compact = compactWords(l);
    return rowFits(row);
  });
  row.dataset.compact = compactWords(level);
}

export function useFitRow(row: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const fit = () => fitRow(el);
    fit();
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    resized?.observe(el);
    const changed = new MutationObserver(fit);
    changed.observe(el, { subtree: true, childList: true, characterData: true });
    return () => {
      resized?.disconnect();
      changed.disconnect();
    };
  }, [row]);
}

export function meterBars(rank: number, of: number): { x: number; y: number; h: number; lit: boolean }[] {
  const n = Math.min(Math.max(of, 1), 6);
  const lit = of <= n ? rank + 1 : Math.max(1, Math.round(((rank + 1) / of) * n));
  const gap = n <= 4 ? 2 : 1;
  const x0 = Math.floor((20 - (n * 2 + (n - 1) * gap)) / 2);
  return Array.from({ length: n }, (_, i) => {
    const h = Math.round(4 + (12 * i) / Math.max(1, n - 1));
    return { x: x0 + i * (2 + gap), y: 17 - h, h, lit: i < lit };
  });
}

export function useModifierHeld(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const read = (e: KeyboardEvent | MouseEvent) => setHeld(e.metaKey || e.ctrlKey);
    const release = () => setHeld(false);
    window.addEventListener('keydown', read);
    window.addEventListener('keyup', read);
    window.addEventListener('mousemove', read, { passive: true });
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', read);
      window.removeEventListener('keyup', read);
      window.removeEventListener('mousemove', read);
      window.removeEventListener('blur', release);
    };
  }, [active]);
  return held;
}
