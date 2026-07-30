import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import svgr from 'vite-plugin-svgr';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// Read API port from environment or .ports file (created by scripts/dev.sh)
function getApiPort(): number {
  // Check for explicit API_PORT env var first (used by testcontainers)
  if (process.env.API_PORT) {
    return parseInt(process.env.API_PORT, 10);
  }

  const portsFile = resolve(__dirname, '../.ports');
  if (existsSync(portsFile)) {
    const content = readFileSync(portsFile, 'utf-8');
    const match = content.match(/^API=(\d+)/m);
    if (match) return parseInt(match[1], 10);
  }
  // Fallback to default
  return 3000;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiPort = getApiPort();

  // Proxy configuration shared between dev and preview servers
  const proxyConfig = {
    '/api': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
    },
    '/collaboration': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
      ws: true,
    },
    '/events': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    plugins: [
      react(),
      svgr({
        // Allow importing SVGs as React components with ?react suffix
        // e.g., import CheckIcon from '@uswds/uswds/dist/img/usa-icons/check.svg?react'
        svgrOptions: {
          // Use currentColor for fill to match existing icon patterns
          plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
          svgoConfig: {
            plugins: [
              {
                name: 'preset-default',
                params: {
                  overrides: {
                    removeViewBox: false,
                  },
                },
              },
              // Replace hardcoded colors with currentColor
              {
                name: 'convertColors',
                params: {
                  currentColor: true,
                },
              },
            ],
          },
        },
      }),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: parseInt(env.VITE_PORT || '5173'),
      strictPort: true,
      proxy: proxyConfig,
    },
    build: {
      rollupOptions: {
        output: {
          /**
           * Vendor chunking.
           *
           * Route-level `import()` in main.tsx decides *when* a dependency is
           * fetched. This decides *what it is grouped with*, which route
           * splitting alone gets wrong: every editor-bearing route shares one
           * ~836 kB chunk (Rollup names it after an arbitrary member module),
           * so a one-line change to a TipTap extension invalidates ProseMirror,
           * Yjs and highlight.js in every user's cache too.
           *
           * Rules for editing this:
           *
           *  - Group by library, never "everything in node_modules". A single
           *    vendor chunk would put React — which the entry needs — in the
           *    same chunk as TipTap, dragging the whole editor stack back into
           *    the initial load and undoing the route split.
           *  - react/react-dom/scheduler stay together. Splitting them apart is
           *    the classic source of "Cannot access X before initialization" at
           *    runtime, from a cycle between the emitted chunks.
           *  - Only leaf-ish library clusters below. App code is deliberately
           *    absent: its chunking is already expressed by the route
           *    boundaries, and naming it here would fight them.
           *
           * A group listed here is not automatically in the initial load. It is
           * fetched when something that imports it is fetched — so `syntax` and
           * `editor` load with the first document route, not with /login.
           */
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;

            // highlight.js language definitions, 8.1% of the bundle per the
            // audit. Reached only through the editor's code-block extension.
            if (id.includes('highlight.js') || id.includes('/lowlight/')) {
              return 'vendor-syntax';
            }
            // Full emoji dataset. Already behind its own import() boundary in
            // EmojiPicker.tsx; naming it keeps it from being merged into a
            // neighbouring route chunk.
            if (id.includes('emoji-picker-react')) return 'vendor-emoji';

            if (id.includes('@tiptap') || id.includes('/prosemirror-')) {
              return 'vendor-editor';
            }
            if (
              id.includes('/yjs/') ||
              id.includes('/y-websocket/') ||
              id.includes('/y-protocols/') ||
              id.includes('/y-indexeddb/') ||
              id.includes('/lib0/')
            ) {
              return 'vendor-collab';
            }
            // These four look redundant — they are statically reachable from
            // the entry, so they land in the initial load with or without a
            // name. They are not redundant, and removing them is measurably
            // wrong. React is imported both by the entry and by modules inside
            // vendor-editor. Left unnamed, Rollup resolves that shared
            // ownership by folding React into vendor-editor, which makes
            // vendor-editor a static dependency of the entry and drags all of
            // TipTap and ProseMirror back into the initial load:
            //
            //   with these lines      385,118 B initial
            //   without them          940,969 B initial   (vendor-editor 620 kB
            //                                              promoted into index.html)
            //
            // Naming React gives it a chunk that vendor-editor can depend on
            // instead of absorbing. react-dom and scheduler stay in the same
            // group on purpose: splitting them apart is the usual source of
            // "Cannot access X before initialization" from a cycle between the
            // emitted chunks.
            if (id.includes('react-router')) return 'vendor-router';
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'vendor-react';
            }
            if (id.includes('@tanstack')) return 'vendor-query';
          },
        },
      },
    },
    // Preview server config - used by `vite preview` for E2E tests
    // This is MUCH lighter weight than the dev server (no HMR, no watchers)
    preview: {
      port: parseInt(env.VITE_PORT || '4173'),
      strictPort: true,
      proxy: proxyConfig,
    },
  };
});
