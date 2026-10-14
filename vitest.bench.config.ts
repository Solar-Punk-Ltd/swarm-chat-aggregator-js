import { defineConfig } from 'vitest/config';

// The benches report timings and assert only correctness, so they stay out of `pnpm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/bench/**/*.bench.ts'],
  },
});
