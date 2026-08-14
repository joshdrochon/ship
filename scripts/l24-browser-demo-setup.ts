/**
 * Playwright `globalSetup` for the Browser SDK Demo (L24, PF-733 – PF-738).
 *
 * ── Why this file lives in `scripts/` and not next to the test ──────────────
 * PF-722: *"Grep across `integrations/**` returns zero matches for `pg`,
 * `DATABASE_URL`, `SESSION_SECRET`, and `api/src`."* Registering an OAuth app is
 * an OPERATOR action, not something the integration does — a third-party
 * developer registers their app in the developer portal, they do not INSERT a
 * row. Putting this inside `integrations/browser-demo/` would make the demo hold
 * a database credential and quietly break the property that makes "the demo is
 * a platform citizen" checkable rather than asserted.
 *
 * So the split is: this file provisions the world (a registered public app), and
 * everything under `integrations/browser-demo/` talks to that world through
 * `@ship/sdk` and HTTP only.
 *
 * ── Why the client_id is a CONSTANT ────────────────────────────────────────
 * Vite inlines `VITE_*` at build time, so the demo's bundle must know the
 * `client_id` before this script has necessarily run. A generated id would force
 * an ordering dependency between `globalSetup` and the `webServer` that builds
 * the bundle — which Playwright does not let you express, and which would show
 * up as an intermittent failure rather than an error.
 *
 * A fixed id is safe because a `client_id` is not a secret: `authorize.ts` says
 * so directly ("client_ids are not secret"), and it is compiled into every
 * public client on the planet by design. The SECRET is what this app does not
 * have.
 */
import { Client } from 'pg';

/** The demo's registration. Public, read-only, one redirect URI. */
export const DEMO_CLIENT_ID = 'ship_demo_browser_pkce';
export const DEMO_REDIRECT_URI = 'http://localhost:4173/';
export const DEMO_SCOPES = ['documents:read'];
/** Seeded by `pnpm db:seed`; the consent screen signs in as this human. */
export const DEMO_USER_EMAIL = 'dev@ship.local';
export const DEMO_USER_PASSWORD = 'admin123';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is required to provision the browser-demo OAuth app. ' +
        'Set it in the environment (the L24 lane database is ship_l24).',
    );
  }
  return url;
}

export default async function globalSetup(): Promise<void> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    const owner = await client.query<{ id: string; last_workspace_id: string | null }>(
      'SELECT id, last_workspace_id FROM users WHERE LOWER(email) = LOWER($1)',
      [DEMO_USER_EMAIL],
    );
    const user = owner.rows[0];
    if (!user) {
      // Named, actionable, and loud. A missing seed surfacing as "the consent
      // screen 302'd to /login" would send the reader hunting through OAuth
      // code for a problem that is one command away from fixed.
      throw new Error(
        `No seeded user ${DEMO_USER_EMAIL} in this database. Run: pnpm db:seed`,
      );
    }

    const workspaceId =
      user.last_workspace_id ??
      (await client.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_members WHERE user_id = $1 LIMIT 1',
        [user.id],
      )).rows[0]?.workspace_id;

    if (!workspaceId) {
      throw new Error(`Seeded user ${DEMO_USER_EMAIL} belongs to no workspace. Run: pnpm db:seed`);
    }

    // The app must be in the SAME workspace as the signed-in user, or
    // `mountAuthorizeRoutes`'s `sameWorkspace` check answers 403 — that check is
    // L04's F43 fix (cross-workspace token minting) and it is doing its job.
    //
    // `client_secret_hash` is a real, unusable value rather than an empty string:
    // the column is NOT NULL, and a public client's secret is unusable BY POLICY
    // (`is_public` gates the auth path), not absent. Keeping the column total is
    // what lets `verifyClientSecret` stay a total function for every caller.
    await client.query(
      `INSERT INTO oauth_apps
         (client_id, client_secret_hash, secret_prefix, name, owner_user_id,
          workspace_id, redirect_uris, requested_scopes, is_public, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)
       ON CONFLICT (client_id) DO UPDATE SET
         redirect_uris   = EXCLUDED.redirect_uris,
         requested_scopes = EXCLUDED.requested_scopes,
         workspace_id    = EXCLUDED.workspace_id,
         owner_user_id   = EXCLUDED.owner_user_id,
         is_public       = true,
         active          = true,
         deactivated_at  = NULL,
         deactivation_reason = NULL`,
      [
        DEMO_CLIENT_ID,
        // sha256 of a value nothing knows and nothing can present. Not a
        // placeholder string like 'none': a hash-shaped column should hold a
        // hash-shaped value so a human reading the table is not misled.
        'f'.repeat(64),
        'demoxxxx',
        'Browser SDK Demo (public client, PKCE)',
        user.id,
        workspaceId,
        [DEMO_REDIRECT_URI],
        DEMO_SCOPES,
      ],
    );
  } finally {
    await client.end();
  }
}
