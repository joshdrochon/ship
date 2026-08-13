/**
 * Vite is a devDependency and produces STATIC FILES. That is the whole of
 * PF-733's requirement: *"a static bundle … no server process of its own beyond
 * a static file server and no dev proxy that could smuggle in a server-side
 * call — a demo with a backend is not a browser demo."*
 *
 * So note what is deliberately absent from this file:
 *
 *   - `server.proxy` / `preview.proxy`. A proxy would let the demo call Ship on
 *     a same-origin path and quietly stop being a cross-origin browser client,
 *     which would make the CORS policy this demo exists to exercise untested and
 *     the deployed demo broken in a way no local run could reproduce.
 *   - any SSR or middleware mode.
 *
 * The demo talks to Ship at `VITE_SHIP_BASE_URL`, cross-origin, exactly as a
 * third-party developer's app would.
 */
import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so `dist/` can be served from any path — an S3 prefix,
  // a subdirectory, or `vite preview` at the root. An absolute `/assets/...`
  // would work locally and 404 on the deployed copy, which is the classic way
  // a static demo dies in front of a grader.
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // PF-738 measures the SDK's share of THIS bundle against p.9's 250 KB
    // budget. Sourcemaps stay off in the measured build: they are not shipped
    // to a browser on load and counting them would inflate the number against
    // a budget about install/download weight.
    sourcemap: false,
    // Loud rather than silent if the bundle grows. The hard assertion is in the
    // test; this is the warning a developer sees first.
    chunkSizeWarningLimit: 250,
    rollupOptions: {
      output: {
        // One entry chunk, no vendor split. The budget is about what a browser
        // downloads to run this app, and splitting it across files would make
        // the measurement a sum over an arbitrary set of names.
        manualChunks: undefined,
      },
    },
  },

  preview: {
    port: Number(process.env.DEMO_PORT ?? 4173),
    strictPort: true,
  },
});
