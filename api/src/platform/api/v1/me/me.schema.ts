/**
 * Request and response Zod for `GET /api/v1/me`, adjacent to the handler.
 *
 * Tickets: PF-272 (a public schema, not `/api/auth/me`'s body), PF-274 (the
 * acting app and the granted scopes).
 *
 * PRD p.11: *"Every public route's request/response schema lives in Zod adjacent
 * to the handler; the generator walks them."* Same adjacency rule L09 set for
 * `documents.schema.ts` — a sibling of `routes.ts`, deliberately NOT
 * `api/src/openapi/schemas/`.
 *
 * ## Why `/api/auth/me` could not be reused (PF-272, verified)
 *
 * `api/src/routes/auth.ts:296` returns
 *
 *     { success: true,
 *       data: { user: {id, email, name, isSuperAdmin},
 *               currentWorkspace, workspaces[], pendingAccountabilityItems[] } }
 *
 * Four things are wrong with that as a public body, and none of them is
 * cosmetic:
 *
 *   `success` wrapper   The public envelope is the HTTP status plus `ApiError`
 *                       on failure (p.7). A second success flag inside a 200 is
 *                       a second error protocol, and a consumer that starts
 *                       branching on it will eventually find a 200 with
 *                       `success: false` and no idea which to trust.
 *   `isSuperAdmin`      An internal privilege flag. A third-party app has no
 *                       business knowing that a user can administer Ship, and
 *                       once it is in the contract it cannot be removed.
 *   `workspaces[]`      A token is scoped to exactly one workspace (PF-260), so
 *                       a list is either wrong or a cross-tenant disclosure —
 *                       it names workspaces the token cannot read.
 *   session-resolved    It answers "who is this browser", not "who is this
 *                       token". See the PF-273 note in `routes.ts`.
 *
 * ## Why the user is NESTED rather than flattened onto the body
 *
 * PF-272 describes the user representation as *"a flat `{id, email, name,
 * workspace_id}`"*, in contrast to the internal endpoint's nesting under
 * `data.user` beside a workspace list. It does not settle whether the body IS
 * that object or CARRIES it, and PF-274 then adds `app` and `scopes`
 * *"alongside the user"*, which only makes sense if there is a user field to be
 * alongside.
 *
 * The tie is broken by the consumer of record: L17 shipped `Me` in
 * `sdk/src/client.ts` as `{app, user: {id, name} | null, scopes}`, and MVP gate
 * item 8 closes through `new ShipClient({token}).me()` returning that type. A
 * flattened body would make `me.user` `undefined` on the one expression the
 * gate names. So the body carries a nullable `user` object, and the flat part
 * of PF-272 is what is INSIDE it — one workspace instead of a list, no wrapper,
 * no privilege flag.
 *
 * ## Why `user` is nullable
 *
 * `PlatformAuthContext.userId` is `string | null` — a machine-to-machine token
 * has no consenting user. `user: null` is the honest answer, and it is what the
 * SDK's type already says. It is NOT an error: the app is still authenticated,
 * still has a workspace, and still has scopes, which is the rest of the body.
 */
import { z } from 'zod';
import { SCOPE_DEFINITIONS, type Scope } from '../../../scopes/scopes.js';

/**
 * The seven registered scope names as a Zod-shaped tuple.
 *
 * DERIVED from `SCOPE_DEFINITIONS`, never restated. PF-062 asserts the registry
 * holds exactly seven and MVP gate item 6 resolves through that assertion, so a
 * hand-written list here would be an eighth place the number could be wrong.
 * The cast is only about shape — `z.enum` wants a non-empty tuple and `.map`
 * produces an array — and it cannot change WHICH names are in it.
 */
const SCOPE_NAMES = SCOPE_DEFINITIONS.map((definition) => definition.scope) as unknown as [
  Scope,
  ...Scope[],
];

/**
 * The user half. `workspace_id` lives here per PF-272's field list.
 *
 * Known consequence, stated rather than discovered: a machine-to-machine token
 * gets `user: null` and therefore learns no workspace id from this endpoint.
 * The alternative — a second top-level `workspace_id` — duplicates one value in
 * two places in a public contract, which is a worse thing to be stuck with than
 * a gap an M2M app can close by reading its own registration. Recorded in the
 * lane report rather than fixed by inventing a field no ticket asks for.
 */
export const meUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    workspace_id: z.string(),
  })
  .strict();

/**
 * PF-274 — the acting app, and NEVER its secret.
 *
 * `client_id` and `name`, and that is the whole object. `client_secret` and
 * `client_secret_hash` are absent by construction (this is an allowlist, not an
 * omission), and `me.fitness.test.ts` asserts both names appear nowhere in the
 * serialized body — the one route whose whole job is to describe the caller is
 * the one most likely to grow a convenience field that should not exist.
 */
export const meAppSchema = z
  .object({
    client_id: z.string(),
    name: z.string(),
  })
  .strict();

/**
 * PF-274 — what the caller is authorized to do, from the TOKEN.
 *
 * p.3's Token Middleware row: *"Bearer validation; populates request with app,
 * user, granted scopes."* All three are on `PlatformAuthContext`, and `me` is
 * the only route that can show a caller what it holds. Without it, `ship login`
 * has to guess what it was authorized for, or re-derive it from the app's
 * *requested* scopes — which is a different set, because a user can consent to
 * a subset.
 *
 * Typed as an enum of the registered names rather than a bare string array, so
 * the generated spec documents the seven and an SDK gets a union instead of
 * `string[]`. Values are read from `scopeRegistry`'s source of truth; there are
 * no scope literals in this file (PF-070's rule, applied outside `scopes/`).
 */
export const meSchema = z
  .object({
    user: meUserSchema.nullable(),
    app: meAppSchema,
    scopes: z.array(z.enum(SCOPE_NAMES)),
  })
  .strict();

export type Me = z.infer<typeof meSchema>;
export type MeUser = z.infer<typeof meUserSchema>;

/** The exact key set of the body, for the fitness test to read as data. */
export const ME_BODY_FIELDS = Object.keys(meSchema.shape) as (keyof Me)[];

/**
 * Fields from `/api/auth/me` that must NEVER appear on this body. Exported as
 * data so PF-272's test enumerates them rather than restating a list that
 * drifts.
 */
export const REJECTED_INTERNAL_ME_FIELDS = [
  'success',
  'data',
  'isSuperAdmin',
  'is_super_admin',
  'workspaces',
  'currentWorkspace',
  'pendingAccountabilityItems',
  'password_hash',
  'client_secret',
  'client_secret_hash',
] as const;
