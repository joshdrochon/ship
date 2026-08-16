/**
 * THE public route manifest — the one list of `/api/v1` route modules.
 *
 * ## Why this file exists
 *
 * An operation exists in the OpenAPI registry because its module was loaded:
 * `declareV1Route` registers at module load, so "the spec" is a function of
 * which route modules got imported. That made the import list load-bearing, and
 * it was copied into three places that each independently decided what the
 * public surface is:
 *
 *   `scripts/generate-public-openapi.ts`   writes `docs/openapi.json`
 *   `openapi/staticCopy.test.ts`           asserts the committed copy is current
 *   `openapi/sdkSurfaceParity.test.ts`     asserts the SDK covers every operation
 *
 * Three copies of one list is two copies too many, and the failure is silent in
 * the worst possible direction: a list that is SHORT does not fail, it shrinks
 * the thing being measured. `sdkSurfaceParity` compares the spec against the SDK
 * binding table; omit a route module and the spec side loses the operation, the
 * binding table is already missing it, and the two agree at a smaller number.
 * The test reports 100% parity over a surface with a hole in it.
 *
 * That is not hypothetical. It is how `GET /api/v1/audit` shipped with no SDK
 * binding and a green parity suite, and it is the second time — L10's `/me` was
 * generated correctly and then DELETED from the committed artifact by
 * `staticCopy.test.ts`'s idempotence case, which calls `writePublicSpec()` for
 * real against whatever its own imports happened to register.
 *
 * ## What makes this one different
 *
 * `allRoutes.test.ts` reads the filesystem. Every `api/v1/<resource>/routes.ts`
 * on disk must appear in `V1_ROUTE_MODULES` below, and every name in that array
 * must have a real `import` line in this file. A new resource that nobody wires
 * up turns the suite red instead of quietly narrowing the contract.
 *
 * ## Using it
 *
 * Import this module for its side effects wherever "the whole public surface"
 * is the thing under test or being generated:
 *
 * ```ts
 * import './allRoutes.js';
 * ```
 *
 * `GET /api/v1/openapi.json` is deliberately NOT here — it is served by
 * `platform/openapi/route.js`, not by a resource module, and consumers that
 * need it import it themselves. Keeping this manifest to `api/v1/<resource>/`
 * is what lets the fitness test verify it against a directory listing.
 */

// ── The manifest. Adding a resource is a line here and a name below. ─────────
//
// ⚠ ORDER IS OBSERVABLE, so this list is NOT alphabetical. Operations register
// as their modules load, and the registry emits `paths` in registration order,
// so reordering these lines reorders the keys in `docs/openapi.json`. The
// content is unchanged and every test still passes — but the committed artifact
// no longer matches byte-for-byte, and PF-369's `git diff --exit-code
// docs/openapi.json` job fails on a diff that means nothing.
//
// This is the order the spec was generated in before the list moved here.
// Appending is free; resorting costs a 750-line diff in a graded artifact.
import './documents/routes.js';
import './issues/routes.js';
import './sprints/routes.js';
import './me/routes.js';
import './webhooks/routes.js';
// F113 — PRD p.4's audit trail. The line whose absence from two hand-written
// copies of this list is the whole reason the manifest exists.
import './audit/routes.js';

/**
 * The resource directories above, as data, so `allRoutes.test.ts` can compare
 * them against what is actually on disk.
 *
 * This array is not what loads the modules — the `import` lines are. It is the
 * claim; the test checks the claim against both the filesystem and the imports,
 * because an array that listed a resource with no matching import would assert
 * coverage this module does not provide.
 */
export const V1_ROUTE_MODULES = [
  'documents',
  'issues',
  'sprints',
  'me',
  'webhooks',
  'audit',
] as const;

export type V1RouteModule = (typeof V1_ROUTE_MODULES)[number];
