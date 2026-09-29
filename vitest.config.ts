import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // A backstop against a hang rather than a margin anything relies on.
    testTimeout: 30_000,
  },
});
