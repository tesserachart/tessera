/*
 * WebKit (the macOS window) lets a drag that begins on unselectable chrome go on to select the text it crosses, and
 * every engine lets a selection dragged out of one text run on into any other selectable text in the window.
 */

export const SELECTABLE =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), pre, code, [data-selectable]';
export const UNSELECTABLE = 'button, [role="button"], select, [data-selectable="false"]';
const FIELD = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

export function selectionScope(el: Element): Element | null {
  const own = el.closest(`${SELECTABLE}, ${UNSELECTABLE}`);
  if (!own || own.matches(UNSELECTABLE)) return null;
  const field = own.closest(FIELD);
  if (field) return field;
  let scope = own;
  for (let up = own.parentElement?.closest(SELECTABLE); up; up = up.parentElement?.closest(SELECTABLE)) scope = up;
  return scope;
}

export function installSelectionScope(win: Window = window): () => void {
  const root = win.document.documentElement;
  let origin: Element | null | undefined;
  let scope: Element | null = null;
  const end = () => {
    origin = undefined;
    scope?.removeAttribute('data-selection-scope');
    scope = null;
    delete root.dataset.selecting;
  };
  const down = (e: PointerEvent) => {
    end();
    origin = e.target instanceof Element ? selectionScope(e.target) : null;
  };
  const start = (e: Event) => {
    if (origin === undefined || scope) return;
    if (origin === null) {
      e.preventDefault();
      return;
    }
    if (origin.matches(FIELD)) return;
    scope = origin;
    scope.setAttribute('data-selection-scope', '');
    root.dataset.selecting = '';
  };
  win.addEventListener('pointerdown', down, true);
  win.addEventListener('selectstart', start, true);
  win.addEventListener('pointerup', end, true);
  win.addEventListener('pointercancel', end, true);
  win.addEventListener('blur', end);
  return () => {
    win.removeEventListener('pointerdown', down, true);
    win.removeEventListener('selectstart', start, true);
    win.removeEventListener('pointerup', end, true);
    win.removeEventListener('pointercancel', end, true);
    win.removeEventListener('blur', end);
    end();
  };
}
