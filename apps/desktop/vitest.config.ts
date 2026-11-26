import { defineProject } from 'vitest/config';
import { HANG_GUARD_MS } from '../../vitest.hang-guards.ts';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'happy-dom',
    env: { TZ: 'America/New_York' },
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/support/waits.ts', '../../vitest.animations.ts'],
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
  },
});
