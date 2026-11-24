export type FrameScheduler = (cb: () => void) => () => void;

const due = new Set<() => void>();
let pending = false;

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function runDue(): void {
  pending = false;
  const now = [...due];
  due.clear();
  for (const cb of now) cb();
}

export const animationFrame: FrameScheduler = (cb) => {
  const once = () => cb();
  due.add(once);
  if (!pending) {
    pending = true;
    nextFrame(runDue);
  }
  return () => {
    due.delete(once);
  };
};
