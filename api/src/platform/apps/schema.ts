/**
 * Zod schemas for the app registry. PF-038 (public projection) and PF-042
 * (redirect URI rules). Lane L02, slices S1–S2.
 *
 * ---------------------------------------------------------------------------
 * PF-038 — the projection is an ALLOWLIST, never an exclusion list.
 * ---------------------------------------------------------------------------
 * `oauthAppPublicSchema` names the fields that may be published. It does not
 * name fields to strip. The difference is what happens when migration 043 adds
 * a column: with an allowlist the new column is absent by default and someone
 * has to decide to publish it; with an exclusion list it ships to every
 * consumer the moment it exists, and nobody finds out.
 *
 * That is not hypothetical here. L99's F17 records the same mistake already
 * made in this repo: `api/src/routes/documents.ts` returns `RETURNING *`, which
 * would have put `yjs_state`, `deleted_at` and `position` in front of external
 * consumers. This file is the shape of not repeating it.
 *
 * `.strict()` is the second half. Without it an extra key passed to `parse()`
 * is silently dropped rather than rejected, so a serializer bug that added
 * `client_secret_hash` to the object would produce a clean response and a
 * passing test. With `.strict()` it throws.
 *
 * ONE DEFINITION. The serializer and the tests import this same object — there
 * is no second copy of the field list to drift. PF-038's fitness test greps for
 * exactly one definition.
 */
import { z } from 'zod';
import { scopeRegistry, type Scope } from '../scopes/registry.js';
import type { OAuthApp } from './types.js';

/**
 * The complete set of app fields any client may see.
 *
 * Note what is NOT here, and why each is absent:
 *   client_secret_hash   the stored hash — publishing it hands over the thing
 *                        an offline attack runs against
 *   client_secret        the raw secret; it is not a persisted field at all,
 *                        and it is ADDED to this projection by exactly two
 *                        responses (create, rotate) rather than living in it
 *   owner_user_id        an ownership oracle; PF-043 refuses to disclose it
 *   workspace_id         tenancy detail with no consumer on this surface
 *   deactivated_at,      D2 bookkeeping; `active` is the fact a client acts on
 *   deactivation_reason
 */
export const oauthAppPublicSchema = z
  .object({
    id: z.string(),
    /** In full, deliberately. PF-032: it is not a secret and must be copyable. */
    client_id: z.string(),
    name: z.string(),
    redirect_uris: z.array(z.string()),
    requested_scopes: z.array(z.string()),
    /** PF-035 — names a secret without being one. */
    secret_prefix: z.string(),
    secret_version: z.number().int(),
    active: z.boolean(),
    created_at: z.string(),
  })
  .strict();

export type OAuthAppPublic = z.infer<typeof oauthAppPublicSchema>;

/**
 * The one serializer. Every read response goes through this and nothing builds
 * an app response object by hand.
 *
 * It parses its own output rather than trusting the mapping below: if a field
 * is added here without being added to the schema, `.strict()` throws at the
 * first request instead of publishing it.
 */
export function toPublicApp(app: OAuthApp): OAuthAppPublic {
  return oauthAppPublicSchema.parse({
    id: app.id,
    client_id: app.clientId,
    name: app.name,
    redirect_uris: app.redirectUris,
    requested_scopes: app.requestedScopes,
    secret_prefix: app.secretPrefix,
    secret_version: app.secretVersion,
    active: app.active,
    created_at: app.createdAt.toISOString(),
  });
}

/**
 * PF-042 — the single named constant that permits loopback redirect URIs.
 *
 * `https` is required for every other host. Loopback is exempt because the
 * browser SDK demo (p.8) and the Playwright PKCE flow both redirect to a local
 * server, and no certificate authority issues for 127.0.0.1. Naming it as one
 * greppable constant is the same discipline L15's PF-425 uses for `target_url`:
 * the exception is auditable in one place rather than spread across three
 * `||` clauses in a refinement.
 */
export const LOOPBACK_REDIRECT_HOSTS = ['localhost', '127.0.0.1', '[::1]'] as const;

/** Reasons a redirect URI is rejected. Each maps to a message naming the field. */
export type RedirectUriProblem =
  | 'not_absolute'
  | 'insecure_scheme'
  | 'has_fragment'
  | 'has_credentials';

