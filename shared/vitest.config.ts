import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Source only — dist/ holds compiled copies that would run every suite twice.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
