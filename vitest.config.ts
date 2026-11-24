import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop', 'apps/cloud', 'apps/site', 'scripts', 'e2e'],
  },
});
