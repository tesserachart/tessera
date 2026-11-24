import type { OrderKeyAction } from '../shell/orderHotkeys.ts';

export interface DomKeys {
  scroll(rows: number): void;
  page(dir: 1 | -1): void;
  centre(): void;
  holding(): boolean;
  escape(): void;
  cancelAll(): void;
  flatten(): void;
  breakeven(): void;
  order(action: OrderKeyAction): void;
  sends(): boolean;
}

export interface TapeKeys {
  toggle(): void;
  newest(): void;
  paused(): boolean;
}

type Kind = 'dom' | 'tape';
interface Bound {
  dom: DomKeys;
  tape: TapeKeys;
}

const bound: { [K in Kind]: Map<Element, Bound[K]> } = { dom: new Map(), tape: new Map() };
const last: { [K in Kind]: Element | null } = { dom: null, tape: null };

export function bindTileKeys<K extends Kind>(kind: K, el: HTMLElement, keys: Bound[K]): () => void {
  (bound[kind] as Map<Element, Bound[K]>).set(el, keys);
  const onFocus = () => {
    last[kind] = el;
  };
  el.addEventListener('focusin', onFocus);
  return () => {
    el.removeEventListener('focusin', onFocus);
    bound[kind].delete(el);
    if (last[kind] === el) last[kind] = null;
  };
}

export function tileKeys<K extends Kind>(kind: K, active: Element | null = activeElement()): Bound[K] | null {
  const map = bound[kind] as Map<Element, Bound[K]>;
  for (const [el, keys] of map) if (active && el.contains(active)) return keys;
  const prev = last[kind];
  return prev?.isConnected ? (map.get(prev) ?? null) : null;
}

export function focusedTileKeys<K extends Kind>(kind: K, active: Element | null = activeElement()): Bound[K] | null {
  const map = bound[kind] as Map<Element, Bound[K]>;
  for (const [el, keys] of map) if (active && el.contains(active)) return keys;
  return null;
}

function activeElement(): Element | null {
  return typeof document === 'undefined' ? null : document.activeElement;
}
