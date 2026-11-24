import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type Later = (run: () => void) => () => void;

const UNPAINTED_WAIT_MS = 250;
const LONGEST_ENTRANCE_MS = 1_000;

export const afterPaint: Later = (run) => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let frame: number | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    for (const t of timers) clearTimeout(t);
  };
  const go = () => {
    if (stopped) return;
    stop();
    run();
  };
  const after = (ms: number) => timers.add(setTimeout(go, ms));
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(() => {
      frame = null;
      after(0);
    });
  }
  after(UNPAINTED_WAIT_MS);
  return stop;
};

function entrancesPlaying(): Promise<unknown>[] {
  if (typeof document.getAnimations !== 'function') return [];
  return document
    .getAnimations()
    .filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
    .map((a) => a.finished.catch(() => undefined));
}

export const afterShown: Later = (run) => {
  let stopped = false;
  let stopLater = afterPaint(() => {
    let longest: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise((done) => (longest = setTimeout(done, LONGEST_ENTRANCE_MS)));
    void Promise.race([Promise.all(entrancesPlaying()), cut]).then(() => {
      clearTimeout(longest);
      if (!stopped) stopLater = afterPaint(run);
    });
  });
  return () => {
    stopped = true;
    stopLater();
  };
};

export type Arrival<T> = { kind: 'waiting' } | { kind: 'ready'; value: T } | { kind: 'failed'; error: unknown };

const WAITING: Arrival<never> = { kind: 'waiting' };

export function useLoadOnceShown<T>(key: string | null, load: () => Promise<T>, later: Later = afterShown): Arrival<T> {
  const latest = useRef(load);
  useLayoutEffect(() => {
    latest.current = load;
  });
  const [arrived, setArrived] = useState<{ key: string; arrival: Arrival<T> } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    const settle = (arrival: Arrival<T>) => {
      if (live) setArrived({ key, arrival });
    };
    const stop = later(() => {
      latest
        .current()
        .then((value) => settle({ kind: 'ready', value }))
        .catch((error: unknown) => settle({ kind: 'failed', error }));
    });
    return () => {
      live = false;
      stop();
    };
  }, [key, later]);
  return key !== null && arrived?.key === key ? arrived.arrival : WAITING;
}
