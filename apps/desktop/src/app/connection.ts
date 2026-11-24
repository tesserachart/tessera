import type { ConnectionState } from '@tessera/protocol';
import { createStore } from 'zustand/vanilla';
import { appClient, servicesStore } from './services.ts';
import { derived, useStore, type Readable } from './store.ts';

const IDLE: ConnectionState = {
  status: 'idle',
  attempt: 0,
  everConnected: false,
  server: null,
  lastError: null,
  lastErrorCode: null,
  nextRetryAt: null,
  connectedAt: null,
  endpoint: null,
};

const connection = createStore<ConnectionState>(() => IDLE);

const epoch = createStore<number | null>(() => null);

const behind = createStore<number>(() => 0);

let unfollow: (() => void) | null = null;
const follow = () => {
  unfollow?.();
  unfollow = null;
  const services = servicesStore.getState();
  epoch.setState(null, true);
  if (!services) {
    connection.setState(IDLE, true);
    behind.setState(0, true);
    return;
  }
  const { state, behind: trailing } = services.client;
  const update = () => {
    const c = state.getSnapshot();
    connection.setState(c, true);
    if (c.status === 'open' && c.connectedAt !== null) epoch.setState(c.connectedAt, true);
  };
  const lag = () => behind.setState(trailing.getSnapshot(), true);
  const offState = state.subscribe(update);
  const offLag = trailing.subscribe(lag);
  unfollow = () => {
    offState();
    offLag();
  };
  update();
  lag();
};
servicesStore.subscribe(follow);
follow();

export const connectionStore: Readable<ConnectionState> = connection;

export const connectionEpoch: Readable<number | null> = epoch;

export const behindStore: Readable<number> = behind;

export const everConnectedStore: Readable<boolean> = derived(epoch, (e) => e !== null);

export function connectionNow(): ConnectionState {
  return connection.getState();
}

export function retryNow(): void {
  if (servicesStore.getState()) appClient().retryNow();
}

export function useInRuntime(): boolean {
  return useStore(servicesStore, (services) => services !== null);
}
