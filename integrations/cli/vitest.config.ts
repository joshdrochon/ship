import { defineConfig } from 'vitest/config';

/**
 * The fast suite: everything that does not need a booted Ship.
 *
 * The server-backed suite is a SEPARATE config (`vitest.server.config.ts`) so
 * `pnpm --filter @ship/cli test` stays runnable on a laptop with no database,
 * and so a CI job can run the two at different times without a name filter.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/server/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
