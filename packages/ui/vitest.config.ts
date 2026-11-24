import { defineProject } from 'vitest/config';
import { HANG_GUARD_MS } from '../../vitest.hang-guards.ts';

export default defineProject({
  test: {
    name: 'ui',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/support/waits.ts'],
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
  },
});
