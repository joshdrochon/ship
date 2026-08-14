/**
 * The `/oauth/*` error surface — RFC 6749 §5.2, and deliberately NOT L07's
 * `ApiError` envelope. PF-172 (lane L06, slice S4).
 *
 * L99's U3 and L04's PF-106 settle the surface: `/oauth/*` emits
 * `{error, error_description?}` and the public API emits `{code, message,
 * details?, request_id}`. Two specs, two surfaces, and collapsing them would
 * break every OAuth client library that has ever been written — an OAuth client
 * looks for `error`, not for `code`.
 *
 * THIS IS THE ONE SCHEMA. L04's authorization-code grant and L05's device grant
 * validate against it rather than writing a second one, for the same reason L07
 * keeps a single `apiErrorBodySchema`: two definitions of a wire shape is a
 * shape that drifts.
 *
 * `rotation.test.ts` asserts this lane imports nothing from L07's error module
 * on the `/oauth` side.
 */
import { z } from 'zod';

/**
 * RFC 6749 §5.2's registered codes, plus RFC 8628 §3.5's device-flow additions.
 *
 * Closed, for the same reason L07's `ApiErrorCode` is closed: an open string is
 * a second error taxonomy that nothing documents and nothing validates.
 * `authorization_pending` and `slow_down` are here so L05 does not have to widen
 * the union later — they are in RFC 8628 and belong to this surface.
 */
export const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  // RFC 8628 §3.5 — the device grant's polling responses.
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

/**
 * `.strict()`, so a handler cannot quietly bolt an extra key onto the body.
 *
 * `error_description` is optional per the RFC. This lane always sets it, because
 * it is the only field carrying the distinction between the three refresh
 * failures (PF-172) — but a grant that has nothing useful to add must be allowed
 * to omit it rather than invent prose.
 */
export const oauthErrorBodySchema = z
  .object({
    error: z.enum(OAUTH_ERROR_CODES),
    error_description: z.string().min(1).optional(),
    /** RFC 6749 §5.2 also permits a URI. Nothing in this build sets one. */
    error_uri: z.string().url().optional(),
  })
  .strict();

export type OAuthErrorBody = z.infer<typeof oauthErrorBodySchema>;

/**
 * RFC 6749 §5.1's success body — the shape both grant redemptions return.
 *
 * Here rather than in `issue.ts` so the two wire shapes of this surface sit
 * together and a test can validate a response against one import.
 */
export const oauthTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1),
    scope: z.string(),
  })
  .strict();
