import { MutationObserver } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { queryClient } from './queries.ts';

export type Reply<O> =
  | { readonly kind: 'done'; readonly value: O }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'superseded' };

export interface WriteOptions {
  readonly scope?: string | undefined;
}

const SUPERSEDED = { kind: 'superseded' } as const;

export class LatestWrite<I, O> {
  private readonly observer: MutationObserver<O, unknown, I>;
  private supersede: (() => void) | null = null;

  constructor(write: (input: I) => Promise<O>, options: WriteOptions = {}) {
    this.observer = new MutationObserver<O, unknown, I>(queryClient, {
      mutationFn: write,
      networkMode: 'always',
      ...(options.scope === undefined ? {} : { scope: { id: options.scope } }),
    });
    this.observer.subscribe(() => undefined);
  }

  send(input: I): Promise<Reply<O>> {
    this.supersede?.();
    return new Promise((resolve) => {
      const superseded = () => {
        resolve(SUPERSEDED);
      };
      const settle = (reply: Reply<O>) => {
        if (this.supersede === superseded) this.supersede = null;
        resolve(reply);
      };
      this.supersede = superseded;
      this.observer
        .mutate(input, {
          onSuccess: (value) => {
            settle({ kind: 'done', value });
          },
          onError: (error) => {
            settle({ kind: 'failed', error });
          },
        })
        .catch(() => undefined);
    });
  }

  drop(): void {
    this.supersede?.();
    this.supersede = null;
    this.observer.reset();
  }

  get pending(): boolean {
    return this.observer.getCurrentResult().isPending;
  }

  readonly subscribe = (listener: () => void): (() => void) =>
    this.observer.subscribe(() => {
      listener();
    });
}

export function useLatestWrite<I, O>(
  write: (input: I) => Promise<O>,
  options: WriteOptions = {},
): { readonly write: LatestWrite<I, O>; readonly pending: boolean } {
  const current = useRef(write);
  useEffect(() => {
    current.current = write;
  });
  const [latest] = useState(() => new LatestWrite((input: I) => current.current(input), options));
  const pending = useSyncExternalStore(latest.subscribe, () => latest.pending);
  useEffect(() => () => latest.drop(), [latest]);
  return { write: latest, pending };
}
