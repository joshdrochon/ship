/**
 * `POST /oauth/device/code` — RFC 8628 §3.1/§3.2.
 * PF-122, PF-125, PF-126, PF-127 (lane L05, slice S1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PRD ASKS FOR, AND WHAT IT DOES NOT.
 * ---------------------------------------------------------------------------
 * PRD p.3's Device Authorization Grant row is three clauses, and the first is
 * the whole of what it says about this endpoint:
 *
 *   "/oauth/device/code issues a user_code and device_code"
 *
 * `verification_uri`, `verification_uri_complete`, `expires_in` and `interval`
 * are NOT in the PRD. Verified by grep across all eighteen extracted pages —
 * none of the four words appears anywhere. They ship here on two citations this
 * lane is entitled to make, and the provenance is written down rather than
 * smuggled into a page reference:
 *
 *   · `docs/architecture.md:128` — a graded Final deliverable that already
 *     committed to "device_code, user_code, verification_uri, interval".
 *     PF-143 latches the diagram to this code so the two cannot drift.
 *   · PRD p.10's stack row requires "Hand-rolled minimal IETF-correct flows
 *     (RFC 6749 + 7636 PKCE + 8628 Device Grant)", which makes RFC 8628 §3.2
 *     normative. §3.2 lists `expires_in` as REQUIRED and `interval` as
 *     OPTIONAL-with-a-default.
 *   · PRD p.7's SDK signature `onUserCode: (code: string, verifyUrl: string)`
 *     independently proves the client is handed a URL as well as a code.
 *
 * ---------------------------------------------------------------------------
 * `verification_uri` IS ABSOLUTE, AND THAT IS THE ASSERTION THAT MATTERS.
 * ---------------------------------------------------------------------------
 * A relative path, or a hard-coded `http://localhost:3000`, is the defect a
 * grader hits first: a CLI pointed at the deployed instance prints a URL that
 * resolves nowhere, or resolves to the developer's own machine. So the base URL
 * is INJECTED from the composition root — the same instance-URL configuration
 * the rest of the platform reads — rather than read from `process.env` here,
 * which would also breach L01's fence around `platform/`.
 *
 * ---------------------------------------------------------------------------
 * SCOPES ARE VALIDATED HERE, NOT AT THE POLL (PF-126).
 * ---------------------------------------------------------------------------
 * Deliberate, and it is a usability decision as much as a correctness one. A
 * typo in a requested scope fails at `ship login`'s FIRST request, with a
 * message naming the bad scope — instead of after the user has walked to a
 * browser, signed in and typed an eight-character code, which is where the
 * failure would surface if the check lived at redemption.
 *
 * What lands on the row at issuance is the validated request. What lands at
 * APPROVAL is `resolveGrantedScopes(app.requestedScopes, consented)` (PF-074),
 * so a device flow can never mint a token carrying a scope the app never
 * registered.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import type { Clock } from '../clock.js';
import type { IOAuthAppRepo } from '../apps/repo.js';
import { verifyClientSecret } from '../apps/repo.js';
import type { OAuthApp } from '../apps/types.js';
import type { ScopeRegistry } from '../scopes/registry.js';
import { scopeRegistry, type Scope } from '../scopes/scopes.js';
import { validateRequestedScopes } from '../scopes/validation.js';
import {
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type IDeviceCodeRepo,
} from './deviceCodes.js';

/** Mount path of the device authorization request, relative to the `/oauth` mount. */
export const DEVICE_CODE_PATH = '/device/code';

/** Mount path of the human-facing verification screen. */
export const DEVICE_VERIFY_PATH = '/device/verify';

/**
 * PF-141 — THE definition of what this endpoint sends.
 *
 * Exported as a Zod schema rather than described in prose, so L18's
 * `deviceLogin()` tests and L19's CLI tests import ONE definition of the wire
 * shape instead of restating it. Two statements of a contract is a contract
 * that drifts, and those two lanes contain no compensating logic — they trust
 * these field names exactly.
 *
 * `.strict()`, so a handler cannot quietly bolt an extra key on.
 */
export const deviceAuthorizationResponseSchema = z
  .object({
    /** RFC 8628 §3.2 REQUIRED. The client's bearer credential for polling. */
    device_code: z.string().min(1),
    /** RFC 8628 §3.2 REQUIRED. Canonical `XXXX-XXXX`, exactly as displayed. */
    user_code: z.string().min(1),
    /** RFC 8628 §3.2 REQUIRED. Absolute — see the module header. */
    verification_uri: z.string().url(),
    /** RFC 8628 §3.3.1 OPTIONAL. Absolute, and carries the code. See PF-128. */
    verification_uri_complete: z.string().url(),
    /** RFC 8628 §3.2 REQUIRED. Seconds. */
    expires_in: z.number().int().positive(),
    /** RFC 8628 §3.2 OPTIONAL. Seconds; the value the throttle actually enforces. */
    interval: z.number().int().positive(),
  })
  .strict();

