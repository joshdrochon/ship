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
      // Agent worktrees are checkouts of this repo. Linting them reports every
      // pre-existing problem once per worktree, which buried 40 duplicate errors
      // in a run that was otherwise clean.
      '.claude/worktrees/**',
      '**/dist/**',
      '**/dev-dist/**', // vite-plugin-pwa generates a bundled service worker here
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.terraform/**',
      'web/src/components/icons/generated/**',
      'api/src/db/migrations/**',

      // Deliberate boundary violations. These files exist to be rejected, so a
      // normal `pnpm lint` must not see them or the tree could never be green.
      // `pnpm lint:boundary` re-runs eslint over them with --no-ignore and
      // asserts each one FAILS with the right message (PF-012).
      'eslint-fixtures/**',
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

  // --- PlugForge boundary rules (Week 6) --------------------------------------
  //
  // Four fences. The public/internal split is a one-way door (PRD Critical
  // Guidance, p.11), and Build Strategy §2 (p.10) says to add the rule "before
  // you have any cross-imports to lint" — which is why these ship in the same
  // week the directories were created and not after the first violation.
  //
  // Every fence has a negative fixture under eslint-fixtures/ and
  // `pnpm lint:boundary` asserts lint actually FAILS on each one. A rule that
  // never fires is an untested rule (PF-012).
  //
  // Known limit, stated rather than papered over: `no-restricted-imports` sees
  // static `import`/`export ... from` specifiers only. It does not see
  // `require()` or dynamic `import()`. The workspace-dependency half of the
  // fence (scripts/check-boundary-lint.mjs, PF-011) is what covers the case
  // where someone reaches for the API package rather than a path.

  // Fence 1 + 2 (PF-009, PF-010) — platform/ may not import internal route files
  // or internal middleware.
  //
  // PF-009 names platform/api/v1/**; the glob here is all of platform/**, which
  // is strictly stronger and matches what platform/README.md documents. There is
  // no module under platform/ that has any business calling an internal route.
  //
  // The fixture globs sit alongside the real ones so the fixtures are linted by
  // the same rule object, not by a copy of it that could drift.
  {
    files: ['api/src/platform/**/*.ts', 'eslint-fixtures/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/routes/**', '**/routes/*', '@ship/api/routes/*'],
              message:
                'BOUNDARY (platform → routes): platform/ must not import internal route files. The route file IS the internal HTTP surface — call the domain service it calls (utils/, services/) and attach the platform middleware stack instead. See api/src/platform/README.md.',
            },
            {
              group: ['**/middleware/**', '**/middleware/*', '@ship/api/middleware/*'],
              message:
                'BOUNDARY (platform → middleware): platform/ has its own stack (bearer auth, scopes, token bucket, audit). The internal session/CSRF stack does not apply to /api/v1 and must stay byte-for-byte what Part 1 shipped. See api/src/platform/README.md.',
            },
          ],
        },
      ],
    },
  },

  // Fence 3 (PF-011) — integrations/ may import ONLY @ship/sdk.
  //
  // Integrations are strangers. If a command needs something the SDK cannot do,
  // that is an SDK gap — fix it there, never by importing server code. This is
  // what makes "the agent is a platform citizen" true rather than aspirational
  // when the Epic 7 rewire lands.
  {
    files: ['integrations/**/*.ts', 'eslint-fixtures/integrations/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@ship/api',
                '@ship/api/*',
                '@ship/agent',
                '@ship/agent/*',
                '@ship/shared',
                '@ship/shared/*',
                '@ship/web',
                '@ship/web/*',
                '**/api/src/**',
                '**/api/dist/**',
                '**/agent/src/**',
                '**/shared/src/**',
                '**/web/src/**',
              ],
              message:
                'BOUNDARY (integrations → server): integrations/ may import only @ship/sdk — the front door, same as any external developer. A deep-relative path into api/ is the same violation as importing @ship/api. See api/src/platform/README.md.',
            },
          ],
        },
      ],
    },
  },

  // Fence 5 (L23 PF-692) — agent/ may not import api/src/.
  //
  // p.11 is categorical about what makes citizenship real: "External integrations
  // live in integrations/ and import only @ship/sdk — never api/src/. Enforced by
  // a workspace dependency rule. This is what makes 'the agent is a platform
  // citizen' true rather than aspirational."
  //
  // Fence 3 fences `integrations/**` and NOT `agent/**` — the agent predates that
  // rule and does not live in that directory. Moving the package late in the week
  // would drag the whole build graph (shared → agent → api) and the cron
  // entrypoint's deployment with it, so the rule is extended where the package
  // stands instead.
  //
  // ── Narrower than fence 3, deliberately ─────────────────────────────────────
  // `@ship/shared` stays ALLOWED. The agent's business-day arithmetic and its
  // circuit breaker live there and always have; `circuitBreaker.ts` was moved into
  // `@ship/shared` precisely so the agent would stop reaching into `api/dist`.
  // Banning it here would be a rewrite wearing a lint rule.
  //
  // What is banned is the direction the rewire removes: `api/src/**`, `api/dist/**`
  // and `@ship/api`. The REVERSE direction stays and is correct —
  // `api/src/routes/fleetgraph/agentBridge.ts` imports `@ship/agent` to trigger a
  // chat turn, which is Ship invoking its own app, not the agent reaching around
  // the front door. `docs/architecture.md`'s before-diagram is relabelled to say so.
  {
    files: ['agent/**/*.ts', 'eslint-fixtures/agent/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@ship/api',
                '@ship/api/*',
                '@ship/web',
                '@ship/web/*',
                '**/api/src/**',
                '**/api/dist/**',
                '**/web/src/**',
              ],
              message:
                "BOUNDARY (agent → server): the agent is a platform citizen — it reaches Ship through @ship/sdk, the same front door as any external developer, never through api/src/. p.11 makes this the rule that decides whether 'the agent is a platform citizen' is true or aspirational. @ship/shared and @ship/sdk are fine; api/ is not.",
            },
          ],
        },
      ],
    },
  },

  // Fence 4 (F24) — sdk/ may import nothing from this repository.
  //
  // @ship/sdk is the one package a stranger actually installs, and it was the
  // only one with no fence at all. A workspace import here would compile fine in
  // the monorepo and fail on `npm install @ship/sdk` — the worst possible place
  // to discover a boundary violation. Node builtins and real npm dependencies
  // are unaffected; only the workspace is out of bounds.
  {
    files: ['sdk/**/*.ts', 'eslint-fixtures/sdk/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@ship/*',
                '**/api/src/**',
                '**/api/dist/**',
                '**/agent/src/**',
                '**/shared/src/**',
                '**/web/src/**',
              ],
              message:
                'BOUNDARY (sdk → workspace): @ship/sdk is published standalone and may not import anything from this repository. A workspace import compiles here and breaks on `npm install @ship/sdk`. Copy the type or widen the SDK, do not reach back into the monorepo.',
            },
          ],
        },
      ],
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
