import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
  },
});
