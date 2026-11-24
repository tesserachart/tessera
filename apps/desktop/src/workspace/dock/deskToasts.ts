import { ToolDenied, ToolFailed } from '@tessera/protocol';
import { createToastQueue } from '@tessera/ui';

export const deskToasts = createToastQueue();

function plainReason(err: unknown): string | null {
  if (err instanceof ToolDenied) return err.message;
  return err instanceof ToolFailed && err.code !== 'internal' ? err.message : null;
}

export function sayFailed(title: string, err: unknown): void {
  console.warn(`[desk] ${title}`, err);
  deskToasts.push({ tone: 'err', key: title, title, detail: plainReason(err) });
}
