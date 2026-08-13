import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `src/` only. Without this, a built `dist/` in a working tree gets picked
    // up and the suite silently runs against stale compiled output.
    include: ['src/**/*.test.ts'],
    // The live-server test boots a real Express app and binds a port; the rest
    // are pure. One file at a time keeps the port allocation trivial and the
    // failure output readable.
    fileParallelism: false,
  },
});
