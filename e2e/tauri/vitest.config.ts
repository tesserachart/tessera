import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'tauri-windows',
    environment: 'node',
    include: ['e2e/tauri/**/*.tauri.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
