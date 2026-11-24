import { MOTION } from './tokens.ts';

export type ToastTone = 'ok' | 'info' | 'err';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  detail?: string | null;
  action?: ToastAction | null;
  key?: string | null;
  ms?: number | null;
  onClose?: () => void;
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  detail: string | null;
  action: ToastAction | null;
  key: string | null;
  ms: number | null;
  state: 'open' | 'closed';
}

export const TOAST_MS: Record<ToastTone, number | null> = { ok: 4000, info: 6000, err: null };
export const TOAST_MAX = 3;
export const TOAST_EXIT_MS = MOTION.panelOutMs;
export const TOAST_RESUME_MIN_MS = 1500;

export function arrive(
  list: readonly ToastItem[],
  item: ToastItem,
  max = TOAST_MAX,
): { list: ToastItem[]; gone: ToastItem[] } {
  const open = list.filter((t) => t.state === 'open');
  const replaced = new Set(
    open
      .filter(
        (t) =>
          (item.key !== null && t.key === item.key) ||
          (t.tone === item.tone && t.title === item.title && t.detail === item.detail),
      )
      .map((t) => t.id),
  );
  const staying = open.filter((t) => !replaced.has(t.id));
  const pushed = new Set(staying.slice(0, Math.max(0, staying.length + 1 - max)).map((t) => t.id));
  const gone = open.filter((t) => replaced.has(t.id) || pushed.has(t.id));
  const goneIds = new Set(gone.map((t) => t.id));
  const next = list.map((t) => (goneIds.has(t.id) ? { ...t, state: 'closed' as const } : t));
  return { list: [...next, item], gone };
}

export interface ToastQueue {
  push: (input: ToastInput) => number;
  dismiss: (which: number | string) => void;
  act: (id: number) => void;
  clear: () => void;
  pause: () => void;
  resume: () => void;
  getSnapshot: () => readonly ToastItem[];
  subscribe: (listener: () => void) => () => void;
}

export function createToastQueue(opts: { max?: number } = {}): ToastQueue {
  const max = opts.max ?? TOAST_MAX;
  let list: readonly ToastItem[] = [];
  let seq = 0;
  let paused = false;
  const listeners = new Set<() => void>();
  const clocks = new Map<number, { timer: ReturnType<typeof setTimeout> | null; left: number; since: number }>();
  const closers = new Map<number, () => void>();

  const emit = () => {
    for (const l of listeners) l();
  };
  const start = (id: number, ms: number) => {
    const timer = paused ? null : setTimeout(() => close([id]), ms);
    clocks.set(id, { timer, left: ms, since: Date.now() });
  };
  const stop = (id: number) => {
    const c = clocks.get(id);
    if (c?.timer) clearTimeout(c.timer);
    clocks.delete(id);
  };
  const settle = (ids: readonly number[]) => {
    for (const id of ids) {
      stop(id);
      const done = closers.get(id);
      closers.delete(id);
      done?.();
      setTimeout(() => {
        list = list.filter((t) => t.id !== id);
        emit();
      }, TOAST_EXIT_MS);
    }
  };
  const close = (ids: readonly number[]) => {
    const ending = new Set(list.filter((t) => t.state === 'open' && ids.includes(t.id)).map((t) => t.id));
    if (ending.size === 0) return;
    list = list.map((t) => (ending.has(t.id) ? { ...t, state: 'closed' as const } : t));
    settle([...ending]);
    emit();
  };

  return {
    push(input) {
      const tone = input.tone ?? 'ok';
      const item: ToastItem = {
        id: ++seq,
        tone,
        title: input.title,
        detail: input.detail ?? null,
        action: input.action ?? null,
        key: input.key ?? null,
        ms: input.ms === undefined ? TOAST_MS[tone] : input.ms,
        state: 'open',
      };
      const r = arrive(list, item, max);
      list = r.list;
      if (input.onClose) closers.set(item.id, input.onClose);
      settle(r.gone.map((t) => t.id));
      if (item.ms !== null) start(item.id, item.ms);
      emit();
      return item.id;
    },
    dismiss(which) {
      close(list.filter((t) => (typeof which === 'number' ? t.id === which : t.key === which)).map((t) => t.id));
    },
    act(id) {
      const t = list.find((x) => x.id === id && x.state === 'open');
      if (!t) return;
      t.action?.run();
      close([id]);
    },
    clear() {
      close(list.map((t) => t.id));
    },
    pause() {
      if (paused) return;
      paused = true;
      const now = Date.now();
      for (const c of clocks.values()) {
        if (c.timer) clearTimeout(c.timer);
        c.timer = null;
        c.left = Math.max(0, c.left - (now - c.since));
      }
    },
    resume() {
      if (!paused) return;
      paused = false;
      for (const [id, c] of clocks) start(id, Math.max(c.left, TOAST_RESUME_MIN_MS));
    },
    getSnapshot: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
