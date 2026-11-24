import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: 'chart',
          root: 'packages/chart',
          environment: 'node',
          include: ['test/**/*.perf.ts'],
          setupFiles: [resolve(import.meta.dirname, 'packages/chart/test/fonts.ts')],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'desktop',
          root: 'apps/desktop',
          environment: 'happy-dom',
          env: { TZ: 'America/New_York' },
          include: ['test/**/*.perf.ts'],
        },
      },
    ],
  },
});
