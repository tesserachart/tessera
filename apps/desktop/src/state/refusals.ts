import { makeStore, patch, read, useStore } from '../app/store.ts';

export interface OrderRefusal {
  accountId: string;
  instrument: string;
  text: string;
  what: string;
}

const refusalStore = makeStore<{ last: OrderRefusal | null }>({ last: null });

export function noteRefusal(r: OrderRefusal): void {
  patch(refusalStore, { last: r });
}

export function clearRefusal(accountId: string | null, instrument: string | null = null): void {
  const last = read(refusalStore).last;
  if (last?.accountId === accountId && (instrument === null || last.instrument === instrument))
    patch(refusalStore, { last: null });
}

export function useRefusal(accountId: string | null, ids: ReadonlySet<string>): OrderRefusal | null {
  return useStore(refusalStore, (s) => (s.last?.accountId === accountId && ids.has(s.last.instrument) ? s.last : null));
}
