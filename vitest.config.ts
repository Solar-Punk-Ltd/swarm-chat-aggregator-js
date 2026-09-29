import { defineConfig } from 'vitest/config';

// Every suite runs twice, because Bee answers a read of a chunk nobody stored with 404 on some versions and with
// 500 on others, and the server must be right under both.
const absentChunkAnswers = ['404', '500'];

export default defineConfig({
  test: {
    // A backstop against a hang rather than a margin anything relies on.
    testTimeout: 30_000,
    projects: absentChunkAnswers.map((status) => ({
      test: {
        name: `absent chunk answers ${status}`,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        env: { FAKE_ABSENT_STATUS: status },
      },
    })),
  },
});