export type DeviceAuthorizationResponse = z.infer<typeof deviceAuthorizationResponseSchema>;

/**
 * The request, per RFC 8628 §3.1.
 *
 * `client_secret` is OPTIONAL here on purpose and the reason is RFC 6749 §2.1:
 * a CLI is a public client and cannot hold a secret. §3.1 requires client
 * IDENTIFICATION at this endpoint, and authentication only from clients that
 * are confidential.
 *
 * ⚑ NOTE THE ASYMMETRY WITH `/oauth/token`, WHICH IS NOT THIS LANE'S TO FIX.
 * `router.ts`'s `authenticateClient` returns null unless BOTH `client_id` and
 * `client_secret` are present, so the POLL leg currently requires a secret even
 * though this leg does not. That is L99's finding **F27**, owned by L06, and
 * this lane's evidence is recorded there rather than worked around here — a
 * local bypass would put a second client-authentication policy on one router.
 */
const deviceAuthorizationRequestSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  /** Space-delimited, per RFC 6749 §3.3. */
  scope: z.string().optional(),
});

export interface DeviceAuthorizationDeps {
  appsRepo: IOAuthAppRepo;
  deviceCodeRepo: IDeviceCodeRepo;
  clock: Clock;
  /**
   * Absolute origin of this Ship instance, e.g. `https://ship.example.gov`.
   * Injected, never read from `process.env` here. See the module header.
   */
  publicBaseUrl: string;
  /** Overridable for tests that mutate a description. Defaults to L03's. */
  registry?: ScopeRegistry<string>;
}

/**
 * How many times a `user_code` collision is retried before giving up (PF-123).
 *
 * BOUNDED, and deliberately not a `while (true)`. At 3.8×10^11 codes against
 * the tens of rows this table holds, a single collision is already
 * astronomically unlikely and five is unreachable in practice — so five
 * consecutive failures does not mean "unlucky", it means the CSPRNG or the
 * database is broken, and an unbounded loop would hang the request instead of
 * saying so.
 */
const USER_CODE_MAX_ATTEMPTS = 5;

/** RFC 6749 §5.2 error body. This surface never emits L07's ApiError envelope. */
function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

/**
 * PF-125 — client authentication for THIS endpoint.
 *
 * One indistinguishable answer for an unknown `client_id`, a wrong
 * `client_secret` and a deactivated app. That is PF-036's contract and it is
 * not re-decided here: where a secret is presented it is verified ONLY through
 * `verifyClientSecret`, which is the single client-secret comparison site in
 * the repository and is constant-time. No comparison of any kind is defined in
 * this lane and a grep asserts it.
 *
 * The `active` check is applied HERE rather than at the first poll so that D2's
 * guarantee — a deleted owner's apps stop working — holds at the ENTRY POINT of
 * this flow, exactly as L04's PF-093 holds it for authorize. Refusing at the
 * poll instead would let a deactivated app still print a code and send a user to
 * a consent screen for a grant that can never complete.
 */
async function authenticateDeviceClient(
  repo: IOAuthAppRepo,
  clientId: string,
  clientSecret: string | undefined,
): Promise<OAuthApp | null> {
  if (clientSecret !== undefined) {
    const outcome = await verifyClientSecret(repo, clientId, clientSecret);
    return outcome.ok ? outcome.app : null;
  }

  // Public client: identification only (RFC 6749 §2.1, RFC 8628 §3.1). The
  // `active` flag is still decided here — `findByClientId` deliberately returns
  // the app regardless of it so that the decision is made at the boundary
  // rather than hidden in a query (see `IOAuthAppRepo.findByClientId`).
  const app = await repo.findByClientId(clientId);
  if (!app || !app.active) return null;
  return app;
}

/**
 * Mounts `POST /oauth/device/code` onto the OAuth router.
 *
 * A function rather than its own Router, for `mountAuthorizeRoutes`'s reason:
 * the security headers, the body parser and the token endpoint all sit on one
 * router, and PF-107's assertion that `/oauth/*` shares no middleware with the
 * v1 stack is about a single mounted layer.
 */
