import type { RuntimeUnavailableProblem } from '@tessera/bridge';
import type { ConnectionState, HelloResult, SessionProblem } from '@tessera/protocol';
import { useSyncExternalStore } from 'react';
import { connectionStore } from './connection.ts';
import { useStore } from './store.ts';
import { useClock } from './clock.ts';

export const SESSION_EXPIRED: SessionProblem = 'session_expired';

export const SESSION_MISSING: SessionProblem = 'session_missing';

export const RUNTIME_STARTING: RuntimeUnavailableProblem = 'runtime_starting';
export const RUNTIME_FAILED: RuntimeUnavailableProblem = 'runtime_failed';
export const DATA_DIR_LOCKED: RuntimeUnavailableProblem = 'data_dir_locked';

export function useConnection(): ConnectionState {
  return useStore(connectionStore);
}

export function useServer(): HelloResult | null {
  return useConnection().server;
}

export function useNow(): number {
  const clock = useClock();
  useSyncExternalStore(clock.subscribe, clock.getSnapshot);
  return clock.now();
}
