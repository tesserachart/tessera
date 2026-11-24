import type { PoolTimers } from '../../src/app/warm.ts';

export function manualTimers(): PoolTimers & { run(ms: number): void; pending(): number } {
  let now = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    set: (fn, ms) => {
      const id = next++;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (h) => {
      due.delete(h as number);
    },
    run: (ms) => {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at > now) continue;
        due.delete(id);
        t.fn();
      }
    },
    pending: () => due.size,
  };
}
