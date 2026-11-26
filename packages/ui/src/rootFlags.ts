import { useCallback, useLayoutEffect } from 'react';

const holders = new Map<string, number>();

export function holdRootFlag(attribute: string): () => void {
  const root = document.documentElement;
  holders.set(attribute, (holders.get(attribute) ?? 0) + 1);
  root.setAttribute(attribute, '');
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (holders.get(attribute) ?? 1) - 1;
    holders.set(attribute, left);
    if (left === 0) root.removeAttribute(attribute);
  };
}

export function useRootFlag(attribute: string, on = true): void {
  useLayoutEffect(() => (on ? holdRootFlag(attribute) : undefined), [attribute, on]);
}

export function useRootFlagWhileOpen(attribute: string): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      let release: (() => void) | null = null;
      const sync = () => {
        const open = el.dataset.state === 'open';
        if (open && !release) release = holdRootFlag(attribute);
        if (!open && release) {
          release();
          release = null;
        }
      };
      sync();
      const watch = new MutationObserver(sync);
      watch.observe(el, { attributes: true, attributeFilter: ['data-state'] });
      return () => {
        watch.disconnect();
        release?.();
      };
    },
    [attribute],
  );
}
