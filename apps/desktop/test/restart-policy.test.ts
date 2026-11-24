import { describe, expect, it } from 'vitest';
import { RestartPolicy } from '../dev/restart-policy.ts';

describe('RestartPolicy', () => {
  it('backs off exponentially while starts keep failing, capped', () => {
    const p = new RestartPolicy();
    const delays = Array.from({ length: 8 }, () => p.failedBeforeReady('error[E0308]').delayMs);
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    expect(p.consecutiveFailures).toBe(8);
  });

  it('reports a repeated failure once', () => {
    const p = new RestartPolicy();
    expect(p.failedBeforeReady('error A').repeated).toBe(false);
    expect(p.failedBeforeReady('error A').repeated).toBe(true);
    expect(p.failedBeforeReady('error B').repeated).toBe(false);
    expect(p.failedBeforeReady('error B').repeated).toBe(true);
  });

  it('resets after a ready line', () => {
    const p = new RestartPolicy();
    p.failedBeforeReady('error');
    p.failedBeforeReady('error');
    p.ready();
    expect(p.consecutiveFailures).toBe(0);
    expect(p.exitedAfterReady()).toEqual({ delayMs: 1000, repeated: false });
    expect(p.failedBeforeReady('error').delayMs).toBe(1000);
    expect(p.failedBeforeReady('error')).toEqual({ delayMs: 2000, repeated: true });
  });
});
