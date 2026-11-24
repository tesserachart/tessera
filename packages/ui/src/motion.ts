import { useEffect, useState } from 'react';

export function usePresence(present: boolean, exitMs: number): 'open' | 'closed' | null {
  const [state, setState] = useState<'open' | 'closed' | null>(present ? 'open' : null);
  let next = state;
  if (present) next = 'open';
  else if (exitMs <= 0) next = null;
  else if (state === 'open') next = 'closed';
  if (next !== state) setState(next);
  useEffect(() => {
    if (state !== 'closed') return;
    const t = setTimeout(() => setState(null), exitMs);
    return () => clearTimeout(t);
  }, [state, exitMs]);
  return next;
}

let lastInput: 'keyboard' | 'pointer' = 'pointer';
const MODIFIER = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

export function lastInputModality(): 'keyboard' | 'pointer' {
  return lastInput;
}

export function installInputModality(win: Window = window): () => void {
  const key = (e: KeyboardEvent) => {
    if (!MODIFIER.has(e.key)) lastInput = 'keyboard';
  };
  const pointer = () => {
    lastInput = 'pointer';
  };
  win.addEventListener('keydown', key, true);
  win.addEventListener('pointerdown', pointer, true);
  return () => {
    win.removeEventListener('keydown', key, true);
    win.removeEventListener('pointerdown', pointer, true);
    lastInput = 'pointer';
  };
}

export function useKeyboardToggle(present: boolean): boolean {
  const [seen, setSeen] = useState(present);
  const [instant, setInstant] = useState(false);
  if (present !== seen) {
    const keyboard = lastInput === 'keyboard';
    setSeen(present);
    setInstant(keyboard);
    return keyboard;
  }
  return instant;
}

const RESIZE_HANDLE = '.ui-splitter, .dv-sash, [role="separator"]';

export function installResizeQuiet(doc: Document = document): () => void {
  const root = doc.documentElement;
  const end = () => {
    delete root.dataset.resizing;
  };
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest(RESIZE_HANDLE)) root.dataset.resizing = '';
  };
  const win = doc.defaultView;
  doc.addEventListener('pointerdown', start, true);
  doc.addEventListener('pointerup', end, true);
  doc.addEventListener('pointercancel', end, true);
  win?.addEventListener('blur', end);
  return () => {
    doc.removeEventListener('pointerdown', start, true);
    doc.removeEventListener('pointerup', end, true);
    doc.removeEventListener('pointercancel', end, true);
    win?.removeEventListener('blur', end);
    end();
  };
}
