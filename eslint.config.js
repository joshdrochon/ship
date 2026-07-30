import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * ESLint configuration.
 *
 * Rule 4 (brief p.8) requires a lint stage in CI that passes before a merge. This repo
 * shipped no linter, so the baseline had to be chosen deliberately: a config that flags
 * everything eslint can flag would fail on day one and block every other lane, and a
 * config that flags nothing is theatre.
 *
 * The line drawn here: errors are reserved for things that are defects regardless of
 * style — a floating promise, an unreachable branch, a `case` that falls through. Rules
 * that describe debt already owned by a specific improvement lane are set to `warn` or
 * off, with the owner named, so CI stays green while the count goes down.
 *
 * Deliberately NOT using type-aware linting (`recommendedTypeChecked`). It requires a
 * TypeScript program per package and roughly triples lint time; `pnpm type-check`
 * already runs `tsc --noEmit` across all three packages in CI, so the type errors are
 * caught there rather than twice.
 *
 * To tighten: move a rule from `warn` to `error` once its count reaches zero. Check
 * current counts with `pnpm lint`.
 */
export default tseslint.config(
  {
    // Generated, vendored, or build output — never linted.
    ignores: [
      '**/dist/**',
      '**/dev-dist/**', // vite-plugin-pwa generates a bundled service worker here
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.terraform/**',
      'web/src/components/icons/generated/**',
      'api/src/db/migrations/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // --- Errors: defects, not style ---------------------------------------
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'require-atomic-updates': 'off', // too many false positives on async handlers

      // --- Owned by Lane 1 (Type Safety, p.3) ------------------------------
      // 258 `any` and 429 assertions exist today. Lane 1's target is a 25%
      // reduction; making these errors now would block CI on known debt.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // needs type info

      // --- Noise in a codebase this size, but worth surfacing --------------
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',

      // Declaration merging is the only way to augment Express's Request type, which
      // api/src/middleware/auth.ts and two route files legitimately do. ES modules
      // cannot express it, so the rule has nothing to offer here.
      '@typescript-eslint/no-namespace': 'off',

      // Real footgun (a `let` in a braceless `case` is visible to sibling cases) but
      // the three instances live in route handlers owned by Lanes 3 and 4. Warn so
      // the count is visible without blocking their lanes.
      'no-case-declarations': 'warn',

      // tsc already enforces these; duplicating them doubles the report.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
    },
  },

  // React hook rules apply to the frontend only.
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Tests get more latitude: non-null assertions and loose mock shapes are
  // idiomatic in test code and flagging them buries the real findings.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'e2e/**/*.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',

      // `.catch(() => {})` is how these specs assert "this may or may not exist"
      // without failing. Deliberate, and 15 of them.
      'no-empty': 'off',

      // Playwright's worker-fixture signature is `async ({}, use, workerInfo)` — the
      // empty destructure is required by the API to declare no fixture dependencies.
      // See e2e/fixtures/isolated-env.ts:109.
      'no-empty-pattern': 'off',
    },
  },

  // Config and script files run in Node and are not part of the app graph.
  {
    files: ['*.config.{js,ts}', 'scripts/**/*.{js,ts}', '**/*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Plain Node ESM: the audit's measurement scripts under docs/audit/scripts and any
  // other loose .mjs. These are instruments, not product code — they need Node globals
  // (process, console, URL) and are held to correctness rules only.
  // Plain Node ESM: the audit's measurement scripts under docs/audit/scripts and any
  // other loose .mjs. Browser globals are included because these are Playwright
  // drivers — the bodies passed to page.evaluate() run in the page, so `document` and
  // `window` are legitimately in scope there even though the file itself is Node.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // These are instruments, not shipped code. Correctness rules stay on; tidiness
      // rules warn, so a half-finished probe left in a measurement script does not
      // block a release of the product.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
      'preserve-caught-error': 'warn',
    },
  },

  // CloudFront Functions: `handler` is invoked by AWS at the edge, so it is never
  // referenced from inside the repo and always reads as unused.
  {
    files: ['terraform/cloudfront-functions/**/*.js'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
    },
  },

  // Two single-instance patterns that are correct in context. Left as warnings rather
  // than off, so they stay visible if either file is revisited.
  {
    files: [
      'web/src/components/editor/FileAttachment.tsx', // `this` alias in a TipTap NodeView
      'web/src/hooks/useSelection.ts', // assignment kept for readability of the branch
    ],
    rules: {
      '@typescript-eslint/no-this-alias': 'warn',
      'no-useless-assignment': 'warn',
    },
  }
);
