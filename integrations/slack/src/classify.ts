/**
 * PF-744 — Slack being down must not corrupt Ship's retry semantics.
 *
 * **This is a DECISION, and it is ours.** Pre-Search 2.3 (p.16) asks the
 * question from the platform's side — is 4xx always permanent, or is the answer
 * more nuanced — and L16 answered it there (D9: 408/425/429 transient, other
 * 4xx permanent). This is the SUBSCRIBER's side of the same answer, and it is
 * the only place in the plan where a real subscriber makes the call.
 *
 * ── Why the subscriber classifies its own upstream ────────────────────────
 * Ship cannot tell a transient Slack outage from a permanent misconfiguration:
 * both look like "the subscriber returned an error". Only this process knows
 * that `channel_not_found` means a human deleted a channel and no number of
 * retries will bring it back, while a Slack 500 means try again in a second.
 *
 * So the mapping is:
 *
 *   Slack 5xx / network       → **5xx** to Ship. Retry on the ladder.
 *   `channel_not_found`,
 *   `not_in_channel`,
 *   `is_archived`,
 *   `invalid_auth`,
 *   `account_inactive`        → **4xx** to Ship. Dead-letter immediately rather
 *                               than burning six attempts on a channel or a
 *                               token that is not coming back.
 *   `ratelimited`             → **5xx**. Slack rate-limiting US is exactly the
 *                               failure a sender must not be dead-lettered for,
 *                               and it is D9's own example from the other side.
 *
 * It stays correct under either resolution of D9, because it chooses which
 * status to RETURN rather than how to interpret one.
 */

/** Slack `error` strings that will never fix themselves. */
export const PERMANENT_SLACK_ERRORS = [
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'invalid_arguments',
  'msg_too_long',
] as const;

/** Slack `error` strings that are worth another attempt. */
export const TRANSIENT_SLACK_ERRORS = [
  'ratelimited',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
] as const;

export interface SlackFailure {
  /** Slack's `error` field, when the call reached Slack and it answered. */
  slackError?: string | null;
  /** The HTTP status, when there was one. */
  status?: number | null;
}

export interface UpstreamDecision {
  /** What this listener answers Ship. */
  status: number;
  /** Named so the response body and the log say the same word. */
  disposition: 'transient' | 'permanent';
  reason: string;
}

/**
 * 502 for transient, 422 for permanent.
 *
 * 502 says "my upstream failed", which is what happened, and it is a 5xx so L16
 * retries. 422 is a permanent 4xx under D9 that is not 401 — 401 is reserved
 * here for a signature that did not verify, and conflating "your signature is
 * wrong" with "my Slack channel is gone" would send a developer to the wrong
 * half of the problem.
 */
export const TRANSIENT_STATUS = 502;
export const PERMANENT_STATUS = 422;

export function classifyUpstream(failure: SlackFailure): UpstreamDecision {
  const error = failure.slackError ?? null;

  if (error !== null && (PERMANENT_SLACK_ERRORS as readonly string[]).includes(error)) {
    return {
      status: PERMANENT_STATUS,
      disposition: 'permanent',
      reason: `slack:${error} — a human has to fix this; retrying cannot`,
    };
  }

  if (error !== null && (TRANSIENT_SLACK_ERRORS as readonly string[]).includes(error)) {
    return { status: TRANSIENT_STATUS, disposition: 'transient', reason: `slack:${error}` };
  }

  const status = failure.status ?? null;
  if (status !== null && status >= 500) {
    return { status: TRANSIENT_STATUS, disposition: 'transient', reason: `slack http ${status}` };
  }

  // Anything unrecognised — including a network error with no status at all — is
  // TRANSIENT. The two failure modes are not symmetric: retrying something
  // permanent costs six attempts, while dead-lettering something transient
  // loses the message. Losing is worse, so the unknown case retries.
  return {
    status: TRANSIENT_STATUS,
    disposition: 'transient',
    reason: error !== null ? `slack:${error} (unrecognised)` : `unrecognised upstream failure`,
  };
}
