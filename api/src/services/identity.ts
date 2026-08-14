/**
 * `identityService` — resolves "who is this token" into a user row (PF-272/PF-273).
 *
 * ## Why there is a service here at all, for one SELECT
 *
 * The same rule L09's `documentService` obeys: **nothing in this file knows what
 * HTTP is.** No `express`, no `req`, no `res.locals`, no `requireAuth(req)`.
 * The caller passes plain values.
 *
 * That matters more for `me` than for any other route, and PF-273 is the reason.
 * `me`'s whole purpose is to answer *"who is this TOKEN"*. An implementation
 * that reads `req.userId` answers *"who is this BROWSER"* — and it would pass a
 * naive test, because in a test that sets up both a session and a token, the two
 * are usually the same person. Taking `userId` as an argument makes the wrong
 * implementation unwriteable rather than merely discouraged: there is no request
 * in scope to read.
 *
 * ## Why it does not reuse `/api/auth/me`'s query
 *
 * `api/src/routes/auth.ts:296` resolves the user from the SESSION and then joins
 * a workspace list and a pending-accountability list onto it. The public body
 * needs none of that (see `me.schema.ts`), and the extra work is two queries on
 * the endpoint an SDK calls first on every boot. This is a narrower question
 * with a narrower query.
 *
 * ## Membership is deliberately NOT re-checked here
 *
 * The workspace comes from the token, which got it from `oauth_apps.workspace_id`
 * at authentication time (PF-260). Adding `JOIN workspace_memberships` would ask
 * a different question — "is this user still a member" — whose correct home is
 * token resolution (L06), not the one route that reports the answer. Asking it
 * here would mean `me` 404s while every other route with the same token happily
 * returns data, which is a worse failure than either consistent answer.
 */
import type { Database } from '../db/client.js';

/**
 * Everything the domain needs to know about who is asking. Plain values only —
 * the same shape `documentService` takes, so the two services stay callable from
 * the same context object.
 */
export interface IdentityContext {
  workspaceId: string;
  userId: string | null;
  db: Database;
}

/** The user columns this service reads. An allowlist in the SQL, not just in the projection. */
export interface IdentityUserRow {
  id: string;
  email: string;
  name: string;
}

export interface IdentityService {
  /**
   * The user a token was issued for, or `null` when the token has no user.
   *
   * Two different nulls, and the caller has to tell them apart:
   *
   *   `ctx.userId === null`   a machine-to-machine token. No query is issued and
   *                           `null` is the correct body (`user: null`).
   *   row not found           a token issued for a user who has since been
   *                           deleted. Returns `undefined`, which the route
   *                           turns into a `not_found` rather than silently
   *                           reporting the token as machine-to-machine.
   */
  user(ctx: IdentityContext): Promise<IdentityUserRow | null | undefined>;
}

/**
 * `SELECT id, email, name` and nothing else.
 *
 * NOT `SELECT *`. `users` also carries `password_hash`, `is_super_admin`,
 * `x509_subject_dn` and `last_auth_provider` (`schema.sql:16-28`) — a
 * credential, a privilege flag and two authentication details. The public
 * projection would drop them, but a row that never leaves the database with them
 * attached cannot be leaked by a future projection bug, a log line, or an error
 * handler that serialises the row it was holding. The column list is the first
 * allowlist and the schema is the second.
 */
const USER_COLUMNS = 'id, email, name';

export function createIdentityService(): IdentityService {
  async function user(ctx: IdentityContext): Promise<IdentityUserRow | null | undefined> {
    if (ctx.userId === null) return null;

    const result = await ctx.db.query<IdentityUserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [ctx.userId],
    );
    return result.rows[0];
  }

  return { user };
}
