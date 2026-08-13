/**
 * Base-URL resolution and request-URL construction.
 *
 * Two defects on disk are fixed here, both filed against `client.ts` and both
 * found by reading it (L99 F19 / F20, tickets PF-491 / PF-494).
 *
 * ── PF-491 / F19 ────────────────────────────────────────────────────────────
 * MVP gate item 8 (PRD p.2) is written as:
 *
 *     new ShipClient({ token }).me()
 *
 * `ShipClientOptions.baseUrl` was `string` — REQUIRED — so the gate's own
 * expression was a type error. A gate item that does not compile fails on a
 * screenshot. `baseUrl` is optional now, with a documented resolution order:
 *
 *     explicit option  →  SHIP_BASE_URL in the environment  →  DEFAULT_BASE_URL
 *
 * Explicit first because an argument at the call site is the most local and the
 * most deliberate. The environment second because that is how a CLI, a CI job
 * and a container are configured without editing code. The published instance
 * last so the zero-argument form has a meaning at runtime and not only at
 * compile time.
 *
 * ── PF-494 / F20 ────────────────────────────────────────────────────────────
 * The old join was:
 *
 *     new URL(`/api/v1${path}`, this.options.baseUrl)
 *
 * The second argument of `new URL` is a BASE, and a first argument beginning
 * with `/` is an absolute path, which replaces the base's path entirely. So
 *
 *     new URL('/api/v1/me', 'https://host/ship')  →  https://host/api/v1/me
 *
 * and every call 404s for anyone deployed behind a path prefix — a reverse
 * proxy, a shared hostname, an ingress rule. `buildRequestUrl` keeps the
 * prefix, and `baseUrl.test.ts` table-tests the four shapes a base URL actually
 * arrives in.
 */
import { readEnv } from './internal/env.js';

/** The path segment every public route hangs off. Not configurable — it is the API version. */
export const API_PATH_PREFIX = '/api/v1';

/** The environment variable consulted when no `baseUrl` option is supplied. */
export const BASE_URL_ENV_VAR = 'SHIP_BASE_URL';

/**
 * The published Ship instance, used when neither an option nor the environment
 * names one.
 *
 * This is a DEFAULT, not an assumption: a self-hosted instance passes `baseUrl`
 * or exports `SHIP_BASE_URL`, and both win. It exists so that the gate's
 * `new ShipClient({ token })` has a runtime meaning as well as a type-level one.
 */
export const DEFAULT_BASE_URL = 'https://ship.awsdev.treasury.gov';

/** Where a resolved base URL came from — surfaced for diagnostics and tested. */
export type BaseUrlSource = 'option' | 'env' | 'default';

export interface ResolvedBaseUrl {
  url: string;
  source: BaseUrlSource;
}

/**
 * explicit option → `SHIP_BASE_URL` → `DEFAULT_BASE_URL`.
 *
 * Validates eagerly. A malformed base URL is a configuration mistake, and the
 * useful place to report it is the constructor — where the stack names the
 * caller's own wiring — rather than inside the first request, where it reads as
 * a network failure.
 */
export function resolveBaseUrl(explicit?: string): ResolvedBaseUrl {
  const candidate: ResolvedBaseUrl =
    explicit !== undefined && explicit.trim() !== ''
      ? { url: explicit.trim(), source: 'option' }
      : (() => {
          const fromEnv = readEnv(BASE_URL_ENV_VAR);
          return fromEnv !== undefined
            ? ({ url: fromEnv, source: 'env' } as const)
            : ({ url: DEFAULT_BASE_URL, source: 'default' } as const);
        })();

  try {
    // Constructed and discarded: this is a validation, and the normalised value
    // is produced per-request by `buildRequestUrl` from the raw string.
    new URL(candidate.url);
  } catch {
    throw new TypeError(
      `Invalid Ship base URL ${JSON.stringify(candidate.url)} (from ${
        candidate.source === 'option'
          ? 'the baseUrl option'
          : candidate.source === 'env'
            ? `${BASE_URL_ENV_VAR}`
            : 'the built-in default'
      }). Expected an absolute URL such as https://ship.example.com or ` +
        `https://ship.example.com/prefix.`,
    );
  }

  return candidate;
}

/**
 * Joins a base URL, the `/api/v1` prefix and a route path WITHOUT discarding a
 * path prefix on the base (PF-494).
 *
 * The four base shapes that must all behave, asserted in `baseUrl.test.ts`:
 *
 *     https://host              →  https://host/api/v1/me
 *     https://host/             →  https://host/api/v1/me
 *     https://host/ship         →  https://host/ship/api/v1/me
 *     https://host/ship/        →  https://host/ship/api/v1/me
 *
 * A `search` or `hash` on the base is dropped rather than merged: a base URL is
 * an origin plus an optional mount point, and silently carrying `?debug=1` into
 * every request — where it would collide with the SDK's own query parameters —
 * is worse than ignoring it.
 */
export function buildRequestUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string> = {},
): URL {
  const base = new URL(baseUrl);

  // Trailing slashes stripped so the join never doubles them. `new URL('https://h')`
  // yields pathname '/', which normalises to '' — the bare-origin case.
  const mountPath = base.pathname.replace(/\/+$/, '');

  // A path must be rooted; anything else is a bug at the call site rather than
  // something to repair silently, because '../' in a resource path would escape
  // the API prefix.
  if (!path.startsWith('/')) {
    throw new TypeError(`Ship request path must start with "/" — received ${JSON.stringify(path)}.`);
  }

  const url = new URL(base.origin);
  url.username = base.username;
  url.password = base.password;
  url.pathname = `${mountPath}${API_PATH_PREFIX}${path}`;

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * The OAuth token endpoint for a given base URL.
 *
 * `/oauth` is mounted as a SIBLING of `/api/v1` on the server (`api/src/app.ts`),
 * so it takes the base's mount path but NOT the API prefix. Kept here rather
 * than in the refresh module so there is one place that knows how a Ship URL is
 * assembled.
 */
export function buildOAuthTokenUrl(baseUrl: string): URL {
  const base = new URL(baseUrl);
  const mountPath = base.pathname.replace(/\/+$/, '');
  const url = new URL(base.origin);
  url.pathname = `${mountPath}/oauth/token`;
  return url;
}
