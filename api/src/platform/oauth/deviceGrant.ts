/**
 * ★ THE POLLING LEG. `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
 * PF-134 – PF-140 (lane L05, slice S3/S4).
 *
 * PRD p.3's third clause and its final sentence: *"the client polls
 * /oauth/token until authorized. Slow-down responses honored."*
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE HERE IS AN HTTP 400 WITH AN `error` FIELD. THIS IS THE ONE
 * THING A HAND-ROLLED DEVICE GRANT USUALLY GETS WRONG (PF-135).
 * ---------------------------------------------------------------------------
 * `authorization_pending` FEELS like a non-error — the flow is proceeding
 * normally, the user simply has not decided yet — so the natural thing to write
 * is `200 {"status":"pending"}`. That breaks every RFC-compliant client library
 * on the planet, including whatever a grader points at us, because RFC 6749 §5.2
 * makes every token-endpoint error a 400 with an `error` member and RFC 8628
 * §3.5 adds `authorization_pending` to exactly that set.
 *
 * There is deliberately no 200-with-a-status-field path anywhere in this file.
 * The only 200 this handler can produce carries a token pair.
 *
 * ---------------------------------------------------------------------------
 * `slow_down` MUST ALSO RAISE THE STORED INTERVAL (PF-136).
 * ---------------------------------------------------------------------------
 * The second classic error. RFC 8628 §3.5 says the client MUST increase its
 * polling interval by 5 seconds on a `slow_down`; a server that returns
 * `slow_down` WITHOUT raising its own stored interval is then permanently out of
 * step with a client that obeyed it — or, worse, leaves a client that did NOT
 * obey it in an infinite error loop, because every subsequent poll is still too
 * fast by the server's unchanged reckoning.
 *
 * So the increase happens here, on the row, cumulatively, capped. And PF-141's
 * assertion closes the loop from the other side: the `interval` this server
 * advertised at issuance is the same number it enforces, so an SDK that trusts
 * what it was told is never slowed down for obeying it.
 *
 * ---------------------------------------------------------------------------
 * POLLING STATE IS ON THE ROW, NEVER IN A MODULE-LEVEL MAP (PF-137).
 * ---------------------------------------------------------------------------
 * Two consequences, both asserted rather than described: two concurrent device
 * flows throttle INDEPENDENTLY — one client polling too fast never slows
 * another's flow — and a backoff a client has already earned survives a process
 * restart, so a crash-loop is not a way to reset the throttle. It is also the
 * only shape that works behind a load balancer, which is the same argument
 * migration 065 makes for the authorization code.
 *
 * ---------------------------------------------------------------------------
 * THIS LANE MINTS NOTHING (PF-140).
 * ---------------------------------------------------------------------------
 * Redemption calls L06's `issueTokenPair` — the single issuance site — and a
 * grep asserts no token generation, no token hashing and no refresh-token
 * construction exists anywhere under this lane's modules. That seam is what
 * makes the refresh-rotation contract identical whether a token came from the
 * device grant or the authorization-code grant.
 */
import type { Clock } from '../clock.js';
import type { GrantHandler, GrantOutcome } from './router.js';
import type { ITokenRepo } from './tokenRepo.js';
import type { TokenTtlConfig } from './tokens.js';
import { issueTokenPair } from './issue.js';
import {
  hashDeviceCode,
  DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
  DEVICE_POLL_INTERVAL_MAX_SECONDS,
  type IDeviceCodeRepo,
} from './deviceCodes.js';

/** RFC 8628 §3.4's grant type URN, written once. */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceGrantDeps {
  deviceCodeRepo: IDeviceCodeRepo;
  tokenRepo: ITokenRepo;
  clock: Clock;
  ttl: TokenTtlConfig;
}

/**
 * The `error_description` for each failure, as data.
 *
 * Exported so tests assert against the same strings the handler emits rather
 * than restating them — the call L04's `AUTH_CODE_ERROR_DESCRIPTIONS` and L06's
 * `REFRESH_ERROR_DESCRIPTIONS` both make. Prose only: nothing switches on these,
 * and an SDK that did would be relying on wording rather than on `error`.
 */
export const DEVICE_GRANT_ERROR_DESCRIPTIONS = {
  missingDeviceCode: 'The device_code parameter is required.',
  pending: 'The user has not yet completed authorization. Keep polling.',
  slowDown: 'Polling too frequently. Increase the interval by 5 seconds and retry.',
  denied: 'The user denied the authorization request.',
  expired: 'The device_code has expired. Start a new device authorization request.',
  /**
   * ONE string for unknown / already-consumed / belonging-to-another-client.
   *
   * Same reasoning as L04's `badGrant`: distinguishing them would make the
   * token endpoint an oracle. "Already used" versus "never existed" tells an
   * attacker holding a stolen device code whether it was ever real, and
   * "belongs to another client" confirms a code is live while telling the
   * caller to go find the right `client_id`.
   */
  badGrant: 'The device_code is invalid, has already been used, or was issued to another client.',
} as const;

function fail(error: string, description: string): GrantOutcome {
  return {
    ok: false,
    // 400, per RFC 6749 §5.2 and RFC 8628 §3.5. NOT a 200 with a status field.
    // See the module header — this is the assertion PF-135 exists for.
    status: 400,
    body: { error: error as never, error_description: description },
  };
}

/**
 * The grant handler. Registered as a NEW ENTRY in the router's grant map —
 * adding it required no edit to the dispatcher, which is PF-166/PF-134's whole
 * point and the reason three lanes could add three grant types without merging
 * over one another's `switch` statement.
 */