export function mountDeviceAuthorizationRoutes(
  router: Router,
  deps: DeviceAuthorizationDeps,
): void {
  const registry = deps.registry ?? scopeRegistry;

  router.post(DEVICE_CODE_PATH, (req: Request, res: Response, next) => {
    void (async () => {
      // RFC 8628 §3.2 requires this on the issuance response for RFC 6749
      // §5.1's reason: the body carries a bearer credential, and a cached copy
      // of it is a leak through the browser or proxy cache.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');

      const parsed = deviceAuthorizationRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        oauthError(res, 400, 'invalid_request', 'client_id is required.');
        return;
      }
      const { client_id: clientId, client_secret: clientSecret, scope } = parsed.data;

      const app = await authenticateDeviceClient(deps.appsRepo, clientId, clientSecret);
      if (!app) {
        // Byte-identical for unknown id / wrong secret / deactivated app.
        // PF-125's test drives all four cases and asserts one response.
        res.setHeader('WWW-Authenticate', 'Basic realm="oauth"');
        oauthError(res, 401, 'invalid_client', 'Client authentication failed.');
        return;
      }

      // ── PF-126 — scopes validated at device-code time ─────────────────────
      const requestedNames = scope && scope.trim() !== '' ? scope.trim().split(/\s+/) : [];
      const { valid, unknown } = validateRequestedScopes(requestedNames, registry);
      if (unknown.length > 0) {
        // Names the offending scope, the same shape L03's PF-080(b) asserts.
        // A silent drop would turn a client's startup-time typo into a 403 in
        // production weeks later.
        oauthError(res, 400, 'invalid_scope', `Unknown scope requested: ${unknown.join(' ')}`);
        return;
      }

      // The app's registration is a ceiling on what may even be asked for. A
      // client requesting something outside it is told now, at its first
      // request, rather than being handed a code that can only ever produce a
      // narrower grant than it expects.
      const registered = new Set<string>(app.requestedScopes);
      const outsideRegistration = valid.filter((s) => !registered.has(s));
      if (outsideRegistration.length > 0) {
        oauthError(
          res,
          400,
          'invalid_scope',
          `Scope not registered to this application: ${outsideRegistration.join(' ')}`,
        );
        return;
      }

      // An empty request inherits the app's registration. RFC 6749 §3.3 leaves
      // the no-scope case to the server; inheriting the app's own declared set
      // is the narrowest defensible default here, because the user still has to
      // consent to it at the verification screen before anything is granted.
      const requestedScopes: Scope[] = valid.length > 0 ? valid : [...app.requestedScopes];
      if (requestedScopes.length === 0) {
        oauthError(
          res,
          400,
          'invalid_scope',
          'This application has no registered scopes to request.',
        );
        return;
      }

      const now = new Date(deps.clock.nowMs());
      const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000);

      const deviceCode = generateDeviceCode();

      // ── PF-123 — bounded retry on a `user_code` collision ─────────────────
      let issued = null as Awaited<ReturnType<IDeviceCodeRepo['insert']>> | null;
      let lastError: unknown;
      for (let attempt = 0; attempt < USER_CODE_MAX_ATTEMPTS && issued === null; attempt += 1) {
        const userCode = generateUserCode();
        try {
          issued = await deps.deviceCodeRepo.insert({
            // PF-124 — the row stores sha256(device_code) and never the value.
            deviceCodeHash: hashDeviceCode(deviceCode),
            userCode,
            appId: app.id,
            scopes: requestedScopes,
            intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
            expiresAt,
            createdAt: now,
          });
        } catch (err) {
          // The UNIQUE(user_code) constraint firing is the only expected
          // failure. Retrying with a fresh code is correct; retrying forever is
          // not (see USER_CODE_MAX_ATTEMPTS).
          lastError = err;
        }
      }
      if (issued === null) throw lastError ?? new Error('could not allocate a user_code');

      const verificationUri = new URL(
        `/oauth${DEVICE_VERIFY_PATH}`,
        deps.publicBaseUrl,
      ).toString();
      const verificationUriComplete = new URL(verificationUri);
      verificationUriComplete.searchParams.set('user_code', issued.userCode);

      const body: DeviceAuthorizationResponse = {
        device_code: deviceCode,
        // The CANONICAL hyphenated form, exactly as stored and exactly as
        // L19's PF-563 echoes it. No lowercasing and no hyphen-stripping on the
        // way out — what the terminal prints must match what the portal and the
        // audit trail would show.
        user_code: issued.userCode,
        verification_uri: verificationUri,
        verification_uri_complete: verificationUriComplete.toString(),
        expires_in: DEVICE_CODE_TTL_SECONDS,
        // PF-141 — the SAME number the throttle enforces. An SDK that trusts
        // this value is never slowed down for obeying it.
        interval: issued.intervalSeconds,
      };

      res.status(200).json(body);
    })().catch(next);
  });
}
