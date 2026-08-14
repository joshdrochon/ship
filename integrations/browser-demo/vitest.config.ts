import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ONLY `*.test.ts`. Vitest's default glob also matches `*.spec.ts`, which
    // is what the Playwright suite in this same directory is named — running
    // those under vitest produces a confusing "test.describe is not a
    // function" rather than a useful failure.
    include: ['tests/**/*.test.ts'],
    // These build and measure a real bundle; the default 5 s is not enough and
    // a timeout here should mean something is wrong, not that the box is busy.
    testTimeout: 120_000,
  },
});
