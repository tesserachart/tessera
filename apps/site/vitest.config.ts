import { defineProject } from 'vitest/config';
import { HANG_GUARD_MS } from '../../vitest.hang-guards.ts';

export default defineProject({
  test: {
    name: 'site',
    include: ['test/**/*.test.ts'],
    testTimeout: HANG_GUARD_MS,
    hookTimeout: HANG_GUARD_MS,
  },
});
