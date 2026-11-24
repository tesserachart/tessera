type ComposerEl = HTMLInputElement | HTMLTextAreaElement;

const composers: ComposerEl[] = [];

export function registerComposer(el: ComposerEl | null): () => void {
  if (!el) return () => undefined;
  const at = composers.indexOf(el);
  if (at >= 0) composers.splice(at, 1);
  composers.push(el);
  return () => {
    const i = composers.indexOf(el);
    if (i >= 0) composers.splice(i, 1);
  };
}

function reachable(el: ComposerEl): boolean {
  return el.isConnected && el.getClientRects().length > 0 && el.closest('[inert], [hidden]') === null;
}

function composer(): ComposerEl | null {
  for (let i = composers.length - 1; i >= 0; i--) if (reachable(composers[i]!)) return composers[i]!;
  return composers.at(-1) ?? null;
}

export function focusComposer(): void {
  let tries = 0;
  const attempt = () => {
    const el = composer();
    const active = el?.ownerDocument.activeElement ?? null;
    const elsewhere = active && active !== el && active !== el?.ownerDocument.body;
    if (tries > 0 && elsewhere) return;
    if (el && reachable(el) && active !== el) el.focus();
    if (++tries < 30) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export function isComposerFocused(): boolean {
  return composers.some((el) => el.ownerDocument.activeElement === el);
}
