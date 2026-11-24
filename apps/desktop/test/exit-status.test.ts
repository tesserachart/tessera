// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { launcherExitStatus } from '../dev/exit-status.ts';

describe('launcher exit status', () => {
  it('is 0 when Ctrl-C or SIGTERM stopped the child on purpose', () => {
    for (const stop of ['SIGINT', 'SIGTERM'] as const) {
      expect(launcherExitStatus(stop, null, 'SIGINT')).toBe(0);
      expect(launcherExitStatus(stop, null, 'SIGTERM')).toBe(0);
      expect(launcherExitStatus(stop, 0, null)).toBe(0);
      expect(launcherExitStatus(stop, 130, null)).toBe(0);
      expect(launcherExitStatus(stop, 143, null)).toBe(0);
    }
  });

  it('keeps a real failure, during a stop or not', () => {
    expect(launcherExitStatus('SIGINT', 101, null)).toBe(101);
    expect(launcherExitStatus('SIGINT', null, 'SIGSEGV')).toBe(1);
    expect(launcherExitStatus(null, 2, null)).toBe(2);
    expect(launcherExitStatus(null, 0, null)).toBe(0);
    expect(launcherExitStatus(null, null, 'SIGINT')).toBe(1);
    expect(launcherExitStatus(null, 130, null)).toBe(130);
  });
});
