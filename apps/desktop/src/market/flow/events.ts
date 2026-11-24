export interface FocusPrint {
  instrument: string;
  t: number;
  price: number;
  size: number;
  side?: number;
  ref: string;
}

const FOCUS_PRINT = 'tessera:focus-print';

export function focusPrint(detail: FocusPrint): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<FocusPrint>(FOCUS_PRINT, { detail }));
}

export function onFocusPrint(cb: (p: FocusPrint) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<FocusPrint>).detail);
  window.addEventListener(FOCUS_PRINT, h);
  return () => window.removeEventListener(FOCUS_PRINT, h);
}

export interface MarkTime {
  instrument: string;
  t: number;
  price: number;
}

const MARK_TIME = 'tessera:mark-time';

let clearer: { off: () => void } | null = null;

export function markTime(m: MarkTime | null, wins: readonly Window[] = []): void {
  if (typeof window === 'undefined') return;
  clearer?.off();
  clearer = null;
  window.dispatchEvent(new CustomEvent<MarkTime | null>(MARK_TIME, { detail: m }));
  if (!m) return;
  const targets = [...new Set([window, ...wins])];
  const onDown = (e: PointerEvent) => {
    if (e.target instanceof Element && e.target.closest('.t-tape .r')) return;
    markTime(null);
  };
  for (const w of targets) w.addEventListener('pointerdown', onDown, true);
  clearer = { off: () => targets.forEach((w) => w.removeEventListener('pointerdown', onDown, true)) };
}

export function onMarkTime(cb: (m: MarkTime | null) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<MarkTime | null>).detail);
  window.addEventListener(MARK_TIME, h);
  return () => window.removeEventListener(MARK_TIME, h);
}
