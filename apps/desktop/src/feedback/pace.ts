import { afterPaint } from '../app/onceShown.ts';

const SLICE_MS = 8;

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    afterPaint(resolve);
  });
}

export type Slice = () => Promise<void> | undefined;

export function timeSlicer(sliceMs = SLICE_MS, pause: () => Promise<void> = nextFrame): Slice {
  let started = performance.now();
  return () => {
    if (performance.now() - started < sliceMs) return undefined;
    return pause().then(() => {
      started = performance.now();
    });
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
