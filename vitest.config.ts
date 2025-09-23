import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Environment
    environment: 'node',

    // Test files
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],

    // Coverage
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'coverage/**',
        'dist/**',
        'packages/*/test{,s}/**',
        '**/*.d.ts',
        'cypress/**',
        'test{,s}/**',
        'test{,-*}.{js,cjs,mjs,ts,tsx,jsx}',
        '**/*{.,-}test.{js,cjs,mjs,ts,tsx,jsx}',
        '**/*{.,-}spec.{js,cjs,mjs,ts,tsx,jsx}',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
        '**/.{eslint,mocha,prettier}rc.{js,cjs,yml}',
      ],
    },

    // Globals
    globals: true,

    // Setup
    setupFiles: [],

    // Timeouts
    testTimeout: 10000,
    hookTimeout: 10000,

    // Watch mode
    watch: false,

    // Reporter
    reporter: ['verbose'],

    // Parallelism
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false,
      },
    },
  },

  // Resolve aliases to match your TypeScript paths
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@libs': path.resolve(__dirname, './src/libs'),
      '@push': path.resolve(__dirname, './src/push'),
      '@proto': path.resolve(__dirname, './src/proto'),
      '@utils': path.resolve(__dirname, './src/utils'),
    },
  },

  // ESM support
  esbuild: {
    target: 'node18',
  },
});
