import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Source only. Without this, vitest also discovers the COMPILED copies in
    // dist/ and every suite runs twice — which for the boundary tests means two
    // testcontainer Postgres instances per run, for identical assertions.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],

    // Testcontainers pulls and boots a Postgres image on first run.
    testTimeout: 60_000,
    hookTimeout: 180_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'dist', '**/*.test.ts'],
    },
  },
});
