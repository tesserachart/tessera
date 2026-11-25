import { computeBackoffDelay, DEFAULT_BACKOFF, Runtime, type BackoffOptions, type TopicName } from '@tessera/protocol';
import { appClient } from './services.ts';
import type { TopicData, TopicParams } from './topics.ts';

export const READ_AGAIN_MS = 5_000;

export class Lifetime {
  private readonly stops = new Set<() => void>();
  private tasks = 0;
  private generation = 0;

  hold(stop: () => void): () => void {
    let stopped = false;
    const once = () => {
      if (stopped) return;
      stopped = true;
      this.stops.delete(once);
      stop();
    };
    this.stops.add(once);
    return once;
  }

  topic<T extends TopicName>(
    name: T,
    params: TopicParams<T>,
    sink: (signal: Runtime.TopicSignal<TopicData<T>>) => void,
    options?: Runtime.TopicReadOptions,
  ): () => void {
    try {
      return this.hold(Runtime.topic(appClient(), name, params, sink, options));
    } catch (error) {
      console.error(`[lifetime] could not subscribe to ${name}`, error);
      return () => undefined;
    }
  }

  run<A>(task: () => Promise<A>, apply: (value: A) => void, failed?: (error: unknown) => void): void {
    const live = this.live();
    this.tasks++;
    const generation = this.generation;
    const settle = () => {
      if (generation === this.generation) this.tasks--;
    };
    const fail = (error: unknown) => {
      if (failed) failed(error);
      else console.error('[lifetime] a task failed', error);
    };
    let started: Promise<A>;
    try {
      started = task();
    } catch (error) {
      started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    started.then(
      (value) => {
        settle();
        if (!live()) return;
        try {
          apply(value);
        } catch (error) {
          console.error('[lifetime] applying an answer failed', error);
        }
      },
      (error: unknown) => {
        settle();
        if (live()) fail(error);
      },
    );
  }

  every(ms: number, fn: () => void): () => void {
    const id = setInterval(fn, ms);
    return this.hold(() => {
      clearInterval(id);
    });
  }

  after(ms: number, fn: () => void): () => void {
    const stop = this.hold(() => {
      clearTimeout(id);
    });
    const id = setTimeout(() => {
      stop();
      fn();
    }, ms);
    return stop;
  }

  live(): () => boolean {
    const generation = this.generation;
    return () => generation === this.generation;
  }

  end(): void {
    this.generation++;
    this.tasks = 0;
    for (const stop of [...this.stops]) stop();
    this.stops.clear();
  }

  get running(): number {
    return this.stops.size + this.tasks;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepOrWake(ms: number, wake?: (resume: () => void) => () => void): Promise<void> {
  if (!wake) return sleep(ms);
  return new Promise((resolve) => {
    let off: (() => void) | null = null;
    const done = () => {
      clearTimeout(timer);
      off?.();
      resolve();
    };
    const timer = setTimeout(done, ms);
    off = wake(done);
  });
}

export async function retrying<A>(
  task: () => Promise<A>,
  options: {
    again: (error: unknown) => boolean;
    live?: () => boolean;
    backoff?: BackoffOptions;
    wake?: (resume: () => void) => () => void;
  },
): Promise<A> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (!options.again(error) || options.live?.() === false) throw error;
      await sleepOrWake(computeBackoffDelay(attempt, options.backoff ?? DEFAULT_BACKOFF), options.wake);
      if (options.live?.() === false) throw error;
    }
  }
}
