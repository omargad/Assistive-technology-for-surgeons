import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Simulated sessions are summarised on upload; give slow CI machines headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
