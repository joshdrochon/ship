/**
 * PF-141 — THE definition of what the device grant sends, exported as a fixture.
 * Lane L05, slice S4.
 *
 * ---------------------------------------------------------------------------
 * ONE DEFINITION OF "WHAT THE SERVER SENDS", NOT TWO THAT DRIFT.
 * ---------------------------------------------------------------------------
 * Three downstream consumers depend on these exact field names and contain no
 * compensating logic:
 *
 *   L18 PF-537  `ShipClient.deviceLogin()`, implementing p.7's static signature
 *   L18 PF-538  the SDK's `slow_down` backoff, which reads `interval`
 *   L19 PF-562  `ship login`, which must contain no `/oauth/` literal and no
 *               `device_code` handling of its own
 *
 * If those lanes restate the shape in their own tests, the two statements drift
 * and the drift is invisible until an integration breaks. So the shape is
 * declared HERE, once, and exported for them to import.
 *
 * The schemas are Zod rather than TypeScript interfaces on purpose: an
 * interface is erased at runtime and can only check the code that was compiled
 * against it, while a schema can be run against an actual HTTP response — which
 * is what an SDK test needs to assert about a server it did not compile with.
 */
import { z } from 'zod';
import { deviceAuthorizationResponseSchema } from './deviceAuthorization.js';
import { oauthErrorBodySchema } from './oauthErrors.js';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
} from './deviceCodes.js';

/** Re-exported so a consumer imports ONE module to get the whole contract. */
export { deviceAuthorizationResponseSchema };

/**
 * Every `error` code the device grant can emit, and nothing else.
 *
 * RFC 8628 §3.5's four, plus the three RFC 6749 §5.2 codes this leg can
 * produce. Exported as data so L19's PF-565 can render a distinct message per
 * code without hard-coding a list that this lane could change underneath it.
 */
export const DEVICE_GRANT_ERROR_CODES = [
  // RFC 8628 §3.5 — the device flow's own.
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_token',
  // RFC 6749 §5.2 — reachable on this leg.
  'invalid_request',
  'invalid_grant',
  'invalid_client',
] as const;

export type DeviceGrantErrorCode = (typeof DEVICE_GRANT_ERROR_CODES)[number];

/**
 * The error body schema, narrowed to the codes this leg can actually emit.
 *
 * Built by REFINING L04's `oauthErrorBodySchema` rather than by declaring a
 * second object shape — PF-142's requirement. A consumer validating against
 * this is also validating against the one schema the whole `/oauth` surface
 * uses; the narrowing only says which members of that union are reachable here.
 */
export const deviceGrantErrorBodySchema = oauthErrorBodySchema.refine(
  (body): boolean => (DEVICE_GRANT_ERROR_CODES as readonly string[]).includes(body.error),
  { message: 'not an error code the device grant emits' },
);

/**
 * The three numbers a client must agree with the server about.
 *
 * Exported so L18's backoff test asserts against the shipped values rather than
 * against numbers copied into the SDK — the failure that would otherwise stay
 * invisible is an SDK that backs off by 5 while the server raises by 10.
 */
export const DEVICE_FLOW_CONSTANTS = {
  /** Seconds a device authorization stays live. */
  expiresInSeconds: DEVICE_CODE_TTL_SECONDS,
  /** The `interval` advertised at issuance — and enforced from the first poll. */
  initialIntervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
  /** How much the server adds on each `slow_down`. RFC 8628 §3.5 says 5. */
  intervalIncrementSeconds: DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
} as const;

/**
 * A syntactically valid example of each wire shape.
 *
 * For consumers that need a fixture to build a stub server or a type test
 * against, rather than a schema to validate a live response with. Kept next to
 * the schemas so a change to one is visibly a change to the other.
 */
export const DEVICE_FLOW_EXAMPLES = {
  authorizationResponse: {
    device_code: 'ZjQ2YmQ4ZTUtOWMxZS00YjJmLWE3ZDMtNmU4YzFhOWYwYjJk',
    user_code: 'ACDE-FGHJ',
    verification_uri: 'https://ship.example/oauth/device/verify',
    verification_uri_complete:
      'https://ship.example/oauth/device/verify?user_code=ACDE-FGHJ',
    expires_in: DEVICE_CODE_TTL_SECONDS,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  },
  pending: { error: 'authorization_pending' as const },
  slowDown: { error: 'slow_down' as const },
  denied: { error: 'access_denied' as const },
  expired: { error: 'expired_token' as const },
  badGrant: { error: 'invalid_grant' as const },
} as const;

/** The static type of the issuance response, for consumers that want it. */
export type DeviceAuthorizationResponseShape = z.infer<
  typeof deviceAuthorizationResponseSchema
>;
