import { normalizeEpochMs, type ConnectionState } from '@tessera/protocol';
import { createContext, useContext } from 'react';
import { connectionStore } from './connection.ts';
import type { Readable } from './store.ts';

export class RuntimeClock {
  private offset = 0;
  private lastServer: unknown = null;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;

  constructor(connection?: Readable<ConnectionState>) {
    if (!connection) return;
    const sync = () => {
      const server = connection.getState().server;
      if (server === this.lastServer) return;
      this.lastServer = server;
      const t = server ? normalizeEpochMs(server.serverTime) : Number.NaN;
      this.offset = Number.isFinite(t) ? t - Date.now() : 0;
      this.emit();
    };
    connection.subscribe(sync);
    sync();
  }

  now = (): number => Date.now() + this.offset;

  get offsetMs(): number {
    return this.offset;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.timer ??= setInterval(() => {
      this.tick++;
      this.emit();
    }, 1000);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  };

  getSnapshot = (): number => this.tick * 1e9 + this.offset;

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

let windowClock: RuntimeClock | null = null;

function runtimeClock(): RuntimeClock {
  windowClock ??= new RuntimeClock(connectionStore);
  return windowClock;
}

export const ClockContext = createContext<RuntimeClock | null>(null);

export function useClock(): RuntimeClock {
  return useContext(ClockContext) ?? runtimeClock();
}
