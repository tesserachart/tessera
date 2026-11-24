import { afterEach } from 'vitest';

export function cleanupsAfterEach(): (() => void)[] {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  return cleanups;
}