/**
 * Validates one redirect URI. Returns the problem, or null if acceptable.
 *
 * Every rule here exists because of what L04 does with the value at authorize
 * time — an exact string comparison against the registered set:
 *
 *   absolute       a relative URI has no origin to compare, so it cannot be
 *                  matched safely at all
 *   https-only     a redirect carries the authorization code; over http it is
 *                  readable by anyone on the path (loopback excepted above,
 *                  where there is no path)
 *   no fragment    RFC 6749 §3.1.2 forbids it, and the fragment is where the
 *                  implicit flow put tokens — a registered fragment is a sign
 *                  the developer expects a flow we do not implement
 *   no credentials `https://user:pass@host` is a phishing shape and browsers
 *                  have been dropping support for it for years
 */
export function redirectUriProblem(value: string): RedirectUriProblem | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not_absolute';
  }
  if (url.username !== '' || url.password !== '') return 'has_credentials';
  if (url.hash !== '') return 'has_fragment';
  if (url.protocol === 'https:') return null;
  if (
    url.protocol === 'http:' &&
    (LOOPBACK_REDIRECT_HOSTS as readonly string[]).includes(url.hostname)
  ) {
    return null;
  }
  return 'insecure_scheme';
}

const REDIRECT_PROBLEM_MESSAGE: Record<RedirectUriProblem, string> = {
  not_absolute: 'must be an absolute URI',
  insecure_scheme: 'must use https (http is permitted only for loopback addresses)',
  has_fragment: 'must not contain a fragment',
  has_credentials: 'must not contain credentials in the authority',
};

/**
 * The registration request body (PF-040).
 *
 * `requested_scopes` is validated against the ScopeRegistry rather than against
 * a literal list — PF-041 forbids any scope-name literal under `platform/apps/`,
 * so the enum is derived from `SCOPES` at module load. Adding a scope to the
 * registry admits it here with no edit to this file, which is L03's OCP claim
 * surviving contact with registration.
 */
export const createAppRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),

    redirect_uris: z
      .array(z.string())
      // PF-042: an empty array is rejected. An app with no redirect URI cannot
      // complete an authorization code flow, so registering one is a mistake
      // that should surface now rather than at the first login attempt.
      .min(1, 'at least one redirect URI is required')
      .superRefine((uris, ctx) => {
        uris.forEach((uri, i) => {
          const problem = redirectUriProblem(uri);
          if (problem) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: `redirect_uris[${i}] ${REDIRECT_PROBLEM_MESSAGE[problem]}`,
            });
          }
        });
      }),

    requested_scopes: z
      .array(z.string())
      // PF-041 DECISION: an empty requested_scopes is rejected, with the reason
      // in the message. L03's PF-074 intersects app-requested scopes with
      // user-consented ones at issuance, so an app that requested nothing can
      // only ever hold a token that can do nothing. Failing at registration is
      // strictly better than failing at the first API call, where the developer
      // has no signal pointing back at the registration.
      .min(1, 'at least one scope is required; an app with no scopes can never do anything')
      // PF-041: validated against the ScopeRegistry, at REGISTRATION rather
      // than at issuance. `scopeRegistry.has()` is the only source — there is
      // no literal scope name in this file, so adding a scope to the registry
      // admits it here with no edit. That is L03's OCP claim (PF-066) holding
      // at the registration boundary.
      //
      // The unknown name is echoed in the message because an SDK author
      // debugging a typo needs to know WHICH scope was rejected; a bare
      // "invalid scope" sends them to read the list themselves.
      .superRefine((scopes, ctx) => {
        scopes.forEach((scope, i) => {
          if (!scopeRegistry.has(scope)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: `unknown scope "${scope}"`,
            });
          }
        });
      })
      .transform((scopes) => scopes as Scope[]),
  })
  .strict();

export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;

/**
 * PF-053 — the reactivate request.
 *
 * `owner_user_id` is required rather than optional-defaulting-to-the-admin:
 * reactivating an app silently onto the acting admin would make the admin the
 * owner of a credential they did not ask for, and p.17's recovery story is
 * "reactivates AND reassigns" — two deliberate acts, not one implied one.
 */
export const reactivateRequestSchema = z
  .object({
    owner_user_id: z.string().uuid(),
  })
  .strict();
