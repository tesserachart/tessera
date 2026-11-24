import type { SessionMode } from '@tessera/protocol';
import { ConfirmDialog } from '@tessera/ui';
import { useState, type ReactNode } from 'react';
import { FULL_ACCESS_WARNING, asksFirst } from './modes.ts';

export function useModeChange(
  current: SessionMode | null,
  apply: (mode: SessionMode) => void,
): { request: (mode: SessionMode) => void; dialog: ReactNode } {
  const [asking, setAsking] = useState(false);
  const request = (mode: SessionMode) => {
    if (mode === current) return;
    if (asksFirst(current, mode)) setAsking(true);
    else apply(mode);
  };
  const dialog = (
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      title="Turn on Full access?"
      description={FULL_ACCESS_WARNING}
      confirmLabel="Turn on"
      onConfirm={() => apply('full_access')}
    />
  );
  return { request, dialog };
}
