import type { Approval, Suggestion, ToolDescriptor } from '@tessera/protocol';
import { createContext, type ReactNode } from 'react';
import { IDLE, type Activity } from '../../analyst/activity.ts';

export interface RowContext {
  toggle: (key: string) => void;
  renderApproval: (a: Approval) => ReactNode;
  onFollowUp: (s: Suggestion) => void;
  onRetry: (() => void) | undefined;
  retryKey: string | null;
  tools: ReadonlyMap<string, ToolDescriptor> | null;
}

export const RowCtx = createContext<RowContext | null>(null);

export const LiveCtx = createContext<Activity>(IDLE);

export const TailCtx = createContext<ReactNode>(null);
