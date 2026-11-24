export interface PoolTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: PoolTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface WarmPoolOptions<V> {
  make?: (key: string) => V;
  dispose(value: V, key: string): void;
  keepMs: number;
  maxIdle: number;
  timers?: PoolTimers;
}

interface Entry<V> {
  value: V;
  holders: number;
  expiry: unknown;
}

export class WarmPool<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly idleKeys = new Set<string>();
  private readonly timers: PoolTimers;

  constructor(private readonly options: WarmPoolOptions<V>) {
    this.timers = options.timers ?? realTimers;
  }

  acquire(key: string, make?: (key: string) => V): { value: V; release: () => void } {
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.holders === 0) this.wake(key, entry);
    } else {
      const maker = make ?? this.options.make;
      if (!maker) throw new Error(`nothing makes ${key}`);
      entry = { value: maker(key), holders: 0, expiry: null };
      this.entries.set(key, entry);
    }
    entry.holders++;
    const held = entry;
    let done = false;
    return {
      value: entry.value,
      release: () => {
        if (done) return;
        done = true;
        if (--held.holders === 0 && this.entries.get(key) === held) this.rest(key, held);
      },
    };
  }

  peek(key: string): V | undefined {
    return this.entries.get(key)?.value;
  }

  get size(): number {
    return this.entries.size;
  }

  get idle(): number {
    return this.idleKeys.size;
  }

  clear(): void {
    for (const [key, entry] of [...this.entries]) this.drop(key, entry);
  }

  private rest(key: string, entry: Entry<V>): void {
    if (this.options.keepMs <= 0 || this.options.maxIdle <= 0) {
      this.drop(key, entry);
      return;
    }
    this.idleKeys.add(key);
    entry.expiry = this.timers.set(() => {
      entry.expiry = null;
      if (this.entries.get(key) === entry && entry.holders === 0) this.drop(key, entry);
    }, this.options.keepMs);
    for (const old of this.idleKeys) {
      if (this.idleKeys.size <= this.options.maxIdle) break;
      const e = this.entries.get(old);
      if (e) this.drop(old, e);
      else this.idleKeys.delete(old);
    }
  }

  private wake(key: string, entry: Entry<V>): void {
    this.idleKeys.delete(key);
    if (entry.expiry !== null) this.timers.clear(entry.expiry);
    entry.expiry = null;
  }

  private drop(key: string, entry: Entry<V>): void {
    this.wake(key, entry);
    this.entries.delete(key);
    try {
      this.options.dispose(entry.value, key);
    } catch (err) {
      console.error(`[warm] letting ${key} go failed`, err);
    }
  }
}
