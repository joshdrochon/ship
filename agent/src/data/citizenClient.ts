/**
 * The agent's OAuth identity — PF-689, PF-690, D5a.
 *
 * ── What this file is, in one sentence ──────────────────────────────────────
 * It turns two environment variables into an authenticated `@ship/sdk` client,
 * and it is the ONLY place in the agent that knows the agent has a credential.
 *
 * ── It seeds nothing, and that is the ticket ────────────────────────────────
 * PRD p.17 asks *"How is the agent's app seeded — at boot, via a migration,
 * manually in dev? What guarantees it exists in deployed environments?"* L02
 * answered it: `seedPlatformApps()` runs on every `db:migrate`, idempotently,
 * with the secret coming from `AGENT_CLIENT_SECRET` and never from a generator.
 *
 * So this module CONSUMES that row and adds nothing. There is no `INSERT INTO
 * oauth_apps` under `agent/`, no `generateClientId`, no fallback that registers
 * an app when it cannot find one — `agentAppCitizen.test.ts` greps for all
 * three. A second seeding path is how a deployed environment ends up with two
 * agent apps and an audit trail split across both, which would quietly defeat
 * the one claim Epic 7 is graded on.
 *
 * ── Client Credentials, and no refresh ──────────────────────────────────────
 * D5a: RFC 6749 §4.4. The agent runs on a schedule with no human at a browser,
 * so the device grant and the authorization-code grant are both wrong for it —
 * each needs someone to visit a URL and click a button.
 *
 * §4.4.3 issues no refresh token, so there is nothing to rotate and nothing to
 * persist between runs. A cron container starts, authenticates, scans, and
 * exits; the credential dies with the process. That is not a limitation being
 * worked around, it is the reason this grant suits a cron job: the only
 * long-lived secret is the one the deployment already has to hold.
 *
 * ── The client id default is the seeded constant ────────────────────────────
 * `AGENT_CLIENT_ID` is overridable but defaults to the fixed value L02 seeds,
 * because PF-691 needs a `client_id` a demo query can hard-code. It is not a
 * secret — it is printed in the README — and the app is CONFIDENTIAL precisely
 * so that publishing it grants nobody anything.
 */
import { ShipClient, type ShipClientOptions } from '@ship/sdk';

/**
 * The fixed `client_id` of the seeded agent app.
 *
 * Duplicated from `api/src/db/platformApps.ts` BY VALUE rather than imported:
 * PF-692 fences `agent/**` off from `api/src/**`, and importing a constant
 * across that fence to save one string would be the first crack in it.
 * `agentAppCitizen.test.ts` asserts the two agree, which is the check an import
 * would have provided.
 */
export const DEFAULT_AGENT_CLIENT_ID = 'ship_app_firstparty_fleetgraph_agent';

/**
 * The three scopes, as data — D5b, and the same list the seeded row requests.
 *
 * Sent explicitly rather than relying on the server's "omitted grants the
 * registered set" default, so a token this agent holds is a statement of what it
 * intends to read rather than of whatever the registration happens to say. If an
 * operator ever widens the app's `requested_scopes`, this agent still asks for
 * three and the audit trail still shows three.
 */
export const AGENT_SCOPES = ['documents:read', 'issues:read', 'sprints:read'] as const;

export interface AgentCredentials {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
}

/**
 * Reads the credential out of the environment, or explains what is missing.
 *
 * Returns `null` rather than throwing when the secret is absent, because a
 * missing credential must degrade the agent's ACCESS PATH and not kill the
 * process — the same call `cron.ts` already makes for `SHIP_API_TOKEN`. The
 * caller decides what to do with a null, and under the flag it refuses to run
 * the SDK path rather than silently falling back to SQL.
 */
export function resolveAgentCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AgentCredentials | null {
  const clientSecret = env.AGENT_CLIENT_SECRET;
  if (!clientSecret) return null;
  return {
    clientId: env.AGENT_CLIENT_ID ?? DEFAULT_AGENT_CLIENT_ID,
    clientSecret,
    ...(env.SHIP_BASE_URL ? { baseUrl: env.SHIP_BASE_URL } : {}),
  };
}

/**
 * Authenticates and hands back a ready client.
 *
 * One `POST /oauth/token` per scan. Not cached across runs on purpose: a cron
 * container has no across-runs, and caching inside a run is what the returned
 * client already does.
 */
export async function authenticateAsAgent(
  credentials: AgentCredentials,
  options: Pick<ShipClientOptions, 'http' | 'clock'> = {},
): Promise<ShipClient> {
  return ShipClient.clientCredentials({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    scopes: [...AGENT_SCOPES],
    ...(credentials.baseUrl !== undefined ? { baseUrl: credentials.baseUrl } : {}),
    ...(options.http !== undefined ? { http: options.http } : {}),
  });
}
