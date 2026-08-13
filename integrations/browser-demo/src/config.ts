/**
 * Everything the demo needs to know about the Ship instance it talks to.
 *
 * ── There is no `client_secret` here, and there cannot be ───────────────────
 * PF-734 greps the BUILT ASSETS for `client_secret` and fails on a hit. That
 * assertion is not about tidiness: a `client_secret` in a single-page app is
 * published, not stored — `view-source` is all it takes — and an app that
 * publishes its secret is not a confidential client no matter what its
 * registration says. This demo authenticates as a PUBLIC client (RFC 6749
 * §2.1): `client_id` identifies it, and PKCE proves the exchange belongs to the
 * browser session that started it.
 *
 * Ship's `/oauth/token` learned to accept that in migration 074 — see L99 F27
 * and F50, which had it recorded as an open defect blocking this demo, the CLI,
 * and Testing Scenario 2.
 *
 * ── Why `import.meta.env` and not a fetched config ──────────────────────────
 * Vite inlines `VITE_*` at build time, so the built bundle is self-contained
 * static files with no runtime configuration fetch. PF-733 requires exactly
 * that: "no server process of its own beyond a static file server". A config
 * endpoint would be a server, and a `/config.json` fetched from Ship would make
 * the demo's first request an unauthenticated one to an API that does not serve
 * it.
 */

interface DemoEnv {
  VITE_SHIP_BASE_URL?: string;
  VITE_SHIP_CLIENT_ID?: string;
  VITE_REDIRECT_URI?: string;
  VITE_SHIP_SCOPES?: string;
}

const env = import.meta.env as unknown as DemoEnv;

function required(name: keyof DemoEnv, value: string | undefined): string {
  if (!value || value.trim() === '') {
    // Loud at module load, naming the variable — the same rule PF-739 states
    // for the Slack listener and for the same reason: a demo that boots and
    // then fails at the first click is the worst failure available during a
    // graded walkthrough.
    throw new Error(
      `[@ship/browser-demo] ${name} is required at build time and was empty. ` +
        `Set it in the environment before \`vite build\`.`,
    );
  }
  return value.trim();
}

export interface DemoConfig {
  /** Origin of the Ship instance, e.g. `http://localhost:3000`. */
  baseUrl: string;
  /** The PUBLIC client registration. Not a secret; it is in the bundle by design. */
  clientId: string;
  /** Must match a registered redirect URI BYTE FOR BYTE — `authorize.ts` compares with `===`. */
  redirectUri: string;
  /** Space-delimited, per RFC 6749 §3.3. */
  scope: string;
}

export function loadConfig(): DemoConfig {
  return {
    baseUrl: required('VITE_SHIP_BASE_URL', env.VITE_SHIP_BASE_URL).replace(/\/+$/, ''),
    clientId: required('VITE_SHIP_CLIENT_ID', env.VITE_SHIP_CLIENT_ID),
    redirectUri: required('VITE_REDIRECT_URI', env.VITE_REDIRECT_URI),
    // `documents:read` is all this demo does. Asking for more would make the
    // consent screen a worse demonstration of scoped consent, not a better one.
    scope: env.VITE_SHIP_SCOPES?.trim() || 'documents:read',
  };
}