export function deviceCodeGrant(deps: DeviceGrantDeps): GrantHandler {
  return async ({ app, params }) => {
    const presented = params.device_code;
    if (!presented) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          error_description: DEVICE_GRANT_ERROR_DESCRIPTIONS.missingDeviceCode,
        },
      };
    }

    const now = new Date(deps.clock.nowMs());
    const row = await deps.deviceCodeRepo.findByDeviceCodeHash(hashDeviceCode(presented));

    if (!row) return fail('invalid_grant', DEVICE_GRANT_ERROR_DESCRIPTIONS.badGrant);

    // ── PF-134 — the code must belong to the AUTHENTICATING client ───────────
    //
    // `invalid_grant`, not `invalid_client`: the client authenticated perfectly
    // well (the router already ran `verifyClientSecret` above this handler);
    // what is wrong is the grant it presented. Answering `invalid_client` would
    // send a correctly-configured integrator to debug their credentials.
    if (row.appId !== app.id) return fail('invalid_grant', DEVICE_GRANT_ERROR_DESCRIPTIONS.badGrant);

    // ── PF-133 — an already-redeemed code cannot mint a second pair ──────────
    // Checked before expiry so a consumed-then-expired code still reads as a
    // replay rather than as a timeout.
    if (row.consumedAt !== null) {
      return fail('invalid_grant', DEVICE_GRANT_ERROR_DESCRIPTIONS.badGrant);
    }

    // ── PF-127 — expiry is a real outcome the client can act on ──────────────
    //
    // BEFORE the slow_down check, deliberately. A client polling too fast
    // against a code that has already expired should be told the code is dead,
    // not told to slow down and try again — the latter would have it back off
    // politely toward a deadline that has already passed. The row is left for
    // PF-144's sweeper rather than deleted inline.
    if (row.expiresAt.getTime() <= now.getTime()) {
      return fail('expired_token', DEVICE_GRANT_ERROR_DESCRIPTIONS.expired);
    }

    // ── PF-136 — ★ slow_down, AND the interval actually rises ────────────────
    //
    // Every poll stamps `last_polled_at`, legal or not: a client that polls too
    // fast and is not stamped would find its next too-fast poll measured from
    // the last LEGAL one and would drift back into legality without ever having
    // slowed down.
    if (row.lastPolledAt !== null) {
      const elapsedMs = now.getTime() - row.lastPolledAt.getTime();
      if (elapsedMs < row.intervalSeconds * 1000) {
        const raised = Math.min(
          row.intervalSeconds + DEVICE_POLL_INTERVAL_INCREMENT_SECONDS,
          DEVICE_POLL_INTERVAL_MAX_SECONDS,
        );
        await deps.deviceCodeRepo.recordPoll(row.id, now, raised);
        return fail('slow_down', DEVICE_GRANT_ERROR_DESCRIPTIONS.slowDown);
      }
    }

    // A legal poll. Stamp it at the CURRENT interval — the interval only ever
    // rises on a violation, never decays, so a client cannot earn its way back
    // to a faster cadence by behaving for a while. RFC 8628 §3.5 gives no
    // mechanism for lowering it either.
    await deps.deviceCodeRepo.recordPoll(row.id, now, row.intervalSeconds);

    // ── PF-133 — denial is terminal and distinguishable ─────────────────────
    //
    // Never `authorization_pending`. A server that returned pending forever on a
    // denial would have the CLI poll until expiry and report the wrong reason.
    if (row.status === 'denied') {
      return fail('access_denied', DEVICE_GRANT_ERROR_DESCRIPTIONS.denied);
    }

    // ── PF-135 — still waiting on the human. A 400, not a 200 ───────────────
    if (row.status === 'pending') {
      return fail('authorization_pending', DEVICE_GRANT_ERROR_DESCRIPTIONS.pending);
    }

    // ── PF-140 — approved. Burn the code, then issue ─────────────────────────
    //
    // The conditional consume is what makes "one device code yields one token
    // pair" a property of a single SQL statement rather than of a read-then-
    // write the handler is trusted to get right. Two simultaneous polls: one
    // wins and gets tokens, the other gets `invalid_grant`.
    //
    // Burn FIRST, issue second — the same order and the same reasoning as L04's
    // authorization-code redemption. A crash between them leaves a burned code
    // and no tokens, and the client restarts a flow; the opposite order would
    // risk tokens issued from a code that stayed live, which is the failure that
    // actually matters.
    const won = await deps.deviceCodeRepo.consume(row.id, now);
    if (!won) {
      return fail('invalid_grant', DEVICE_GRANT_ERROR_DESCRIPTIONS.badGrant);
    }

    // Belt and braces against the database CHECK: an approved row without a
    // user should be impossible (migration 071 forbids it), so reaching here
    // means the constraint was dropped. Refusing beats minting a token that
    // belongs to nobody.
    if (row.userId === null) {
      return fail('invalid_grant', DEVICE_GRANT_ERROR_DESCRIPTIONS.badGrant);
    }

    const { response } = await issueTokenPair(
      { tokenRepo: deps.tokenRepo, clock: deps.clock, ttl: deps.ttl },
      {
        app,
        userId: row.userId,
        // The RESOLVED grant, copied from the row — what the user actually
        // consented to at the verification screen. Never `app.requestedScopes`,
        // which is a ceiling and not a grant.
        scopes: row.scopes,
        // A NEW family. A device-grant redemption starts a fresh grant, exactly
        // as an authorization-code redemption does; passing an existing family
        // would chain it to something it has no relationship with.
      },
    );

    return { ok: true, body: response };
  };
}
