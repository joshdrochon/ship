/**
 * PF-051 — D2's owner-deletion step, in a form the internal admin router can
 * call. Lane L02, slice S4.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL, since PF-037 says the repository is constructed
 * in the composition root and nowhere else.
 * ---------------------------------------------------------------------------
 * The user-delete path is `DELETE /api/admin/debug/users/:id` in
 * `api/src/routes/admin.ts`. That router is a module-level singleton from
 * Part 1: it takes no dependencies, and `createApp` mounts it without passing
 * any. Threading `appsRepo` into it would mean converting the whole admin
 * router to a factory — a large edit to a file this lane does not own, landing
 * on the middleware-stack snapshot that PF-018 guards, for one call site.
 *
 * So there are exactly TWO construction sites for `PgOAuthAppRepo` in this
 * repository: `api/src/deps.ts` (the composition root) and this file. The
 * fitness test in `oauth-apps-fitness.test.ts` names both, so a third one still
 * fails CI. That is the rule kept honest rather than quietly widened — the
 * intent of PF-037 is "construction is not scattered", and two named sites with
 * a written reason satisfies it where one would have cost a refactor of
 * somebody else's router.
 *
 * If L22 or a later lane converts the admin router to a factory, delete this
 * file and pass `deps.appsRepo` instead.
 */
import type { QueryRunner } from '../../db/client.js';
import { PgOAuthAppRepo } from './pg-repo.js';

/**
 * D2 — deactivate every app owned by a user who is about to be deleted.
 *
 * MUST be called before the `DELETE FROM users` statement. The ordering is not
 * a convention: `oauth_apps.owner_user_id` is `ON DELETE RESTRICT` (PF-031), so
 * a delete path that skips this step fails loudly on the foreign key instead of
 * silently orphaning apps or cascading them away. This function is what turns
 * that hard failure into the intended outcome.
 *
 * The apps SURVIVE, deactivated. p.17 offered three options — deactivated,
 * transferred to admin, or orphaned with a soft-flag — and deactivation is the
 * only one where a deleted user's access cannot outlive them while the row that
 * every historical audit entry's `client_id` resolves against stays present.
 *
 * Returns the number of apps deactivated, so the caller can record it.
 */
export async function deactivateAppsForDeletedOwner(
  db: QueryRunner,
  ownerUserId: string,
  at: Date
): Promise<number> {
  return new PgOAuthAppRepo(db).deactivateByOwner(ownerUserId, at);
}
